/**
 * Accounts receivable: the one definition of "what a client owes us".
 *
 * Four surfaces answer that question — the invoices list, the receivables
 * screen, the Statement of Account document, and the client portal. They used
 * to answer it with four hand-written queries, which is how the portal ended up
 * counting DRAFT and VOID invoices in the number it shows the client. The rules
 * live here now, and everything else calls in.
 *
 * Rules, in one place:
 *   - A receivable is an invoice with balance_amount > 0 that is neither DRAFT
 *     nor VOID. A draft is not money anyone owes; a void invoice never was.
 *   - balance_amount is the source of truth for outstanding. It is already net
 *     of credit notes — app/api/finance/credit-notes/route.ts decrements it on
 *     issue — so credit_notes here is reported for context, never subtracted a
 *     second time.
 *   - Age is measured from due_date, not invoice_date, as of a caller-supplied
 *     date. Bucket edges match the aging block the invoices route has always
 *     returned, so the two never disagree.
 */

import { query } from "@/lib/db"

/**
 * Display status, derived at read time rather than stored.
 *
 * OVERDUE is deliberately not a persisted status — it is a function of due_date
 * and balance, and invoice_header's check constraint does not allow it (see the
 * note in app/api/finance/invoices/[id]/payments/route.ts). `ih` and `credit_notes`
 * must be in scope wherever this fragment is interpolated.
 */
export const INVOICE_STATUS_SQL = `
  CASE
    WHEN COALESCE(credit_notes.reversal_credit_total, 0) >= COALESCE(ih.grand_total, 0)
      AND COALESCE(ih.grand_total, 0) > 0 THEN 'REVERSED'
    WHEN ih.status = 'PAID' THEN 'PAID'
    WHEN ih.status = 'DRAFT' THEN 'DRAFT'
    WHEN ih.status = 'VOID' THEN 'VOID'
    WHEN COALESCE(ih.balance_amount, 0) <= 0 THEN 'PAID'
    WHEN ih.due_date < CURRENT_DATE THEN 'OVERDUE'
    WHEN ih.status = 'FINALIZED' THEN 'SENT'
    ELSE ih.status
  END`

/**
 * Keeps smoke-test and hardening-fixture invoices out of every finance read.
 * They are written into the same tables as real data by the test suites, so the
 * filter is a permanent part of the tenant predicate rather than a dev-only
 * concern. `ih` and `c` must be in scope.
 */
export const INVOICE_NOISE_FILTER_SQL = `
  COALESCE(ih.invoice_number, '') NOT ILIKE 'INV-HARD-%'
  AND COALESCE(c.client_name, '') NOT ILIKE '%smoke%'
  AND COALESCE(c.client_code, '') NOT ILIKE '%smoke%'
  AND COALESCE(ih.invoice_number, '') NOT ILIKE '%smoke%'
  AND COALESCE(ih.draft_run_key, '') NOT ILIKE '%smoke%'
  AND COALESCE(ih.draft_run_key, '') NOT ILIKE '%hardening%'`

/** Statuses that are not receivables at all, whatever their balance says. */
export const NON_RECEIVABLE_STATUSES = ["DRAFT", "VOID"] as const

export type AgingBucketKey = "current" | "bucket_1_30" | "bucket_31_60" | "bucket_61_90" | "bucket_90_plus"

/**
 * Age bands, oldest last. `maxDays: null` is the open-ended tail.
 * `current` covers everything not yet due (days <= 0).
 */
export const AGING_BUCKETS: Array<{ key: AgingBucketKey; label: string; maxDays: number | null }> = [
  { key: "current", label: "Current", maxDays: 0 },
  { key: "bucket_1_30", label: "1-30", maxDays: 30 },
  { key: "bucket_31_60", label: "31-60", maxDays: 60 },
  { key: "bucket_61_90", label: "61-90", maxDays: 90 },
  { key: "bucket_90_plus", label: "90+", maxDays: null },
]

export type AgingBuckets = Record<AgingBucketKey, number>

export const EMPTY_AGING: AgingBuckets = {
  current: 0,
  bucket_1_30: 0,
  bucket_31_60: 0,
  bucket_61_90: 0,
  bucket_90_plus: 0,
}

