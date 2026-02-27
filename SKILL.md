---
name: openclaw-cloud-deployer
description: Automatically deploys and configures OpenClaw agents to cloud platforms without manual Docker setup or server management.
version: 1.0.0
triggers:
  - deploy openclaw agent to aws
  - set up openclaw on google cloud platform
  - configure openclaw on azure
  - deploy openclaw to digitalocean
  - automate openclaw cloud deployment
  - scale openclaw agents in cloud
  - monitor openclaw cloud deployments
---

# openclaw-cloud-deployer

## 1. One-Sentence Description

Automates cloud deployment of OpenClaw agents with platform-specific optimizations, health monitoring, and fail-safe rollback.

## 2. Core Capabilities

- Cloud-specific deployment pipelines for AWS, GCP, Azure, and DigitalOcean
- Automated container setup with Docker on each platform
- SSL certificate configuration via platform-native providers
- Dynamic health monitoring with configurable checks (HTTP, TCP, command)
- Fail-safe rollback protocol to tear down failed deployments
- Auto-scaling configuration support for each platform
- Deployment state tracking and reporting

## 3. Trigger Mechanism

The skill activates when users request cloud deployment of OpenClaw agents. Commands like "Deploy OpenClaw to AWS" or "Set up OpenClaw on DigitalOcean" trigger the appropriate platform-specific deployment script.

## 4. Workflow

1. **Validate** — Check platform credentials and CLI tool availability
2. **Configure** — Load reference config for the target platform, merge with user overrides
3. **Provision** — Create cloud infrastructure (VMs, security groups, networking)
4. **Deploy** — Pull and run the OpenClaw agent container via Docker
5. **Secure** — Configure SSL certificates via the platform's native SSL provider
6. **Monitor** — Run health checks to confirm the agent is responding
7. **Report** — Generate deployment status report with metrics

## 5. Usage

### Deploy to a platform

```bash
node scripts/deploy-aws.js --dry-run
node scripts/deploy-gcp.js --dry-run --project-id my-project
node scripts/deploy-azure.js --dry-run --location westus
node scripts/deploy-digitalocean.js --dry-run --region sfo3
```

### Run health checks

```bash
node scripts/health-check.js --deployment <deployment-id>
node scripts/health-check.js --list
```

### Rollback a deployment

```bash
node scripts/rollback.js --deployment <deployment-id> --dry-run
node scripts/rollback.js --list
```

## 6. Configuration

Each platform has a JSON reference config in `references/`:

- `references/aws-config.json` — AWS region, instance type, VPC, security groups
- `references/gcp-config.json` — GCP project, zone, machine type, firewall rules
- `references/azure-config.json` — Azure subscription, resource group, VM size, NSG
- `references/digitalocean-config.json` — DO region, droplet size, firewall rules

Override any config value via CLI flags (e.g., `--region`, `--instance-type`).

## 7. Assets

- `assets/docker-compose.yml` — Base container orchestration template
- `assets/ssl-template.conf` — SSL certificate configuration template
- `assets/health-check-template.json` — Health check configuration with HTTP, TCP, and command checks
- `assets/monitoring-dashboard.html` — Browser-based deployment metrics dashboard
