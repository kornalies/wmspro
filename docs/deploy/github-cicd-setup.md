# GitHub CI/CD Setup

This repository includes:
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-production.yml`

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

