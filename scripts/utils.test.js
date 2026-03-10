#!/usr/bin/env node
"use strict";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  loadConfig, mergeConfig, parseArgs, generateDeploymentId,
  ensureDeploymentsDir, saveDeploymentState, loadDeploymentState,
  listDeployments, validateCredentials, renderTemplate,
  loadDockerCompose, loadSslTemplate, loadHealthCheckTemplate,
  SKILL_ROOT, REFERENCES_DIR, ASSETS_DIR, DEPLOYMENTS_DIR,
  SUPPORTED_PLATFORMS, httpGet, log, sleep,
} = require("./utils");

describe("parseArgs", () => {
  it("parses --key value pairs", () => {
    const args = parseArgs(["node", "script", "--region", "us-east-1"]);
    assert.equal(args.region, "us-east-1");
  });

  it("parses --key=value pairs", () => {
    const args = parseArgs(["node", "script", "--region=us-west-2"]);
    assert.equal(args.region, "us-west-2");
  });

  it("parses boolean flags", () => {
    const args = parseArgs(["node", "script", "--dry-run"]);
    assert.equal(args["dry-run"], true);
  });

  it("parses multiple arguments", () => {
    const args = parseArgs(["node", "script", "--dry-run", "--region", "eu-west-1", "--instance-type=t3.large"]);
    assert.equal(args["dry-run"], true);
    assert.equal(args.region, "eu-west-1");
    assert.equal(args["instance-type"], "t3.large");
  });

  it("returns empty object for no arguments", () => {
    const args = parseArgs(["node", "script"]);
    assert.deepEqual(args, {});
  });

  it("ignores non-flag arguments", () => {
    const args = parseArgs(["node", "script", "positional"]);
    assert.deepEqual(args, {});
  });
});

describe("loadConfig", () => {
  it("loads AWS config", () => {
    const config = loadConfig("aws");
    assert.equal(config.platform, "aws");
    assert.equal(config.region, "us-east-1");
    assert.ok(config.instance);
    assert.ok(config.container);
    assert.ok(config.ssl);
  });

  it("loads GCP config", () => {
    const config = loadConfig("gcp");
    assert.equal(config.platform, "gcp");
    assert.ok(config.compute);
  });

  it("loads Azure config", () => {
    const config = loadConfig("azure");
    assert.equal(config.platform, "azure");
    assert.ok(config.compute);
    assert.ok(config.network);
  });

  it("loads DigitalOcean config", () => {
    const config = loadConfig("digitalocean");
    assert.equal(config.platform, "digitalocean");
    assert.ok(config.droplet);
  });

  it("throws for unknown platform", () => {
    assert.throws(() => loadConfig("unknown"), /Configuration not found/);
  });
});

describe("mergeConfig", () => {
  it("overrides scalar values", () => {
    const base = { region: "us-east-1", name: "test" };
    const result = mergeConfig(base, { region: "eu-west-1" });
    assert.equal(result.region, "eu-west-1");
    assert.equal(result.name, "test");
  });

  it("shallow-merges nested objects", () => {
    const base = { instance: { type: "t3.medium", ami: "ami-123" } };
    const result = mergeConfig(base, { instance: { type: "t3.large" } });
    assert.equal(result.instance.type, "t3.large");
    assert.equal(result.instance.ami, "ami-123");
  });

  it("does not mutate the base object", () => {
    const base = { region: "us-east-1" };
    mergeConfig(base, { region: "eu-west-1" });
    assert.equal(base.region, "us-east-1");
  });
});

describe("generateDeploymentId", () => {
  it("includes platform prefix", () => {
    const id = generateDeploymentId("aws");
    assert.ok(id.startsWith("aws-"));
  });

  it("generates unique IDs", () => {
    const id1 = generateDeploymentId("gcp");
    const id2 = generateDeploymentId("gcp");
    assert.notEqual(id1, id2);
  });
});

