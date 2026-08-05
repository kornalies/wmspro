# Billing Job Schedule

- `00:30` UTC daily: `.github/workflows/billing-schedule.yml` calls
  `POST /api/finance/jobs/scheduled-run`, which runs the storage snapshot and then the
  invoice cycle run for **every active tenant**. See "Scheduled Run" below.
  **The daily trigger is currently commented out** — the route and the workflow both work,
  but the schedule stays off until `BILLING_APP_URL` and `BILLING_CRON_SECRET` exist as
  repository secrets. Until then the run is local/manual (`workflow_dispatch`, or a direct
  POST), exactly as before, and nothing invoices itself unattended.
- `00:30` daily/weekly/monthly: operational trigger reconciliation (optional backfill through `/api/finance/billing-transactions`).
- Per tenant, on demand: `POST /api/finance/jobs/invoice-cycle-run` by a tenant finance user.
  Still supported, and still the way to run one tenant ahead of the schedule.
- `01:00` daily/weekly/monthly: optional manual `POST /api/finance/invoices/draft` with requested `period_from`/`period_to`.

## Scheduled Run (system)

- Route: `/api/finance/jobs/scheduled-run`
- Auth: **shared secret**, header `x-cron-secret`, compared against `BILLING_CRON_SECRET`.
  There is no session — a cron has no tenant, which is exactly why the per-tenant routes
  could never be scheduled. The secret is the entire authorisation boundary; treat it like
  a deploy key and rotate it the same way.
- **Fails closed:** with `BILLING_CRON_SECRET` unset the route returns `503 CRON_DISABLED`
  for everyone. It is never open.
- Scope: every `companies` row with `is_active = true`. Tenants with no billing profiles
  simply return nothing, so the fan-out is a no-op for them.
- Optional payload:
  - `run_date` (`YYYY-MM-DD`, defaults to today)
  - `jobs` (subset of `["storage-snapshot", "invoice-cycle-run"]`)
  - `company_id` (single tenant, for debugging)
- **Job order is load-bearing.** The storage snapshot writes the day's storage charges as
  `billing_transactions`; the cycle run then sweeps unbilled charges onto invoices. Reversing
  them under-bills storage by one cycle. The route sorts the requested jobs into this order
  rather than trusting the caller's array.
- **One tenant's failure does not stop the others.** Each tenant/job pair runs in its own
  transaction and reports independently; the response carries `failed_count` and a per-tenant
  `results` array. The workflow inspects the body, because HTTP 200 only means the fan-out
  itself ran.
- Every tenant/job pair records a `billing_job_runs` row with `run_key`
  `CRON-<JOB_TYPE>-<run_date>` and `details.trigger = "cron"`, marked `SUCCESS` or `FAILED`.
  The RUNNING row is committed separately from the work so a crash still leaves evidence.
- Test: `npm run test:billing-cron` (needs the app running and `BILLING_CRON_SECRET` set).

### Running it locally

`BILLING_CRON_SECRET` in `.env.local` is all the route needs:

```sh
curl -sS -X POST http://localhost:3000/api/finance/jobs/scheduled-run \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: $BILLING_CRON_SECRET" \
  -d '{}' | jq .
```

Add `{"company_id": 1}` for a single tenant, or `{"run_date": "2026-07-31"}` to backfill.

### Turning the schedule on later

1. Set `BILLING_CRON_SECRET` in the deployed app's environment.
2. Add repository secrets `BILLING_CRON_SECRET` (same value) and `BILLING_APP_URL`.
3. Uncomment the `schedule:` block in `.github/workflows/billing-schedule.yml`.

Without step 1 the route is disabled; without step 2 the workflow fails its first step
rather than appearing to succeed. Step 3 is deliberately last — a nightly job that fails
for weeks because it was enabled early teaches everyone to ignore it.

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

- Use deterministic `run_key` per schedule window. The scheduled run derives its own
  (`CRON-<JOB_TYPE>-<run_date>`), so a retry of the same day reuses it.
- `billing_job_runs` has unique `(company_id, job_type, run_key)` to avoid duplicate runs.
- `billing_transactions` is protected by unique event key (`uq_bt_company_event_key`).
- Invoice drafts are unique per tenant/client/period (`uq_invoice_header_company_client_period`).
- Re-running is safe: the period-uniqueness constraint plus the `UNBILLED`-only selection
  mean a repeated run finds the pool already `BILLED` and generates nothing.
