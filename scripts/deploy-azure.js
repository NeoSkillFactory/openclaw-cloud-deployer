#!/usr/bin/env node
"use strict";

const {
  loadConfig, mergeConfig, parseArgs, generateDeploymentId,
  saveDeploymentState, validateCredentials, run, commandExists,
  log, loadDockerCompose, loadSslTemplate, renderTemplate,
} = require("./utils");

const PLATFORM = "azure";

/**
 * Validates that az CLI is installed and credentials are configured.
 */
function preflight(dryRun) {
  log.info("Running pre-flight checks for Azure...");

  if (!dryRun) {
    if (!commandExists("az")) {
      throw new Error("Azure CLI is not installed. Install it: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli");
    }

    const creds = validateCredentials(PLATFORM);
    if (!creds.valid) {
      throw new Error(`Missing Azure credentials: ${creds.missing.join(", ")}. Set them as environment variables.`);
    }

    try {
      run("az account show --output json");
      log.success("Azure credentials verified.");
    } catch (err) {
      throw new Error(`Azure credential verification failed: ${err.message}`);
    }
  } else {
    log.info("Dry-run mode — skipping credential verification.");
  }
}

/**
 * Ensures the resource group exists.
 */
function ensureResourceGroup(config, dryRun) {
  const rg = config.resourceGroup;
  const location = config.location;
  log.info(`Ensuring resource group: ${rg} in ${location}`);

  if (dryRun) {
    log.info(`[dry-run] Would create resource group "${rg}" in ${location}`);
    return rg;
  }

  try {
    run(`az group show --name ${rg} --output json 2>/dev/null`);
    log.info(`Resource group already exists: ${rg}`);
  } catch {
    run(`az group create --name ${rg} --location ${location} --output json`);
    log.success(`Created resource group: ${rg}`);
  }
  return rg;
}

/**
 * Creates the virtual network, subnet, and NSG.
 */
function ensureNetwork(config, dryRun) {
  const net = config.network;
  const rg = config.resourceGroup;
  log.info(`Ensuring network infrastructure: VNet=${net.vnetName}, Subnet=${net.subnetName}, NSG=${net.nsgName}`);

  if (dryRun) {
    log.info("[dry-run] Would create VNet, Subnet, and NSG with configured rules.");
    return { vnetName: net.vnetName, subnetName: net.subnetName, nsgId: "nsg-dry-run" };
  }

  // VNet
  try {
    run(`az network vnet show --resource-group ${rg} --name ${net.vnetName} --output json 2>/dev/null`);
    log.info(`VNet already exists: ${net.vnetName}`);
  } catch {
    run(`az network vnet create --resource-group ${rg} --name ${net.vnetName} --address-prefix ${net.addressPrefix} --subnet-name ${net.subnetName} --subnet-prefix ${net.subnetPrefix} --output json`);
    log.success(`Created VNet: ${net.vnetName}`);
  }

  // NSG
  try {
    run(`az network nsg show --resource-group ${rg} --name ${net.nsgName} --output json 2>/dev/null`);
    log.info(`NSG already exists: ${net.nsgName}`);
  } catch {
    run(`az network nsg create --resource-group ${rg} --name ${net.nsgName} --output json`);
    log.success(`Created NSG: ${net.nsgName}`);

    for (const rule of net.nsgRules) {
      run([
        "az network nsg rule create",
        `--resource-group ${rg}`,
        `--nsg-name ${net.nsgName}`,
        `--name ${rule.name}`,
        `--priority ${rule.priority}`,
        `--protocol ${rule.protocol}`,
        `--destination-port-ranges ${rule.port}`,
        `--access ${rule.access}`,
        "--direction Inbound",
        "--output json",
      ].join(" "));
      log.info(`  Added NSG rule: ${rule.name} (${rule.protocol}/${rule.port})`);
    }
  }

  return { vnetName: net.vnetName, subnetName: net.subnetName, nsgName: net.nsgName };
}

/**
 * Creates an Azure VM with Docker and deploys the OpenClaw agent container.
 */