/** Days past due for one invoice, as of a date. Negative (not yet due) clamps to 0. */
export function daysOverdue(dueDate: string | Date, asOf: string | Date): number {
  const due = new Date(dueDate)
  const at = new Date(asOf)
  const days = Math.floor((at.getTime() - due.getTime()) / 86_400_000)
  return days > 0 ? days : 0
}

/** Which band a given age falls in. Shared by SQL-side and JS-side callers. */
export function bucketFor(days: number): AgingBucketKey {
  for (const bucket of AGING_BUCKETS) {
    if (bucket.maxDays === null || days <= bucket.maxDays) return bucket.key
  }
  return "bucket_90_plus"
}

/**
 * SUM(...) FILTER per bucket. `alias` is the CTE holding one row per open
 * invoice with a `days_overdue` integer and a `balance` numeric.
 */
function bucketSums(alias: string): string {
  return AGING_BUCKETS.map((bucket, index) => {
    const lower = index === 0 ? null : AGING_BUCKETS[index - 1].maxDays
    const clauses: string[] = []
    if (lower !== null) clauses.push(`${alias}.days_overdue > ${lower}`)
    if (bucket.maxDays !== null) clauses.push(`${alias}.days_overdue <= ${bucket.maxDays}`)
    const predicate = clauses.length ? clauses.join(" AND ") : "TRUE"
    return `COALESCE(SUM(${alias}.balance) FILTER (WHERE ${predicate}), 0)::numeric AS ${bucket.key}`
  }).join(",\n         ")
}

export type ReceivablesFilters = {
  /** Ageing reference date, YYYY-MM-DD. Defaults to today. */
  asOf?: string | null
  /** Only invoices with billing transactions at this warehouse. */
  warehouseId?: number | null
  clientId?: number | null
}

export type ReceivablesClientRow = {
  client_id: number
  client_name: string
  client_code: string | null
  open_invoices: number
  overdue_invoices: number
  oldest_due_date: string | null
  days_oldest: number
  billed: number
  collected: number
  credit_notes: number
  outstanding: number
  overdue: number
} & AgingBuckets

export type ReceivablesTotals = {
  clients: number
  open_invoices: number
  overdue_invoices: number
  billed: number
  collected: number
  credit_notes: number
  outstanding: number
  overdue: number
  days_oldest: number
} & AgingBuckets

export type OpenInvoiceRow = {
  id: number
  invoice_number: string
  invoice_date: string
  due_date: string
  billing_period: string | null
  days_overdue: number
  bucket: AgingBucketKey
  grand_total: number
  paid_amount: number
  credit_note_total: number
  balance: number
  status: string
}

/** Numeric columns come back from pg as strings; every read goes through this. */
function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function resolveAsOf(asOf?: string | null): string {
  if (asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) return asOf
  return new Date().toISOString().slice(0, 10)
}

/**
 * The scoped invoice set, shared by both queries below.
 *
 * `$1` company, `$2` as-of date, `$3` warehouse (nullable), `$4` client (nullable).
 * The warehouse predicate goes through billing_transactions because an invoice
 * has no warehouse of its own — it bills whatever sites its charges came from,
 * which is the same join the invoices route filters on.
 */
export const SCOPED_INVOICES_SQL = `
  SELECT
    ih.id,
    ih.client_id,
    c.client_name,
    c.client_code,
    ih.invoice_number,
    ih.invoice_date,
    ih.due_date,
    ih.billing_period,
    COALESCE(ih.grand_total, 0)::numeric AS grand_total,
    COALESCE(ih.paid_amount, 0)::numeric AS paid_amount,
    COALESCE(ih.balance_amount, 0)::numeric AS balance,
    COALESCE(credit_notes.credit_note_total, 0)::numeric AS credit_note_total,
    GREATEST(($2::date - ih.due_date), 0)::int AS days_overdue,
    ${INVOICE_STATUS_SQL} AS status
  FROM invoice_header ih
  JOIN clients c
    ON c.id = ih.client_id
   AND c.company_id = ih.company_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(cnh.grand_total), 0)::numeric AS credit_note_total,
      COALESCE(SUM(cnh.grand_total) FILTER (WHERE cnh.reason ILIKE 'Invoice reversal:%'), 0)::numeric
        AS reversal_credit_total
    FROM credit_note_header cnh
    WHERE cnh.company_id = ih.company_id
      AND cnh.invoice_id = ih.id
      AND cnh.status <> 'VOID'
  ) credit_notes ON true
  WHERE ih.company_id = $1
    AND ${INVOICE_NOISE_FILTER_SQL}
    AND COALESCE(ih.status, '') <> ALL (ARRAY['DRAFT', 'VOID'])
    AND ($3::int IS NULL OR EXISTS (
      SELECT 1
      FROM billing_transactions bt
      WHERE bt.company_id = ih.company_id
        AND bt.invoice_id = ih.id
        AND bt.warehouse_id = $3::int
    ))
    AND ($4::int IS NULL OR ih.client_id = $4::int)`

