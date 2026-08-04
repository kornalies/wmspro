# Billing Job Schedule

- `00:05` daily: `POST /api/finance/jobs/storage-snapshot` with `snapshot_date=today`.
- `00:30` daily/weekly/monthly: operational trigger reconciliation (optional backfill through `/api/finance/billing-transactions`).
- Manual only per tenant: `POST /api/finance/jobs/invoice-cycle-run` by tenant finance user.
  No scheduler is wired up yet; the run is catch-up capable (see below), so invoices are
  delayed rather than lost while it stays manual.
- `01:00` daily/weekly/monthly: optional manual `POST /api/finance/invoices/draft` with requested `period_from`/`period_to`.

## Manual Tenant Endpoint

- Route: `/api/finance/jobs/invoice-cycle-run`
- Auth: tenant session (`finance.view` permission).
- Tenant scope: always current logged-in tenant (`company_id` from session).
- Optional payload:
  - `run_date` (`YYYY-MM-DD`)
  - `run_key` (string)
  - `client_id` (number, optional targeted run within same tenant)

## Cycle Windows

Every cycle invoices a **complete, closed period**:

| Cycle | Released on | Period billed |
| --- | --- | --- |
| `WEEKLY` | `billing_day_of_week` | the 7 days ending that day |
| `MONTHLY` | `billing_day_of_month` of the FOLLOWING month | the whole previous calendar month |
| `QUARTERLY` | the quarter-end date | that whole quarter |
| `YEARLY` | the contract anniversary | the year ending that day |

For `MONTHLY`, `billing_day_of_month` is a **grace window**, not the period boundary:
July is invoiced on day N of August, so late-arriving July charges still land on the
July invoice. The column is `NOT NULL DEFAULT 1` and `CHECK (BETWEEN 1 AND 28)`.

## Catch-Up Behaviour

The run is **not** an exact-date match. `POST /api/finance/jobs/invoice-cycle-run` on
any date bills every closed period that still has `UNBILLED` charges, oldest first, so
a missed run self-heals on the next one. Scheduling therefore affects only how soon
invoices appear, not whether they are ever raised.

- The backfill is bounded by the client's earliest `UNBILLED` charge. No unbilled
  charges means no periods, so the run cannot enumerate over empty history.
- At most `MAX_CATCHUP_PERIODS` (36) periods are billed per client per run. When that
  bites, the response and `billing_job_runs.details` carry `truncated_clients`, so a
  bounded run is never mistaken for full coverage — run it again to continue.
- Period arithmetic lives in `lib/billing-cycle.ts` (pure, import-free) and is covered
  by `npm run test:billing-cycle`.

## Idempotency Rules

- Use deterministic `run_key` per schedule window.
- `billing_job_runs` has unique `(company_id, job_type, run_key)` to avoid duplicate runs.
- `billing_transactions` is protected by unique event key (`uq_bt_company_event_key`).
- Invoice drafts are unique per tenant/client/period (`uq_invoice_header_company_client_period`).
- Re-running is safe: the period-uniqueness constraint plus the `UNBILLED`-only selection
  mean a repeated run finds the pool already `BILLED` and generates nothing.
