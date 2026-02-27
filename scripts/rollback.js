#!/usr/bin/env node
"use strict";

const {
  parseArgs, loadDeploymentState, saveDeploymentState, listDeployments,
  validateCredentials, run, commandExists, log,
} = require("./utils");

/**
 * Terminates an AWS EC2 instance and cleans up associated resources.
 */
function rollbackAws(state, dryRun) {
  log.info("Rolling back AWS deployment...");

  if (dryRun || state.dryRun) {
    log.info(`[dry-run] Would terminate instance ${state.instanceId}`);
    log.info(`[dry-run] Would delete security group ${state.securityGroupId}`);
    return true;
  }

  if (!commandExists("aws")) {
    throw new Error("AWS CLI is not installed. Cannot perform rollback.");
  }

  const creds = validateCredentials("aws");
  if (!creds.valid) {
    throw new Error(`Missing AWS credentials for rollback: ${creds.missing.join(", ")}`);
  }

  // Terminate instance
  if (state.instanceId && state.instanceId !== "i-dry-run-placeholder") {
    log.info(`Terminating instance: ${state.instanceId}`);
    try {
      run(`aws ec2 terminate-instances --instance-ids ${state.instanceId}`);
      log.info("Waiting for instance to terminate...");
      run(`aws ec2 wait instance-terminated --instance-ids ${state.instanceId}`);
      log.success(`Instance terminated: ${state.instanceId}`);
    } catch (err) {
      log.warn(`Failed to terminate instance: ${err.message}`);
    }
  }

  // Delete security group (may fail if still in use)
  if (state.securityGroupId && state.securityGroupId !== "sg-dry-run-placeholder") {
    log.info(`Deleting security group: ${state.securityGroupId}`);
    try {
      run(`aws ec2 delete-security-group --group-id ${state.securityGroupId}`);
      log.success(`Security group deleted: ${state.securityGroupId}`);
    } catch (err) {
      log.warn(`Failed to delete security group (may still be in use): ${err.message}`);
    }
  }

  return true;
}

/**
 * Deletes a GCP instance and associated firewall rules.
 */
function rollbackGcp(state, dryRun) {
  log.info("Rolling back GCP deployment...");

  if (dryRun || state.dryRun) {
    log.info(`[dry-run] Would delete instance ${state.instanceName}`);
    log.info(`[dry-run] Would delete firewall rules: ${(state.firewallRules || []).join(", ")}`);
    return true;
  }

  if (!commandExists("gcloud")) {
    throw new Error("Google Cloud SDK is not installed. Cannot perform rollback.");
  }

  // Delete instance
  if (state.instanceName) {
    log.info(`Deleting instance: ${state.instanceName}`);
    try {
      run(`gcloud compute instances delete ${state.instanceName} --zone=${state.zone} --quiet`);
      log.success(`Instance deleted: ${state.instanceName}`);
    } catch (err) {
      log.warn(`Failed to delete instance: ${err.message}`);
    }
  }

  // Delete firewall rules
  if (state.firewallRules && state.firewallRules.length > 0) {
    for (const ruleName of state.firewallRules) {
      log.info(`Deleting firewall rule: ${ruleName}`);
      try {
        run(`gcloud compute firewall-rules delete ${ruleName} --quiet`);
        log.success(`Firewall rule deleted: ${ruleName}`);
      } catch (err) {
        log.warn(`Failed to delete firewall rule: ${err.message}`);
      }
    }
  }

  return true;
}

/**
 * Deletes an Azure VM and optionally the entire resource group.
 */
function rollbackAzure(state, dryRun) {
  log.info("Rolling back Azure deployment...");

  if (dryRun || state.dryRun) {
    log.info(`[dry-run] Would delete VM ${state.vmName} in resource group ${state.resourceGroup}`);
    return true;
  }

  if (!commandExists("az")) {
    throw new Error("Azure CLI is not installed. Cannot perform rollback.");
  }

  // Delete VM
  if (state.vmName) {
    log.info(`Deleting VM: ${state.vmName}`);
    try {
      run(`az vm delete --resource-group ${state.resourceGroup} --name ${state.vmName} --yes`);
      log.success(`VM deleted: ${state.vmName}`);
    } catch (err) {
      log.warn(`Failed to delete VM: ${err.message}`);
    }
  }

  // Clean up network resources
  if (state.network) {
    const rg = state.resourceGroup;
    const net = state.network;

    if (net.nsgName) {
      log.info(`Deleting NSG: ${net.nsgName}`);
      try {
        run(`az network nsg delete --resource-group ${rg} --name ${net.nsgName}`);
        log.success(`NSG deleted: ${net.nsgName}`);
      } catch (err) {
        log.warn(`Failed to delete NSG: ${err.message}`);
      }
    }

    if (net.vnetName) {
      log.info(`Deleting VNet: ${net.vnetName}`);
      try {
        run(`az network vnet delete --resource-group ${rg} --name ${net.vnetName}`);
        log.success(`VNet deleted: ${net.vnetName}`);
      } catch (err) {
        log.warn(`Failed to delete VNet: ${err.message}`);
      }
    }
  }

  return true;
}