/**
 * True when invoice_header exists. Every finance read guards on this because a
 * fresh database is bootstrapped lazily and a missing table should render an
 * empty screen, not a 500.
 */
export async function invoiceTableExists(): Promise<boolean> {
  const result = await query(`SELECT to_regclass('public.invoice_header') AS table_name`)
  return Boolean(result.rows[0]?.table_name)
}

/**
 * One row per client with any billing history in scope, plus tenant totals.
 * Clients with nothing outstanding are dropped — an AR screen lists debtors.
 */
export async function receivablesByClient(
  companyId: number,
  filters: ReceivablesFilters = {}
): Promise<{ rows: ReceivablesClientRow[]; totals: ReceivablesTotals; asOf: string }> {
  const asOf = resolveAsOf(filters.asOf)
  if (!(await invoiceTableExists())) {
    return { rows: [], totals: emptyTotals(), asOf }
  }

  const result = await query(
    `WITH scoped AS (${SCOPED_INVOICES_SQL}),
     open_items AS (
       SELECT * FROM scoped WHERE balance > 0
     )
     SELECT
       s.client_id,
       MAX(s.client_name) AS client_name,
       MAX(s.client_code) AS client_code,
       COUNT(*) FILTER (WHERE s.balance > 0)::int AS open_invoices,
       COUNT(*) FILTER (WHERE s.balance > 0 AND s.days_overdue > 0)::int AS overdue_invoices,
       MIN(s.due_date) FILTER (WHERE s.balance > 0)::text AS oldest_due_date,
       COALESCE(MAX(s.days_overdue) FILTER (WHERE s.balance > 0), 0)::int AS days_oldest,
       COALESCE(SUM(s.grand_total), 0)::numeric AS billed,
       COALESCE(SUM(s.paid_amount), 0)::numeric AS collected,
       COALESCE(SUM(s.credit_note_total), 0)::numeric AS credit_notes,
       COALESCE(SUM(s.balance), 0)::numeric AS outstanding,
       COALESCE(SUM(s.balance) FILTER (WHERE s.days_overdue > 0), 0)::numeric AS overdue,
       ${bucketSums("s")}
     FROM scoped s
     GROUP BY s.client_id
     HAVING COALESCE(SUM(s.balance), 0) > 0
     ORDER BY outstanding DESC, client_name ASC`,
    scopedParams(companyId, filters.clientId ?? null, { ...filters, asOf })
  )

  const rows: ReceivablesClientRow[] = result.rows.map((row: Record<string, unknown>) => ({
    client_id: Number(row.client_id),
    client_name: String(row.client_name ?? ""),
    client_code: row.client_code ? String(row.client_code) : null,
    open_invoices: num(row.open_invoices),
    overdue_invoices: num(row.overdue_invoices),
    oldest_due_date: row.oldest_due_date ? String(row.oldest_due_date) : null,
    days_oldest: num(row.days_oldest),
    billed: num(row.billed),
    collected: num(row.collected),
    credit_notes: num(row.credit_notes),
    outstanding: num(row.outstanding),
    overdue: num(row.overdue),
    current: num(row.current),
    bucket_1_30: num(row.bucket_1_30),
    bucket_31_60: num(row.bucket_31_60),
    bucket_61_90: num(row.bucket_61_90),
    bucket_90_plus: num(row.bucket_90_plus),
  }))

  return { rows, totals: totalsOf(rows), asOf }
}

