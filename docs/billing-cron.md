# Billing Job Schedule

- `00:05` daily: `POST /api/finance/jobs/storage-snapshot` with `snapshot_date=today`.
- `00:30` daily/weekly/monthly: operational trigger reconciliation (optional backfill through `/api/finance/billing-transactions`).
- Manual only per tenant: `POST /api/finance/jobs/invoice-cycle-run` by tenant finance user.
- `01:00` daily/weekly/monthly: optional manual `POST /api/finance/invoices/draft` with requested `period_from`/`period_to`.

## Manual Tenant Endpoint

- Route: `/api/finance/jobs/invoice-cycle-run`
- Auth: tenant session (`finance.view` permission).
- Tenant scope: always current logged-in tenant (`company_id` from session).
- Optional payload:
  - `run_date` (`YYYY-MM-DD`)
  - `run_key` (string)
  - `client_id` (number, optional targeted run within same tenant)

## Idempotency Rules

- Use deterministic `run_key` per schedule window.
- `billing_job_runs` has unique `(company_id, job_type, run_key)` to avoid duplicate runs.
- `billing_transactions` is protected by unique event key (`uq_bt_company_event_key`).
- Invoice drafts are unique per tenant/client/period (`uq_invoice_header_company_client_period`).
