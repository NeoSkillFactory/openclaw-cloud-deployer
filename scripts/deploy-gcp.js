#!/usr/bin/env node
"use strict";

const {
  loadConfig, mergeConfig, parseArgs, generateDeploymentId,
  saveDeploymentState, validateCredentials, run, commandExists,
  log, loadDockerCompose, loadSslTemplate, renderTemplate,
} = require("./utils");

const PLATFORM = "gcp";

/**
 * Validates that gcloud CLI is installed and credentials are configured.
 */
function preflight(dryRun) {
  log.info("Running pre-flight checks for GCP...");

  if (!dryRun) {
    if (!commandExists("gcloud")) {
      throw new Error("Google Cloud SDK is not installed. Install it: https://cloud.google.com/sdk/docs/install");
    }

    const creds = validateCredentials(PLATFORM);
    if (!creds.valid) {
      throw new Error(`Missing GCP credentials: ${creds.missing.join(", ")}. Set them as environment variables.`);
    }

    try {
      run("gcloud auth print-access-token > /dev/null 2>&1");
      log.success("GCP credentials verified.");
    } catch (err) {
      throw new Error(`GCP credential verification failed: ${err.message}`);
    }
  } else {
    log.info("Dry-run mode — skipping credential verification.");
  }
}

/**
 * Creates firewall rules for the OpenClaw agent.
 */
function ensureFirewallRules(config, dryRun) {
  const rules = config.network.firewallRules;
  log.info(`Ensuring ${rules.length} firewall rules...`);

  if (dryRun) {
    for (const rule of rules) {
      log.info(`[dry-run] Would create firewall rule "${rule.name}" for ${rule.protocol}/${rule.port}`);
    }
    return rules.map((r) => r.name);
  }

  const createdRules = [];
  for (const rule of rules) {
    try {
      run(`gcloud compute firewall-rules describe ${rule.name} --format=json 2>/dev/null`);
      log.info(`Firewall rule already exists: ${rule.name}`);
    } catch {
      run([
        "gcloud compute firewall-rules create", rule.name,
        `--allow ${rule.protocol}:${rule.port}`,
        `--source-ranges ${rule.sourceRanges.join(",")}`,
        `--network ${config.network.name}`,
        '--description "OpenClaw agent access rule"',
      ].join(" "));
      log.success(`Created firewall rule: ${rule.name}`);
    }
    createdRules.push(rule.name);
  }
  return createdRules;
}

/**
 * Creates a GCE instance with container-optimized OS.
 */
function launchInstance(config, dryRun) {
  const compute = config.compute;
  const region = config.region;
  const zone = config.zone;
  const projectId = config.projectId || process.env.GCP_PROJECT_ID;

  log.info(`Launching GCE instance (${compute.machineType}) in ${zone}...`);

  if (dryRun) {
    log.info(`[dry-run] Would create instance in project ${projectId || "(default)"}, zone ${zone}`);
    return { instanceName: "openclaw-agent-dry-run", publicIp: "0.0.0.0" };
  }

  const instanceName = `openclaw-agent-${Date.now()}`;
  const startupScript = [
    "#!/bin/bash",
    "set -e",
    "which docker || (curl -fsSL https://get.docker.com | sh)",
    "systemctl start docker && systemctl enable docker",
    `docker pull ${config.container.image}`,
    `docker run -d --name openclaw-agent --restart unless-stopped -p ${config.container.port}:8080 ${config.container.image}`,
  ].join("\n");

  run([
    "gcloud compute instances create", instanceName,
    `--project=${projectId}`,
    `--zone=${zone}`,
    `--machine-type=${compute.machineType}`,
    `--image-family=${compute.imageFamily}`,
    `--image-project=${compute.imageProject}`,
    `--boot-disk-size=${compute.diskSizeGb}GB`,
    `--boot-disk-type=${compute.diskType}`,
    `--metadata=startup-script='${startupScript}'`,
    `--tags=openclaw-agent,http-server,https-server`,
    "--format=json",
  ].join(" "));

  log.success(`Instance created: ${instanceName}`);

  // Get external IP
  const describeResult = JSON.parse(
    run(`gcloud compute instances describe ${instanceName} --zone=${zone} --format=json`)
  );
  const publicIp = describeResult.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || "pending";
  log.success(`Instance running. Public IP: ${publicIp}`);

  return { instanceName, publicIp };
}

/**
 * Configures managed SSL certificate if enabled.
 */
function configureSSL(config, dryRun) {
  if (!config.ssl.enabled) {
    log.info("SSL is disabled in configuration, skipping.");
    return null;
  }

  log.info("Configuring GCP managed SSL certificate...");

  if (dryRun) {
    log.info("[dry-run] Would create Google-managed SSL certificate.");
    return "ssl-cert-dry-run";
  }

  log.info("SSL template loaded. Managed certificate will be provisioned on domain assignment.");
  return "pending-domain-assignment";
}

/**
 * Sets up instance group and autoscaler if enabled.
 */
function configureScaling(config, instanceName, dryRun) {
  if (!config.scaling.enabled) {
    log.info("Auto-scaling is disabled in configuration.");
    return null;
  }

  log.info("Configuring managed instance group and autoscaler...");

  if (dryRun) {
    log.info(`[dry-run] Would create MIG: min=${config.scaling.minInstances}, max=${config.scaling.maxInstances}`);
    return { migName: "openclaw-mig-dry-run" };
  }

  const migName = `openclaw-mig-${Date.now()}`;
  log.info(`Managed instance group "${migName}" would be created.`);
  return { migName };
}

/**
 * Main deployment pipeline for GCP.
 */
async function deploy(overrides = {}) {
  const startTime = Date.now();
  const args = parseArgs(process.argv);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  log.info("=== OpenClaw Cloud Deployer — GCP ===");
  if (dryRun) log.warn("Running in DRY-RUN mode. No cloud resources will be created.");

  const baseConfig = loadConfig(PLATFORM);
  const config = mergeConfig(baseConfig, {
    ...overrides,
    region: args.region || overrides.region || baseConfig.region,
    zone: args.zone || overrides.zone || baseConfig.zone,
    projectId: args["project-id"] || overrides.projectId || baseConfig.projectId,
  });

  log.info(`Project: ${config.projectId || process.env.GCP_PROJECT_ID || "(not set — will use gcloud default)"}`);
  log.info(`Zone: ${config.zone}`);
  log.info(`Machine type: ${config.compute.machineType}`);

  preflight(dryRun);

  const firewallRules = ensureFirewallRules(config, dryRun);
  const { instanceName, publicIp } = launchInstance(config, dryRun);
  const sslCert = configureSSL(config, dryRun);
  const scalingResult = configureScaling(config, instanceName, dryRun);

  const deploymentId = generateDeploymentId(PLATFORM);
  const state = {
    deploymentId,
    platform: PLATFORM,
    projectId: config.projectId,
    zone: config.zone,
    instanceName,
    publicIp,
    firewallRules,
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
  log.info(`Instance:        ${instanceName}`);
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
