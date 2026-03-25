# Branch Protection Policy

## Release freeze

- Branch: `release`
- Direct pushes: blocked by workflow `.github/workflows/release-freeze.yml`
- Change path: pull request only

## Required status checks before merge

Configure GitHub branch protection (or ruleset) for both `main` and `release` with:

1. `CI / strict-ci-gate`
2. `Release Freeze / block-direct-push` (for `release` branch)

`CI / strict-ci-gate` enforces:

- `npm run lint`
- `npm run build`
- `npm run test:contract`
- `npm run test:isolation`

Additional hardening checks run in the same gate:

- `npm run test:resilience`
- `npm run check:tenant-safety`
