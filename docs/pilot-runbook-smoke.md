# Pilot Runbook Smoke

## Command

```bash
npm run test:pilot-smoke
```

## Required Env

- `WMS_API_BASE_URL` (optional, default `http://localhost:3000/api`)
- `WMS_COMPANY_CODE`
- `WMS_USERNAME`
- `WMS_PASSWORD`

## Optional Env

- `WMS_SMOKE_ITEM_QUERY` (default `ITEM`)
- `WMS_SMOKE_BARCODE` (default `DO-`)

## What It Validates

1. Mobile login/auth token path.
2. Core operational APIs (`gate/in`, `grn/form-data`, `do`).
3. Portal APIs (`clients`, `reports`, `orders`, `inventory`, `billing`, `asn`).
4. Scanner APIs (`items/lookup`, `grn/barcode/lookup`, `do/parse`).

## Pass Criteria

- No endpoint returns `5xx`.
- Login returns a valid access token.
- Script exits with `Pilot smoke checks passed`.

## Incident Notes

- If an endpoint fails with `4xx`, verify role/permission and tenant/client mapping first.
- If an endpoint fails with `5xx`, capture request path, status, and stack trace from server logs before retry.

