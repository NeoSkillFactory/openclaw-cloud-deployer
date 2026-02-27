#!/usr/bin/env node
"use strict";

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const SKILL_ROOT = path.resolve(__dirname, "..");
const REFERENCES_DIR = path.join(SKILL_ROOT, "references");
const ASSETS_DIR = path.join(SKILL_ROOT, "assets");
const DEPLOYMENTS_DIR = path.join(SKILL_ROOT, ".deployments");

const SUPPORTED_PLATFORMS = ["aws", "gcp", "azure", "digitalocean"];

/**
 * Loads a JSON reference config for a given cloud platform.
 */
function loadConfig(platform) {
  const configPath = path.join(REFERENCES_DIR, `${platform}-config.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration not found for platform: ${platform} (expected ${configPath})`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

/**
 * Merges user-provided overrides into the base config (shallow merge per section).
 */
function mergeConfig(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof merged[key] === "object") {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Parses CLI arguments into a key-value object.
 * Supports: --key value, --key=value, --flag (boolean true)
 */
function parseArgs(argv) {
  const args = {};
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        args[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      } else if (i + 1 < raw.length && !raw[i + 1].startsWith("--")) {
        args[arg.slice(2)] = raw[i + 1];
        i++;
      } else {
        args[arg.slice(2)] = true;
      }
    }
  }
  return args;
}

/**
 * Generates a unique deployment ID.
 */
function generateDeploymentId(platform) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${platform}-${ts}-${rand}`;
}

/**
 * Ensures the deployments state directory exists and returns its path.
 */
function ensureDeploymentsDir() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  return DEPLOYMENTS_DIR;
}

/**
 * Saves deployment state to disk for rollback and health-check reference.
 */
function saveDeploymentState(deploymentId, state) {
  const dir = ensureDeploymentsDir();
  const filePath = path.join(dir, `${deploymentId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  return filePath;
}

/**
 * Loads deployment state from disk.
 */
function loadDeploymentState(deploymentId) {
  const filePath = path.join(ensureDeploymentsDir(), `${deploymentId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment state not found: ${deploymentId}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Lists all stored deployment IDs.
 */
function listDeployments() {
  const dir = ensureDeploymentsDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

/**
 * Checks whether a CLI tool is available on the system.
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that required credentials / env vars exist for a platform.
 * Returns { valid: boolean, missing: string[] }
 */
function validateCredentials(platform) {
  const required = {
    aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
    gcp: ["GOOGLE_APPLICATION_CREDENTIALS", "GCP_PROJECT_ID"],
    azure: ["AZURE_SUBSCRIPTION_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
    digitalocean: ["DIGITALOCEAN_TOKEN"],
  };

  const vars = required[platform] || [];
  const missing = vars.filter((v) => !process.env[v]);
  return { valid: missing.length === 0, missing };
}

/**
 * Runs a shell command and returns stdout. Throws on non-zero exit.
 */
function run(cmd, opts = {}) {
  const result = execSync(cmd, {
    encoding: "utf-8",
    timeout: opts.timeout || 120000,
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
    stdio: opts.stdio || "pipe",
  });
  return result.trim();
}

/**
 * Performs an HTTP(S) GET request and returns { statusCode, body }.
 */
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Structured logger with timestamp and level.
 */
const log = {
  _format(level, msg) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level}] ${msg}`;
  },
  info(msg) { console.log(log._format("INFO", msg)); },
  warn(msg) { console.warn(log._format("WARN", msg)); },
  error(msg) { console.error(log._format("ERROR", msg)); },
  success(msg) { console.log(log._format("OK", msg)); },
};

/**
 * Reads the docker-compose.yml asset template.
 */
function loadDockerCompose() {
  const composePath = path.join(ASSETS_DIR, "docker-compose.yml");
  if (!fs.existsSync(composePath)) {
    throw new Error(`Docker compose template not found at ${composePath}`);
  }
  return fs.readFileSync(composePath, "utf-8");
}

/**
 * Reads the SSL template asset.
 */
function loadSslTemplate() {
  const sslPath = path.join(ASSETS_DIR, "ssl-template.conf");
  if (!fs.existsSync(sslPath)) {
    throw new Error(`SSL template not found at ${sslPath}`);
  }
  return fs.readFileSync(sslPath, "utf-8");
}

/**
 * Reads the health-check template asset.
 */
function loadHealthCheckTemplate() {
  const hcPath = path.join(ASSETS_DIR, "health-check-template.json");
  if (!fs.existsSync(hcPath)) {
    throw new Error(`Health check template not found at ${hcPath}`);
  }
  return JSON.parse(fs.readFileSync(hcPath, "utf-8"));
}

/**
 * Renders a string template with {{variable}} placeholders.
 */
function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`;
  });
}

/**
 * Waits for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  SKILL_ROOT,
  REFERENCES_DIR,
  ASSETS_DIR,
  DEPLOYMENTS_DIR,
  SUPPORTED_PLATFORMS,
  loadConfig,
  mergeConfig,
  parseArgs,
  generateDeploymentId,
  ensureDeploymentsDir,
  saveDeploymentState,
  loadDeploymentState,
  listDeployments,
  commandExists,
  validateCredentials,
  run,
  httpGet,
  log,
  loadDockerCompose,
  loadSslTemplate,
  loadHealthCheckTemplate,
  renderTemplate,
  sleep,
};