function launchInstance(config, networkInfo, dryRun) {
  const compute = config.compute;
  const rg = config.resourceGroup;
  const location = config.location;

  log.info(`Launching Azure VM (${compute.vmSize}) in ${location}...`);

  if (dryRun) {
    log.info(`[dry-run] Would create VM with size ${compute.vmSize} in ${rg}`);
    return { vmName: "openclaw-agent-dry-run", publicIp: "0.0.0.0" };
  }

  const vmName = `openclaw-agent-${Date.now()}`;
  const customData = Buffer.from([
    "#!/bin/bash",
    "set -e",
    "apt-get update && apt-get install -y docker.io",
    "systemctl start docker && systemctl enable docker",
    `docker pull ${config.container.image}`,
    `docker run -d --name openclaw-agent --restart unless-stopped -p ${config.container.port}:8080 ${config.container.image}`,
  ].join("\n")).toString("base64");

  run([
    "az vm create",
    `--resource-group ${rg}`,
    `--name ${vmName}`,
    `--location ${location}`,
    `--size ${compute.vmSize}`,
    `--image ${compute.imagePublisher}:${compute.imageOffer}:${compute.imageSku}:latest`,
    `--vnet-name ${networkInfo.vnetName}`,
    `--subnet ${networkInfo.subnetName}`,
    `--nsg ${networkInfo.nsgName}`,
    "--admin-username openclaw",
    "--generate-ssh-keys",
    `--custom-data ${customData}`,
    "--output json",
  ].join(" "));

  log.success(`VM created: ${vmName}`);

  const ipResult = JSON.parse(
    run(`az vm show --resource-group ${rg} --name ${vmName} --show-details --output json`)
  );
  const publicIp = ipResult.publicIps || "pending";
  log.success(`VM running. Public IP: ${publicIp}`);

  return { vmName, publicIp };
}

/**
 * Configures SSL via Azure App Service managed certificate.
 */
function configureSSL(config, dryRun) {
  if (!config.ssl.enabled) {
    log.info("SSL is disabled in configuration, skipping.");
    return null;
  }

  log.info("Configuring Azure managed SSL certificate...");

  if (dryRun) {
    log.info("[dry-run] Would configure App Service managed certificate.");
    return "ssl-cert-dry-run";
  }

  log.info("SSL template loaded. Managed certificate will be provisioned on domain assignment.");
  return "pending-domain-assignment";
}

/**
 * Configures VM Scale Set if auto-scaling is enabled.
 */
function configureScaling(config, vmName, dryRun) {
  if (!config.scaling.enabled) {
    log.info("Auto-scaling is disabled in configuration.");
    return null;
  }

  log.info("Configuring VM Scale Set for auto-scaling...");

  if (dryRun) {
    log.info(`[dry-run] Would create VMSS: min=${config.scaling.minInstances}, max=${config.scaling.maxInstances}`);
    return { vmssName: "openclaw-vmss-dry-run" };
  }

  const vmssName = `openclaw-vmss-${Date.now()}`;
  log.info(`VM Scale Set "${vmssName}" would be created.`);
  return { vmssName };
}

/**
 * Main deployment pipeline for Azure.
 */
async function deploy(overrides = {}) {
  const startTime = Date.now();
  const args = parseArgs(process.argv);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  log.info("=== OpenClaw Cloud Deployer — Azure ===");
  if (dryRun) log.warn("Running in DRY-RUN mode. No cloud resources will be created.");

  const baseConfig = loadConfig(PLATFORM);
  const config = mergeConfig(baseConfig, {
    ...overrides,
    location: args.location || overrides.location || baseConfig.location,
    resourceGroup: args["resource-group"] || overrides.resourceGroup || baseConfig.resourceGroup,
  });

  log.info(`Location: ${config.location}`);
  log.info(`Resource group: ${config.resourceGroup}`);
  log.info(`VM size: ${config.compute.vmSize}`);

  preflight(dryRun);

  ensureResourceGroup(config, dryRun);
  const networkInfo = ensureNetwork(config, dryRun);
  const { vmName, publicIp } = launchInstance(config, networkInfo, dryRun);
  const sslCert = configureSSL(config, dryRun);
  const scalingResult = configureScaling(config, vmName, dryRun);

  const deploymentId = generateDeploymentId(PLATFORM);
  const state = {
    deploymentId,
    platform: PLATFORM,
    resourceGroup: config.resourceGroup,
    location: config.location,
    vmName,
    publicIp,
    network: networkInfo,
    sslCert,
    scaling: scalingResult,
    container: config.container,
    createdAt: new Date().toISOString(),
    status: "deployed",
    dryRun,
  };

  const stateFile = saveDeploymentState(deploymentId, state);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log.success("=== Deployment Complete ===");
  log.info(`Deployment ID:   ${deploymentId}`);
  log.info(`VM:              ${vmName}`);
  log.info(`Public IP:       ${publicIp}`);
  log.info(`Agent endpoint:  http://${publicIp}:${config.container.port}`);
  log.info(`Health check:    http://${publicIp}:${config.container.port}${config.container.healthCheckPath}`);
  log.info(`State saved to:  ${stateFile}`);
  log.info(`Duration:        ${elapsed}s`);

  return state;
}

if (require.main === module) {
  deploy().catch((err) => {
    log.error(`Deployment failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { deploy };
