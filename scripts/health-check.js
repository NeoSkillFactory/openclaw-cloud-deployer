#!/usr/bin/env node
"use strict";

const {
  parseArgs, loadDeploymentState, listDeployments, saveDeploymentState,
  loadHealthCheckTemplate, renderTemplate, httpGet, log, sleep,
  ensureDeploymentsDir,
} = require("./utils");

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * Runs a single HTTP health check against an endpoint.
 */
async function checkHttp(check, vars) {
  const url = renderTemplate(check.url, vars);
  const results = [];

  for (let attempt = 1; attempt <= check.retries; attempt++) {
    const start = Date.now();
    try {
      const res = await httpGet(url, check.timeoutMs);
      const latencyMs = Date.now() - start;
      const passed = res.statusCode === check.expectedStatus;
      results.push({
        attempt,
        passed,
        statusCode: res.statusCode,
        latencyMs,
        error: passed ? null : `Expected status ${check.expectedStatus}, got ${res.statusCode}`,
      });
      if (passed) break;
    } catch (err) {
      results.push({
        attempt,
        passed: false,
        statusCode: null,
        latencyMs: Date.now() - start,
        error: err.message,
      });
    }
    if (attempt < check.retries) await sleep(1000);
  }

  const lastResult = results[results.length - 1];
  return {
    name: check.name,
    type: check.type,
    url,
    passed: lastResult.passed,
    latencyMs: lastResult.latencyMs,
    attempts: results.length,
    lastError: lastResult.error,
    lastRun: new Date().toISOString(),
  };
}

/**
 * Runs a command-based health check.
 */
function checkCommand(check) {
  const results = [];

  for (let attempt = 1; attempt <= check.retries; attempt++) {
    const start = Date.now();
    try {
      const output = execSync(check.command, {
        encoding: "utf-8",
        timeout: check.timeoutMs,
        stdio: "pipe",
      }).trim();
      const latencyMs = Date.now() - start;
      const passed = new RegExp(check.expectedPattern).test(output);
      results.push({
        attempt,
        passed,
        output,
        latencyMs,
        error: passed ? null : `Output "${output}" did not match pattern /${check.expectedPattern}/`,
      });
      if (passed) break;
    } catch (err) {
      results.push({
        attempt,
        passed: false,
        output: null,
        latencyMs: Date.now() - start,
        error: err.message,
      });
    }
  }

  const lastResult = results[results.length - 1];
  return {
    name: check.name,
    type: check.type,
    passed: lastResult.passed,
    latencyMs: lastResult.latencyMs,
    attempts: results.length,
    lastError: lastResult.error,
    lastRun: new Date().toISOString(),
  };
}

/**
 * Runs a TCP connectivity check.
 */
async function checkTcp(check, vars) {
  const host = renderTemplate(check.host, vars);
  const port = renderTemplate(String(check.port), vars);
  const net = require("net");

  for (let attempt = 1; attempt <= check.retries; attempt++) {
    const start = Date.now();
    const passed = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(check.timeoutMs);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => { socket.destroy(); resolve(false); });
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
      socket.connect(Number(port), host);
    });
    const latencyMs = Date.now() - start;

    if (passed) {
      return {
        name: check.name,
        type: check.type,
        host,
        port: Number(port),
        passed: true,
        latencyMs,
        attempts: attempt,
        lastError: null,
        lastRun: new Date().toISOString(),
      };
    }
    if (attempt < check.retries) await sleep(1000);
  }

  return {
    name: check.name,
    type: check.type,
    host,
    port: Number(port),
    passed: false,
    latencyMs: 0,
    attempts: check.retries,
    lastError: `TCP connection to ${host}:${port} failed after ${check.retries} attempts`,
    lastRun: new Date().toISOString(),
  };
}

/**
 * Runs all health checks for a given deployment.
 */
async function runHealthChecks(deploymentId, opts = {}) {
  const state = loadDeploymentState(deploymentId);
  const template = loadHealthCheckTemplate();

  const host = state.publicIp || "localhost";
  const port = state.container?.port || 8080;
  const healthCheckPath = state.container?.healthCheckPath || "/health";

  const vars = { host, port: String(port), healthCheckPath };

  log.info(`Running health checks for deployment: ${deploymentId}`);
  log.info(`Target: ${host}:${port}`);
  log.info(`Platform: ${state.platform}`);

  if (state.dryRun) {
    log.warn("This deployment was created in dry-run mode. Health checks will be simulated.");
    const results = template.checks.map((check) => ({
      name: check.name,
      type: check.type,
      passed: true,
      latencyMs: Math.floor(Math.random() * 50) + 5,
      attempts: 1,
      lastError: null,
      lastRun: new Date().toISOString(),
      simulated: true,
    }));

    const report = generateReport(deploymentId, state, results);
    return report;
  }

  const results = [];
  for (const check of template.checks) {
    let result;
    switch (check.type) {
      case "http":
        result = await checkHttp(check, vars);
        break;
      case "command":
        result = checkCommand(check);
        break;
      case "tcp":
        result = await checkTcp(check, vars);
        break;
      default:
        result = { name: check.name, type: check.type, passed: false, lastError: `Unknown check type: ${check.type}`, lastRun: new Date().toISOString() };
    }
    results.push(result);

    const icon = result.passed ? "PASS" : "FAIL";
    log.info(`  [${icon}] ${result.name} (${result.latencyMs}ms, ${result.attempts} attempt(s))`);
    if (result.lastError) log.warn(`         ${result.lastError}`);
  }

  return generateReport(deploymentId, state, results);
}

/**
 * Generates a health check report and saves it to disk.
 */
function generateReport(deploymentId, state, results) {
  const allPassed = results.every((r) => r.passed);
  const report = {
    deploymentId,
    platform: state.platform,
    host: state.publicIp,
    timestamp: new Date().toISOString(),
    overallStatus: allPassed ? "healthy" : "unhealthy",
    checks: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      avgLatencyMs: Math.round(results.reduce((s, r) => s + (r.latencyMs || 0), 0) / results.length),
    },
  };

  // Save report
  const reportsDir = path.join(ensureDeploymentsDir(), "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const reportFile = path.join(reportsDir, `${deploymentId}-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf-8");

  // Update deployment state
  state.lastHealthCheck = report.timestamp;
  state.healthStatus = report.overallStatus;
  saveDeploymentState(deploymentId, state);

  log.info("");
  log.info(`Overall: ${report.overallStatus.toUpperCase()} (${report.summary.passed}/${report.summary.total} checks passed)`);
  log.info(`Report saved: ${reportFile}`);

  return report;
}

/**
 * CLI entry point.
 */
async function main() {
  const args = parseArgs(process.argv);
  const deploymentId = args.deployment || args.id;

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
    // If no ID specified, use the most recent deployment
    const ids = listDeployments();
    if (ids.length === 0) {
      log.error("No deployments found. Deploy first, then run health checks.");
      process.exit(1);
    }
    const latestId = ids[ids.length - 1];
    log.info(`No deployment ID specified, using most recent: ${latestId}`);
    const report = await runHealthChecks(latestId);
    if (report.overallStatus !== "healthy") process.exit(1);
    return;
  }

  const report = await runHealthChecks(deploymentId);
  if (report.overallStatus !== "healthy") process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    log.error(`Health check failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runHealthChecks, checkHttp, checkCommand, checkTcp };
