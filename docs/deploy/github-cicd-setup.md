# GitHub CI/CD Setup

This repository includes:
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-production.yml`
- `.github/workflows/rollback-production.yml`
- `.github/workflows/ops-alerting.yml`

## Required GitHub Secrets

### Staging
- `STAGING_HOST`
- `STAGING_USER`
- `STAGING_APP_DIR` (example: `/opt/wmspro/current`)
- `STAGING_SSH_PRIVATE_KEY`

### Production
- `PROD_HOST`
- `PROD_USER`
- `PROD_APP_DIR` (example: `/opt/wmspro/current`)
- `PROD_SSH_PRIVATE_KEY`

## Recommended Branch Rules

- Protect `main`
- Require PR before merge
- Require status checks:
  - `strict-ci-gate`
- Restrict direct pushes to `main`

## Deploy Usage

### Staging
- Auto deploys on push to `main`
- Can also run manually via `workflow_dispatch`

### Production
- Manual only via Actions `Deploy Production`
- Provide `git_ref` (tag/commit) in workflow input
- On successful deploy, workflow creates a release tag:
  - Format: `prod-YYYYMMDD-HHMMSS-<shortsha>`
  - This tag is used as rollback target reference

## Rollback Usage (Production)

- Open Actions -> `Rollback Production`
- Enter `rollback_ref`:
  - Recommended: previous `prod-*` release tag
  - Also supports branch/commit SHA
- Run workflow and verify endpoint:
  - `https://<your-domain>/api/health` (or server local `127.0.0.1:3000/api/health`)

## Ops Alerting

`ops-alerting.yml` provides two controls:

1. Workflow failure alerts
- Trigger: any monitored workflow completes with non-success conclusion
- Monitored workflows:
  - `CI`
  - `Deploy Staging`
  - `Deploy Production`
  - `Rollback Production`
- Action: creates GitHub Issue with labels:
  - `ops-alert`
  - `ci-cd`
  - `workflow-failure`

2. Scheduled production health anomaly checks
- Trigger: every 30 minutes (`cron`) and manual run
- Check: SSH to production host and probe `http://127.0.0.1:3000/api/health`
- Action on failure: creates GitHub Issue with labels:
  - `ops-alert`
  - `ci-cd`
  - `health-check`

## CI/CD Health Metrics Mapping

- Pipeline Performance
  - CI runtime and deploy runtime visible in Actions run summary
  - Release tags provide deploy traceability per production run
- Quality Gates
  - Protected `main` branch + required `strict-ci-gate`
- Security & Compliance
  - Environment-scoped production secrets in GitHub Actions
  - Manual production deployment (`workflow_dispatch`) with explicit `git_ref`
- Infrastructure Health
  - Post-deploy health checks in deploy/rollback workflows
  - Scheduled production health probe with alert issue creation
- Deployment Validation
  - Deploy workflow validates app health after restart
  - Rollback workflow validates app health after rollback