/**
 * Destroys a DigitalOcean droplet and firewall.
 */
function rollbackDigitalocean(state, dryRun) {
  log.info("Rolling back DigitalOcean deployment...");

  if (dryRun || state.dryRun) {
    log.info(`[dry-run] Would destroy droplet ${state.dropletId}`);
    log.info(`[dry-run] Would delete firewall ${state.firewallId}`);
    return true;
  }

  if (!commandExists("doctl")) {
    throw new Error("DigitalOcean CLI (doctl) is not installed. Cannot perform rollback.");
  }

  // Destroy droplet
  if (state.dropletId) {
    log.info(`Destroying droplet: ${state.dropletId}`);
    try {
      run(`doctl compute droplet delete ${state.dropletId} --force`);
      log.success(`Droplet destroyed: ${state.dropletId}`);
    } catch (err) {
      log.warn(`Failed to destroy droplet: ${err.message}`);
    }
  }

  // Delete firewall
  if (state.firewallId && state.firewallId !== "fw-dry-run-placeholder") {
    log.info(`Deleting firewall: ${state.firewallId}`);
    try {
      run(`doctl compute firewall delete ${state.firewallId} --force`);
      log.success(`Firewall deleted: ${state.firewallId}`);
    } catch (err) {
      log.warn(`Failed to delete firewall: ${err.message}`);
    }
  }

  return true;
}

/**
 * Dispatches rollback to the appropriate platform handler.
 */
function performRollback(deploymentId, dryRun) {
  const state = loadDeploymentState(deploymentId);
  log.info(`Deployment ID: ${deploymentId}`);
  log.info(`Platform: ${state.platform}`);
  log.info(`Created at: ${state.createdAt}`);
  log.info(`Current status: ${state.status}`);

  if (state.status === "rolled-back") {
    log.warn("This deployment has already been rolled back.");
    return state;
  }

  const rollbackFns = {
    aws: rollbackAws,
    gcp: rollbackGcp,
    azure: rollbackAzure,
    digitalocean: rollbackDigitalocean,
  };

  const handler = rollbackFns[state.platform];
  if (!handler) {
    throw new Error(`Unsupported platform for rollback: ${state.platform}`);
  }

  const success = handler(state, dryRun);

  // Update state
  state.status = "rolled-back";
  state.rolledBackAt = new Date().toISOString();
  state.rollbackDryRun = dryRun;
  saveDeploymentState(deploymentId, state);

  log.success(`Rollback complete for ${deploymentId}`);
  return state;
}

/**
 * CLI entry point.
 */
function main() {
  const args = parseArgs(process.argv);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";
  const deploymentId = args.deployment || args.id;

  log.info("=== OpenClaw Cloud Deployer — Rollback ===");
  if (dryRun) log.warn("Running in DRY-RUN mode. No resources will be destroyed.");

  if (args.list) {
    const ids = listDeployments();
    if (ids.length === 0) {
      log.info("No deployments found.");
    } else {
      log.info("Deployments:");
      for (const id of ids) {
        try {
          const state = loadDeploymentState(id);
          log.info(`  ${id}  [${state.platform}]  ${state.status}  ${state.createdAt}`);
        } catch {
          log.info(`  ${id}  (unable to read state)`);
        }
      }
    }
    return;
  }

  if (!deploymentId) {
    log.error("No deployment ID specified. Use --deployment <id> or --list to see deployments.");
    process.exit(1);
  }

  performRollback(deploymentId, dryRun);
}

if (require.main === module) {
  main();
}

module.exports = { performRollback };
