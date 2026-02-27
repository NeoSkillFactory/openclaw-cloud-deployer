#!/usr/bin/env node
"use strict";

const {
  loadConfig, mergeConfig, parseArgs, generateDeploymentId,
  saveDeploymentState, validateCredentials, run, commandExists,
  log, loadDockerCompose, loadSslTemplate, renderTemplate,
} = require("./utils");

const PLATFORM = "digitalocean";

/**
 * Validates that doctl is installed and credentials are configured.
 */
function preflight(dryRun) {
  log.info("Running pre-flight checks for DigitalOcean...");

  if (!dryRun) {
    if (!commandExists("doctl")) {
      throw new Error("DigitalOcean CLI (doctl) is not installed. Install it: https://docs.digitalocean.com/reference/doctl/how-to/install/");
    }

    const creds = validateCredentials(PLATFORM);
    if (!creds.valid) {
      throw new Error(`Missing DigitalOcean credentials: ${creds.missing.join(", ")}. Set DIGITALOCEAN_TOKEN as an environment variable.`);
    }

    try {
      run("doctl account get --output json");
      log.success("DigitalOcean credentials verified.");
    } catch (err) {
      throw new Error(`DigitalOcean credential verification failed: ${err.message}`);
    }
  } else {
    log.info("Dry-run mode — skipping credential verification.");
  }
}

/**
 * Creates a firewall for the droplet.
 */
function ensureFirewall(config, dropletId, dryRun) {
  const fw = config.network;
  log.info(`Ensuring firewall: ${fw.firewallName}`);

  if (dryRun) {
    log.info(`[dry-run] Would create firewall "${fw.firewallName}" with ${fw.inboundRules.length} rules.`);
    return "fw-dry-run-placeholder";
  }

  // Build inbound rules argument
  const rulesArg = fw.inboundRules
    .map((r) => `protocol:${r.protocol},ports:${r.ports},address:${r.sources}`)
    .join(" ");

  try {
    const existing = JSON.parse(run(`doctl compute firewall list --output json`));
    const found = existing.find((f) => f.name === fw.firewallName);
    if (found) {
      log.info(`Firewall already exists: ${found.id}`);
      // Add droplet to firewall
      run(`doctl compute firewall add-droplets ${found.id} --droplet-ids ${dropletId}`);
      return found.id;
    }
  } catch {
    // No existing firewalls or list failed
  }

  const createResult = JSON.parse(run([
    "doctl compute firewall create",
    `--name ${fw.firewallName}`,
    `--droplet-ids ${dropletId}`,
    `--inbound-rules "${rulesArg}"`,
    '--outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,::/0 protocol:udp,ports:all,address:0.0.0.0/0,::/0"',
    "--output json",
  ].join(" ")));

  const fwId = createResult[0]?.id || "unknown";
  log.success(`Created firewall: ${fwId}`);
  return fwId;
}

/**
 * Creates a droplet with Docker pre-installed and deploys the agent.
 */
function launchDroplet(config, dryRun) {
  const droplet = config.droplet;
  const region = config.region;

  log.info(`Creating droplet (${droplet.size}) in ${region}...`);

  if (dryRun) {
    log.info(`[dry-run] Would create droplet: size=${droplet.size}, image=${droplet.image}, region=${region}`);
    return { dropletId: "droplet-dry-run", dropletName: "openclaw-agent-dry-run", publicIp: "0.0.0.0" };
  }

  const dropletName = `openclaw-agent-${Date.now()}`;
  const userData = [
    "#!/bin/bash",
    "set -e",
    "which docker || (curl -fsSL https://get.docker.com | sh)",
    "systemctl start docker && systemctl enable docker",
    `docker pull ${config.container.image}`,
    `docker run -d --name openclaw-agent --restart unless-stopped -p ${config.container.port}:8080 ${config.container.image}`,
  ].join("\n");

  const tagsArg = droplet.tags.join(",");
  const createResult = JSON.parse(run([
    "doctl compute droplet create", dropletName,
    `--region ${region}`,
    `--size ${droplet.size}`,
    `--image ${droplet.image}`,
    `--tag-names ${tagsArg}`,
    droplet.monitoring ? "--enable-monitoring" : "",
    droplet.ipv6 ? "--enable-ipv6" : "",
    droplet.backups ? "--enable-backups" : "",
    `--user-data '${userData}'`,
    "--wait",
    "--output json",
  ].filter(Boolean).join(" ")));

  const dropletId = createResult[0]?.id || "unknown";
  const publicIp = createResult[0]?.networks?.v4?.find((n) => n.type === "public")?.ip_address || "pending";

  log.success(`Droplet created: ${dropletName} (ID: ${dropletId})`);
  log.success(`Public IP: ${publicIp}`);

  return { dropletId, dropletName, publicIp };
}

/**
 * Configures SSL via Let's Encrypt if enabled.
 */
function configureSSL(config, publicIp, dryRun) {
  if (!config.ssl.enabled) {
    log.info("SSL is disabled in configuration, skipping.");
    return null;
  }

  log.info("Configuring SSL via Let's Encrypt...");

  if (dryRun) {
    log.info("[dry-run] Would provision Let's Encrypt certificate via certbot.");
    return "ssl-cert-dry-run";
  }

  const sslTemplate = loadSslTemplate();
  log.info("SSL template loaded. Let's Encrypt certificate will be provisioned on domain assignment.");
  log.info("Run certbot on the droplet after DNS is configured.");
  return "pending-domain-assignment";
}

/**
 * Configures load balancer for scaling if enabled.
 */
function configureScaling(config, dropletId, dryRun) {
  if (!config.scaling.enabled) {
    log.info("Auto-scaling is disabled in configuration.");
    return null;
  }

  log.info("Configuring DigitalOcean load balancer for scaling...");

  if (dryRun) {
    log.info(`[dry-run] Would create load balancer: min=${config.scaling.minDroplets}, max=${config.scaling.maxDroplets}`);
    return { lbName: "openclaw-lb-dry-run" };
  }

  const lbName = `openclaw-lb-${Date.now()}`;
  log.info(`Load balancer "${lbName}" would be created.`);
  return { lbName };
}

/**
 * Main deployment pipeline for DigitalOcean.
 */
async function deploy(overrides = {}) {
  const startTime = Date.now();
  const args = parseArgs(process.argv);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  log.info("=== OpenClaw Cloud Deployer — DigitalOcean ===");
  if (dryRun) log.warn("Running in DRY-RUN mode. No cloud resources will be created.");

  const baseConfig = loadConfig(PLATFORM);
  const config = mergeConfig(baseConfig, {
    ...overrides,
    region: args.region || overrides.region || baseConfig.region,
  });

  log.info(`Region: ${config.region}`);
  log.info(`Droplet size: ${config.droplet.size}`);

  preflight(dryRun);

  const { dropletId, dropletName, publicIp } = launchDroplet(config, dryRun);
  const fwId = ensureFirewall(config, dropletId, dryRun);
  const sslCert = configureSSL(config, publicIp, dryRun);
  const scalingResult = configureScaling(config, dropletId, dryRun);

  const deploymentId = generateDeploymentId(PLATFORM);
  const state = {
    deploymentId,
    platform: PLATFORM,
    region: config.region,
    dropletId,
    dropletName,
    publicIp,
    firewallId: fwId,
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
  log.info(`Droplet:         ${dropletName} (ID: ${dropletId})`);
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