function emptyTotals(): ReceivablesTotals {
  return {
    clients: 0,
    open_invoices: 0,
    overdue_invoices: 0,
    billed: 0,
    collected: 0,
    credit_notes: 0,
    outstanding: 0,
    overdue: 0,
    days_oldest: 0,
    ...EMPTY_AGING,
  }
}

/** Totals are folded in JS, not a second SQL pass, so they always match the rows shown. */
export function totalsOf(rows: ReceivablesClientRow[]): ReceivablesTotals {
  return rows.reduce<ReceivablesTotals>((acc, row) => {
    acc.clients += 1
    acc.open_invoices += row.open_invoices
    acc.overdue_invoices += row.overdue_invoices
    acc.billed += row.billed
    acc.collected += row.collected
    acc.credit_notes += row.credit_notes
    acc.outstanding += row.outstanding
    acc.overdue += row.overdue
    acc.days_oldest = Math.max(acc.days_oldest, row.days_oldest)
    for (const bucket of AGING_BUCKETS) acc[bucket.key] += row[bucket.key]
    return acc
  }, emptyTotals())
}

/**
 * The open items behind one client's outstanding — the receivables drill-down
 * and the body of the Statement of Account. Oldest first: that is the order a
 * collections call works through, and the order a client reads a statement in.
 */
export const OPEN_ITEMS_SQL = `
  WITH scoped AS (${SCOPED_INVOICES_SQL})
  SELECT
    s.id,
    s.invoice_number,
    s.invoice_date::text AS invoice_date,
    s.due_date::text AS due_date,
    s.billing_period,
    s.days_overdue,
    s.grand_total,
    s.paid_amount,
    s.credit_note_total,
    s.balance,
    s.status
  FROM scoped s
  WHERE s.balance > 0
  ORDER BY s.due_date ASC, s.id ASC`

/**
 * Exported so the Statement of Account builder can run the same query on the
 * transaction-scoped client the document engine hands it, instead of reaching
 * for the pool and losing the tenant context that transaction carries.
 */
export function mapOpenInvoiceRow(row: Record<string, unknown>): OpenInvoiceRow {
  const days = num(row.days_overdue)
  return {
    id: Number(row.id),
    invoice_number: String(row.invoice_number ?? ""),
    invoice_date: String(row.invoice_date ?? ""),
    due_date: String(row.due_date ?? ""),
    billing_period: row.billing_period ? String(row.billing_period) : null,
    days_overdue: days,
    bucket: bucketFor(days),
    grand_total: num(row.grand_total),
    paid_amount: num(row.paid_amount),
    credit_note_total: num(row.credit_note_total),
    balance: num(row.balance),
    status: String(row.status ?? ""),
  }
}

/** Params for SCOPED_INVOICES_SQL and OPEN_ITEMS_SQL, in order. */
export function scopedParams(
  companyId: number,
  clientId: number | null,
  filters: ReceivablesFilters = {}
): unknown[] {
  return [companyId, resolveAsOf(filters.asOf), filters.warehouseId ?? null, clientId]
}

export async function openInvoicesForClient(
  companyId: number,
  clientId: number,
  filters: ReceivablesFilters = {}
): Promise<{ rows: OpenInvoiceRow[]; asOf: string }> {
  const asOf = resolveAsOf(filters.asOf)
  if (!(await invoiceTableExists())) return { rows: [], asOf }

  const result = await query(OPEN_ITEMS_SQL, scopedParams(companyId, clientId, { ...filters, asOf }))
  return { rows: result.rows.map(mapOpenInvoiceRow), asOf }
}

/**
 * Aging for a single client, folded from its open items. Used by the portal and
 * the statement, both of which already need the line list, so this costs no
 * extra round trip.
 */
export function agingOf(rows: Array<{ days_overdue: number; balance: number }>): AgingBuckets {
  const buckets: AgingBuckets = { ...EMPTY_AGING }
  for (const row of rows) {
    if (row.balance <= 0) continue
    buckets[bucketFor(row.days_overdue)] += row.balance
  }
  return buckets
}