describe("deployment state management", () => {
  const testDeploymentId = `test-${Date.now()}-cleanup`;
  const testState = {
    deploymentId: testDeploymentId,
    platform: "aws",
    status: "deployed",
    createdAt: new Date().toISOString(),
    dryRun: true,
  };

  after(() => {
    // Cleanup
    const filePath = path.join(DEPLOYMENTS_DIR, `${testDeploymentId}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it("saves and loads deployment state", () => {
    const filePath = saveDeploymentState(testDeploymentId, testState);
    assert.ok(fs.existsSync(filePath));

    const loaded = loadDeploymentState(testDeploymentId);
    assert.equal(loaded.deploymentId, testDeploymentId);
    assert.equal(loaded.platform, "aws");
    assert.equal(loaded.status, "deployed");
  });

  it("lists deployments", () => {
    const ids = listDeployments();
    assert.ok(Array.isArray(ids));
    assert.ok(ids.includes(testDeploymentId));
  });

  it("throws for missing deployment", () => {
    assert.throws(() => loadDeploymentState("nonexistent-id-xyz"), /not found/);
  });
});

describe("validateCredentials", () => {
  it("reports missing AWS credentials", () => {
    const origKey = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_ACCESS_KEY_ID;
    const result = validateCredentials("aws");
    assert.equal(result.valid, false);
    assert.ok(result.missing.includes("AWS_ACCESS_KEY_ID"));
    if (origKey) process.env.AWS_ACCESS_KEY_ID = origKey;
  });

  it("reports missing DigitalOcean token", () => {
    const orig = process.env.DIGITALOCEAN_TOKEN;
    delete process.env.DIGITALOCEAN_TOKEN;
    const result = validateCredentials("digitalocean");
    assert.equal(result.valid, false);
    assert.ok(result.missing.includes("DIGITALOCEAN_TOKEN"));
    if (orig) process.env.DIGITALOCEAN_TOKEN = orig;
  });

  it("returns empty missing array for unknown platform", () => {
    const result = validateCredentials("unknown");
    assert.equal(result.valid, true);
    assert.equal(result.missing.length, 0);
  });
});

describe("renderTemplate", () => {
  it("replaces template variables", () => {
    const result = renderTemplate("http://{{host}}:{{port}}/health", { host: "1.2.3.4", port: "8080" });
    assert.equal(result, "http://1.2.3.4:8080/health");
  });

  it("preserves unknown variables", () => {
    const result = renderTemplate("{{known}} {{unknown}}", { known: "yes" });
    assert.equal(result, "yes {{unknown}}");
  });

  it("handles empty vars", () => {
    const result = renderTemplate("no-vars-here", {});
    assert.equal(result, "no-vars-here");
  });
});

describe("asset loaders", () => {
  it("loads docker-compose.yml", () => {
    const content = loadDockerCompose();
    assert.ok(content.includes("openclaw-agent"));
    assert.ok(content.includes("services:"));
  });

  it("loads ssl-template.conf", () => {
    const content = loadSslTemplate();
    assert.ok(content.includes("{{domain}}"));
    assert.ok(content.includes("[req]"));
  });

  it("loads health-check-template.json", () => {
    const template = loadHealthCheckTemplate();
    assert.ok(Array.isArray(template.checks));
    assert.ok(template.checks.length > 0);
    assert.ok(template.checks.some((c) => c.type === "http"));
    assert.ok(template.checks.some((c) => c.type === "tcp"));
    assert.ok(template.checks.some((c) => c.type === "command"));
  });
});

describe("SUPPORTED_PLATFORMS", () => {
  it("includes all four platforms", () => {
    assert.deepEqual(SUPPORTED_PLATFORMS.sort(), ["aws", "azure", "digitalocean", "gcp"]);
  });
});

describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });
});

describe("ensureDeploymentsDir", () => {
  it("returns the deployments directory path", () => {
    const dir = ensureDeploymentsDir();
    assert.ok(dir.endsWith(".deployments"));
    assert.ok(fs.existsSync(dir));
  });
});
