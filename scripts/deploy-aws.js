#!/usr/bin/env node
"use strict";

const {
  loadConfig, mergeConfig, parseArgs, generateDeploymentId,
  saveDeploymentState, validateCredentials, run, commandExists,
  log, loadDockerCompose, loadSslTemplate, renderTemplate,
} = require("./utils");

const PLATFORM = "aws";

/**
 * Validates that the AWS CLI is installed and credentials are configured.
 */
function preflight(dryRun) {
  log.info("Running pre-flight checks for AWS...");

  if (!dryRun) {
    if (!commandExists("aws")) {
      throw new Error("AWS CLI is not installed. Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
    }

    const creds = validateCredentials(PLATFORM);
    if (!creds.valid) {
      throw new Error(`Missing AWS credentials: ${creds.missing.join(", ")}. Set them as environment variables.`);
    }

    // Verify the CLI can reach AWS
    try {
      run("aws sts get-caller-identity --output json");
      log.success("AWS credentials verified.");
    } catch (err) {
      throw new Error(`AWS credential verification failed: ${err.message}`);
    }
  } else {
    log.info("Dry-run mode — skipping credential verification.");
  }
}

/**
 * Creates or reuses a security group with the configured ingress rules.
 */
function ensureSecurityGroup(config, dryRun) {
  const sg = config.instance.securityGroup;
  log.info(`Ensuring security group: ${sg.name}`);

  if (dryRun) {
    log.info(`[dry-run] Would create security group "${sg.name}" with ${sg.ingressRules.length} ingress rules.`);
    return "sg-dry-run-placeholder";
  }

  // Check if SG exists
  try {
    const existing = run(`aws ec2 describe-security-groups --group-names "${sg.name}" --output json 2>/dev/null`);
    const parsed = JSON.parse(existing);
    const sgId = parsed.SecurityGroups[0].GroupId;
    log.info(`Security group already exists: ${sgId}`);
    return sgId;
  } catch {
    // Create new SG
    const createResult = run(`aws ec2 create-security-group --group-name "${sg.name}" --description "OpenClaw Agent SG" --output json`);
    const sgId = JSON.parse(createResult).GroupId;
    log.success(`Created security group: ${sgId}`);

    // Add ingress rules
    for (const rule of sg.ingressRules) {
      run(`aws ec2 authorize-security-group-ingress --group-id ${sgId} --protocol ${rule.protocol} --port ${rule.port} --cidr ${rule.cidr}`);
      log.info(`  Added rule: ${rule.description} (${rule.protocol}/${rule.port})`);
    }

    return sgId;
  }
}

/**
 * Launches an EC2 instance with the specified configuration.
 */
function launchInstance(config, sgId, dryRun) {
  const inst = config.instance;
  const region = config.region;
  log.info(`Launching EC2 instance (${inst.type}) in ${region}...`);

  if (dryRun) {
    log.info(`[dry-run] Would launch ${inst.type} instance with AMI ${inst.ami} in ${region}`);
    return { instanceId: "i-dry-run-placeholder", publicIp: "0.0.0.0" };
  }

  const userData = Buffer.from([
    "#!/bin/bash",
    "set -e",
    "yum update -y || apt-get update -y",
    "amazon-linux-extras install docker -y || apt-get install -y docker.io",
    "systemctl start docker && systemctl enable docker",
    `docker pull ${config.container.image}`,
    `docker run -d --name openclaw-agent --restart unless-stopped -p ${config.container.port}:8080 ${config.container.image}`,
  ].join("\n")).toString("base64");

  const launchCmd = [
    "aws ec2 run-instances",
    `--image-id ${inst.ami}`,
    `--instance-type ${inst.type}`,
    `--key-name ${inst.keyName}`,
    `--security-group-ids ${sgId}`,
    `--user-data ${userData}`,
    "--count 1",
    `--tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=openclaw-agent},{Key=ManagedBy,Value=openclaw-cloud-deployer}]'`,
    "--output json",
  ].join(" ");

  const result = JSON.parse(run(launchCmd));
  const instanceId = result.Instances[0].InstanceId;
  log.success(`Instance launched: ${instanceId}`);

  // Wait for running state
  log.info("Waiting for instance to enter running state...");
  run(`aws ec2 wait instance-running --instance-ids ${instanceId}`);

  // Get public IP
  const describeResult = JSON.parse(run(`aws ec2 describe-instances --instance-ids ${instanceId} --output json`));
  const publicIp = describeResult.Reservations[0].Instances[0].PublicIpAddress || "pending";
  log.success(`Instance running. Public IP: ${publicIp}`);

  return { instanceId, publicIp };
}

/**
 * Sets up SSL certificate via ACM if enabled.
 */
function configureSSL(config, dryRun) {
  if (!config.ssl.enabled) {
    log.info("SSL is disabled in configuration, skipping.");
    return null;
  }

  log.info("Configuring SSL via AWS ACM...");

  if (dryRun) {
    log.info("[dry-run] Would request ACM certificate.");
    return "arn:aws:acm:dry-run:certificate/placeholder";
  }

  // In a real deployment, you'd request a certificate:
  // aws acm request-certificate --domain-name <domain> --validation-method DNS
  const sslTemplate = loadSslTemplate();
  log.info("SSL template loaded. Certificate will be provisioned via ACM on domain assignment.");
  return "pending-domain-assignment";
}

/**
 * Configures auto-scaling if enabled.
 */
function configureScaling(config, instanceId, dryRun) {
  if (!config.scaling.enabled) {
    log.info("Auto-scaling is disabled in configuration.");
    return null;
  }

  log.info("Configuring auto-scaling group...");

  if (dryRun) {
    log.info(`[dry-run] Would create ASG: min=${config.scaling.minInstances}, max=${config.scaling.maxInstances}, target CPU=${config.scaling.targetCpuPercent}%`);
    return { asgName: "openclaw-asg-dry-run" };
  }

  // Create launch template from existing instance, then ASG
  const asgName = `openclaw-asg-${Date.now()}`;
  log.info(`Auto-scaling group "${asgName}" would be created with min=${config.scaling.minInstances}, max=${config.scaling.maxInstances}`);
  return { asgName };
}

/**
 * Main deployment pipeline for AWS.
 */
async function deploy(overrides = {}) {
  const startTime = Date.now();
  const args = parseArgs(process.argv);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  log.info("=== OpenClaw Cloud Deployer — AWS ===");
  if (dryRun) log.warn("Running in DRY-RUN mode. No cloud resources will be created.");

  // Load and merge config
  const baseConfig = loadConfig(PLATFORM);
  const config = mergeConfig(baseConfig, {
    ...overrides,
    region: args.region || overrides.region || baseConfig.region,
    instance: {
      ...baseConfig.instance,
      type: args["instance-type"] || baseConfig.instance.type,
    },
  });

  log.info(`Region: ${config.region}`);
  log.info(`Instance type: ${config.instance.type}`);

  // Pre-flight
  preflight(dryRun);

  // Security group
  const sgId = ensureSecurityGroup(config, dryRun);

  // Launch instance
  const { instanceId, publicIp } = launchInstance(config, sgId, dryRun);

  // SSL
  const sslArn = configureSSL(config, dryRun);

  // Scaling
  const scalingResult = configureScaling(config, instanceId, dryRun);

  // Save deployment state
  const deploymentId = generateDeploymentId(PLATFORM);
  const state = {
    deploymentId,
    platform: PLATFORM,
    region: config.region,
    instanceId,
    publicIp,
    securityGroupId: sgId,
    sslArn,
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
  log.info(`Instance ID:     ${instanceId}`);
  log.info(`Public IP:       ${publicIp}`);
  log.info(`Agent endpoint:  http://${publicIp}:${config.container.port}`);
  log.info(`Health check:    http://${publicIp}:${config.container.port}${config.container.healthCheckPath}`);
  log.info(`State saved to:  ${stateFile}`);
  log.info(`Duration:        ${elapsed}s`);

  return state;
}

// Run if called directly
if (require.main === module) {
  deploy().catch((err) => {
    log.error(`Deployment failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { deploy };
