# openclaw-cloud-deployer

![Audit](https://img.shields.io/badge/audit%3A%20PASS-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![OpenClaw](https://img.shields.io/badge/OpenClaw-skill-orange)

> Automatically deploys and configures OpenClaw agents to cloud platforms without manual Docker setup or server management.

## Features

- Cloud-specific deployment pipelines for AWS, GCP, Azure, and DigitalOcean
- Automated container setup with Docker on each platform
- SSL certificate configuration via platform-native providers
- Dynamic health monitoring with configurable checks (HTTP, TCP, command)
- Fail-safe rollback protocol to tear down failed deployments
- Auto-scaling configuration support for each platform
- Deployment state tracking and reporting

## Configuration

Each platform has a JSON reference config in `references/`:

- `references/aws-config.json` — AWS region, instance type, VPC, security groups
- `references/gcp-config.json` — GCP project, zone, machine type, firewall rules
- `references/azure-config.json` — Azure subscription, resource group, VM size, NSG
- `references/digitalocean-config.json` — DO region, droplet size, firewall rules

Override any config value via CLI flags (e.g., `--region`, `--instance-type`).

## GitHub

Source code: [github.com/NeoSkillFactory/openclaw-cloud-deployer](https://github.com/NeoSkillFactory/openclaw-cloud-deployer)

## License

MIT © NeoSkillFactory