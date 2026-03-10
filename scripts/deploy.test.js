#!/usr/bin/env node
"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "..");
const DEPLOYMENTS_DIR = path.join(SKILL_DIR, ".deployments");

function runScript(script, args = "") {
  return execSync(`node ${path.join(__dirname, script)} ${args} 2>&1`, {
    encoding: "utf-8",
    cwd: SKILL_DIR,
    env: { ...process.env },
    timeout: 30000,
  });
}

function getDeploymentIds() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
  return fs.readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes("reports"))
    .map((f) => f.replace(".json", ""));
}

describe("deploy-aws.js --dry-run", () => {
  let output;

  it("completes without error", () => {
    output = runScript("deploy-aws.js", "--dry-run");
    assert.ok(output.includes("DRY-RUN mode"));
    assert.ok(output.includes("Deployment Complete"));
  });

  it("outputs deployment ID", () => {
    assert.ok(output.includes("Deployment ID:"));
  });

  it("saves deployment state", () => {
    const match = output.match(/Deployment ID:\s+(aws-\S+)/);
    assert.ok(match, "Should output deployment ID");
    const id = match[1];
    const stateFile = path.join(DEPLOYMENTS_DIR, `${id}.json`);
    assert.ok(fs.existsSync(stateFile), `State file should exist: ${stateFile}`);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.equal(state.platform, "aws");
    assert.equal(state.dryRun, true);
    assert.equal(state.status, "deployed");
  });
});

describe("deploy-gcp.js --dry-run", () => {
  it("completes without error", () => {
    const output = runScript("deploy-gcp.js", "--dry-run");
    assert.ok(output.includes("DRY-RUN mode"));
    assert.ok(output.includes("Deployment Complete"));
    assert.ok(output.includes("gcp"));
  });
});

describe("deploy-azure.js --dry-run", () => {
  it("completes without error", () => {
    const output = runScript("deploy-azure.js", "--dry-run");
    assert.ok(output.includes("DRY-RUN mode"));
    assert.ok(output.includes("Deployment Complete"));
    assert.ok(output.includes("Azure"));
  });
});

describe("deploy-digitalocean.js --dry-run", () => {
  it("completes without error", () => {
    const output = runScript("deploy-digitalocean.js", "--dry-run");
    assert.ok(output.includes("DRY-RUN mode"));
    assert.ok(output.includes("Deployment Complete"));
    assert.ok(output.includes("DigitalOcean"));
  });
});

describe("deploy-aws.js --dry-run with overrides", () => {
  it("accepts --region override", () => {
    const output = runScript("deploy-aws.js", "--dry-run --region eu-west-1");
    assert.ok(output.includes("eu-west-1"));
  });

  it("accepts --instance-type override", () => {
    const output = runScript("deploy-aws.js", "--dry-run --instance-type t3.large");
    assert.ok(output.includes("t3.large"));
  });
});

describe("health-check.js", () => {
  it("lists deployments with --list", () => {
    const output = runScript("health-check.js", "--list");
    assert.ok(output.includes("Deployments:") || output.includes("No deployments"));
  });

  it("runs simulated checks on dry-run deployment", () => {
    const ids = getDeploymentIds().filter((id) => id.startsWith("aws-"));
    if (ids.length === 0) return;
    const output = runScript("health-check.js", `--deployment ${ids[0]}`);
    assert.ok(output.includes("HEALTHY"));
    assert.ok(output.includes("5/5 checks passed"));
  });

  it("uses most recent deployment if no ID specified", () => {
    const ids = getDeploymentIds();
    if (ids.length === 0) return;
    const output = runScript("health-check.js", "");
    assert.ok(output.includes("health checks for deployment") || output.includes("No deployment"));
  });
});

describe("rollback.js", () => {
  it("lists deployments with --list", () => {
    const output = runScript("rollback.js", "--list");
    assert.ok(output.includes("Deployments:") || output.includes("No deployments"));
  });

  it("performs dry-run rollback", () => {
    const ids = getDeploymentIds().filter((id) => id.startsWith("digitalocean-"));
    if (ids.length === 0) return;
    const output = runScript("rollback.js", `--deployment ${ids[0]} --dry-run`);
    assert.ok(output.includes("Rollback complete") || output.includes("already been rolled back"));
  });

  it("exits with error if no deployment ID given", () => {
    assert.throws(() => {
      runScript("rollback.js", "");
    });
  });
});

describe("full deploy -> health-check -> rollback cycle", () => {
  let deploymentId;

  it("deploys", () => {
    const output = runScript("deploy-azure.js", "--dry-run --location westeurope");
    const match = output.match(/Deployment ID:\s+(azure-\S+)/);
    assert.ok(match);
    deploymentId = match[1];
  });

  it("health-checks", () => {
    const output = runScript("health-check.js", `--deployment ${deploymentId}`);
    assert.ok(output.includes("HEALTHY"));
  });

  it("rolls back", () => {
    const output = runScript("rollback.js", `--deployment ${deploymentId} --dry-run`);
    assert.ok(output.includes("Rollback complete"));
    const state = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, `${deploymentId}.json`), "utf-8"));
    assert.equal(state.status, "rolled-back");
  });

  it("reports already rolled back on second rollback", () => {
    const output = runScript("rollback.js", `--deployment ${deploymentId} --dry-run`);
    assert.ok(output.includes("already been rolled back"));
  });
});

// Cleanup all test deployments
after(() => {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return;
  const files = fs.readdirSync(DEPLOYMENTS_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try { fs.unlinkSync(path.join(DEPLOYMENTS_DIR, f)); } catch {}
  }
  const reportsDir = path.join(DEPLOYMENTS_DIR, "reports");
  if (fs.existsSync(reportsDir)) {
    const reports = fs.readdirSync(reportsDir);
    for (const r of reports) {
      try { fs.unlinkSync(path.join(reportsDir, r)); } catch {}
    }
    try { fs.rmdirSync(reportsDir); } catch {}
  }
  try { fs.rmdirSync(DEPLOYMENTS_DIR); } catch {}
});
