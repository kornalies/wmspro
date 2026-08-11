/**
 * Receivables acceptance: client-wise outstanding, ageing, and the Statement of
 * Account document.
 *
 * The failure mode that matters here is a plausible-looking number. An aging
 * report that silently counts a draft invoice, or whose buckets do not add up to
 * the outstanding it prints beside them, looks correct on screen and is wrong in
 * a collections call — so every assertion ties a figure to something else that
 * must agree with it, rather than to a hardcoded expectation alone.
 *
 * Runs against a dedicated client seeded for this run, because the tenant-A
 * fixture client carries invoices from every other finance suite and none of
 * these totals would be stable next to them.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import { BASE_URL, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const CLIENT_CODE = `CL-AR-${SUFFIX}`

let failures = 0
function check(label, condition, extra = "") {
  const status = condition ? "PASS" : "FAIL"
  console.log(`${status}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

/** Money comparisons go through this — pg returns numerics as strings. */
function money(value) {
  return Math.round(Number(value ?? 0) * 100) / 100
}

async function api(path, { token } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

async function login(fixtures) {
  const res = await fetch(`${BASE_URL}/mobile/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_code: fixtures.tenantA.code,
      username: fixtures.tenantA.username,
      password: fixtures.tenantA.password,
    }),
  })
  const json = await res.json()
  if (!json?.data?.access_token) throw new Error(`login failed: ${JSON.stringify(json)}`)
  return json.data.access_token
}

/**
 * Six invoices spanning every case the aggregation has to get right: one in each
 * of three age bands, one settled, one draft and one void.
 *
 * Due dates are expressed as offsets from today so the buckets stay meaningful
 * whenever the suite is run, and none of them is parked in the future beyond the
 * one deliberately not-yet-due invoice.
 */
const SEED = [
  { key: "old", dueOffset: -100, grand: 10000, paid: 0, balance: 10000, status: "FINALIZED" },
  { key: "mid", dueOffset: -45, grand: 5000, paid: 2000, balance: 3000, status: "FINALIZED" },
  { key: "young", dueOffset: -10, grand: 4000, paid: 0, balance: 4000, status: "SENT" },
  { key: "future", dueOffset: 15, grand: 2000, paid: 0, balance: 2000, status: "FINALIZED" },
  { key: "settled", dueOffset: -20, grand: 1000, paid: 1000, balance: 0, status: "PAID" },
  { key: "draft", dueOffset: -5, grand: 9999, paid: 0, balance: 9999, status: "DRAFT" },
  { key: "void", dueOffset: -5, grand: 7777, paid: 0, balance: 7777, status: "VOID" },
]

const EXPECTED = {
  outstanding: 19000, // old + mid + young + future
  overdue: 17000, // everything except the not-yet-due one
  open: 4,
  current: 2000,
  bucket_1_30: 4000,
  bucket_31_60: 3000,
  bucket_90_plus: 10000,
}

async function seed(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    await db.query("BEGIN")
    try {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      const client = await db.query(
        `INSERT INTO clients (company_id, client_code, client_name, city, state, is_active)
         VALUES ($1, $2, $3, 'Chennai', 'Tamil Nadu', true)
         RETURNING id`,
        [companyId, CLIENT_CODE, `Receivables test ${CLIENT_CODE}`]
      )
      const clientId = Number(client.rows[0].id)

      const invoiceIds = {}
      for (const [index, row] of SEED.entries()) {
        const inserted = await db.query(
          `INSERT INTO invoice_header (
             company_id, invoice_number, client_id, billing_cycle, billing_period,
             period_from, period_to, invoice_date, due_date, currency,
             taxable_amount, cgst_amount, sgst_amount, igst_amount,
             total_tax_amount, grand_total, paid_amount, balance_amount, status
           ) VALUES (
             $1, $2, $3, 'MONTHLY', 'Receivables Test',
             -- uq_invoice_header_company_client_period is (company, client,
             -- period_from, period_to), and two of these rows share a due date,
             -- so the row index shifts each period into its own slot.
             CURRENT_DATE + ($4::int - 30 - $9::int), CURRENT_DATE + ($4::int - $9::int),
             CURRENT_DATE + ($4::int - 30), CURRENT_DATE + $4::int, 'INR',
             $5, 0, 0, 0, 0, $5, $6, $7, $8
           )
           RETURNING id`,
          [
            companyId,
            `INV-AR-${SUFFIX}-${row.key}`,
            clientId,
            row.dueOffset,
            row.grand,
            row.paid,
            row.balance,
            row.status,
            index,
          ]
        )
        invoiceIds[row.key] = Number(inserted.rows[0].id)
      }

      await db.query("COMMIT")
      return { companyId, clientId, invoiceIds }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

/**
 * Issue a credit note the way the credit-note route does — insert the header and
 * decrement the invoice balance — so the aggregation is tested against the shape
 * the application actually writes.
 */
async function issueCreditNote(companyId, clientId, invoiceId, amount) {
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query(
      `INSERT INTO credit_note_header (
         company_id, note_number, invoice_id, client_id, note_date, reason,
         taxable_amount, cgst_amount, sgst_amount, igst_amount, total_tax_amount,
         grand_total, status
       ) VALUES ($1, $2, $3, $4, CURRENT_DATE, 'Receivables test credit', $5, 0, 0, 0, 0, $5, 'ISSUED')`,
      [companyId, `CN-AR-${SUFFIX}`, invoiceId, clientId, amount]
    )
    await db.query(
      `UPDATE invoice_header
          SET balance_amount = GREATEST(balance_amount - $1, 0)
        WHERE company_id = $2 AND id = $3`,
      [amount, companyId, invoiceId]
    )
  })
}

async function cleanup(companyId, clientId) {
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query(`DELETE FROM credit_note_header WHERE company_id = $1 AND client_id = $2`, [
      companyId,
      clientId,
    ])
    await db.query(`DELETE FROM invoice_lines WHERE company_id = $1 AND invoice_id IN (
      SELECT id FROM invoice_header WHERE company_id = $1 AND client_id = $2)`, [companyId, clientId])
    await db.query(`DELETE FROM invoice_payments WHERE company_id = $1 AND invoice_id IN (
      SELECT id FROM invoice_header WHERE company_id = $1 AND client_id = $2)`, [companyId, clientId])
    await db.query(`DELETE FROM invoice_header WHERE company_id = $1 AND client_id = $2`, [
      companyId,
      clientId,
    ])
    await db.query(`DELETE FROM clients WHERE company_id = $1 AND id = $2`, [companyId, clientId])
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const { companyId, clientId, invoiceIds } = await seed(fixtures)

  try {
    // ---- the aggregate ------------------------------------------------------
    const listed = await api("/finance/receivables", { token })
    if (!listed.res.ok) {
      check("receivables endpoint responds", false, `${listed.res.status} ${JSON.stringify(listed.json)}`)
      return
    }
    const rows = listed.json?.data?.rows ?? []
    const row = rows.find((r) => Number(r.client_id) === clientId)
    check("seeded client appears in receivables", !!row, `${rows.length} clients with balance`)
    if (!row) return

    check("outstanding excludes drafts and voids", money(row.outstanding) === EXPECTED.outstanding,
      `got ${money(row.outstanding)} want ${EXPECTED.outstanding}`)
    check("open invoice count excludes settled, draft and void",
      Number(row.open_invoices) === EXPECTED.open, `got ${row.open_invoices} want ${EXPECTED.open}`)
    check("overdue excludes the not-yet-due invoice", money(row.overdue) === EXPECTED.overdue,
      `got ${money(row.overdue)} want ${EXPECTED.overdue}`)

    // Each invoice must land in exactly one band, and the bands must reconstruct
    // the outstanding printed beside them.
    check("not-yet-due bucket", money(row.current) === EXPECTED.current, `got ${money(row.current)}`)
    check("1-30 bucket", money(row.bucket_1_30) === EXPECTED.bucket_1_30, `got ${money(row.bucket_1_30)}`)
    check("31-60 bucket", money(row.bucket_31_60) === EXPECTED.bucket_31_60, `got ${money(row.bucket_31_60)}`)
    check("61-90 bucket is empty", money(row.bucket_61_90) === 0, `got ${money(row.bucket_61_90)}`)
    check("90+ bucket", money(row.bucket_90_plus) === EXPECTED.bucket_90_plus, `got ${money(row.bucket_90_plus)}`)

    const bucketSum = money(
      Number(row.current) + Number(row.bucket_1_30) + Number(row.bucket_31_60) +
      Number(row.bucket_61_90) + Number(row.bucket_90_plus)
    )
    check("buckets sum to outstanding", bucketSum === money(row.outstanding),
      `${bucketSum} vs ${money(row.outstanding)}`)
    check("oldest item is the 100-day invoice", Number(row.days_oldest) === 100, `got ${row.days_oldest}`)

    // ---- agrees with the invoices screen -----------------------------------
    const invoicesRes = await api("/finance/invoices", { token })
    const invoices = (invoicesRes.json?.data?.invoices ?? []).filter(
      (inv) => Number(inv.client_id) === clientId && inv.status !== "DRAFT" && inv.status !== "VOID"
    )
    const invoiceSum = money(invoices.reduce((sum, inv) => sum + Number(inv.balance || 0), 0))
    check("receivables agrees with the invoice list", invoiceSum === money(row.outstanding),
      `invoices ${invoiceSum} vs receivables ${money(row.outstanding)}`)

    // ---- drill-down ---------------------------------------------------------
    const drill = await api(`/finance/receivables?client_id=${clientId}`, { token })
    const openItems = drill.json?.data?.openItems ?? []
    check("drill-down returns the open items", openItems.length === EXPECTED.open,
      `got ${openItems.length} want ${EXPECTED.open}`)
    check("open items are oldest first",
      openItems.every((item, i) => i === 0 || openItems[i - 1].due_date <= item.due_date),
      openItems.map((i) => i.due_date).join(", "))
    check("open items carry no settled, draft or void invoice",
      openItems.every((item) => Number(item.balance) > 0 && !["DRAFT", "VOID"].includes(item.status)),
      openItems.map((i) => i.status).join(", "))
    const oldest = openItems.find((item) => item.days_overdue === 100)
    check("the 100-day item is bucketed at 90+", oldest?.bucket === "bucket_90_plus", oldest?.bucket)

    // ---- as-of re-ages rather than re-filters -------------------------------
    const backdated = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
    const asOf = await api(`/finance/receivables?as_of=${backdated}&client_id=${clientId}`, { token })
    const asOfRow = (asOf.json?.data?.rows ?? []).find((r) => Number(r.client_id) === clientId)
    check("as-of moves the oldest invoice out of 90+",
      money(asOfRow?.bucket_90_plus) === 0 && money(asOfRow?.bucket_31_60) === 10000,
      `90+=${money(asOfRow?.bucket_90_plus)} 31-60=${money(asOfRow?.bucket_31_60)}`)
    check("as-of leaves the total outstanding unchanged",
      money(asOfRow?.outstanding) === EXPECTED.outstanding, `got ${money(asOfRow?.outstanding)}`)

    // ---- statement of account ----------------------------------------------
    const statementRes = await api(`/documents/client-statement/${clientId}`, { token })
    if (!statementRes.res.ok) {
      check("statement builds", false, `${statementRes.res.status} ${JSON.stringify(statementRes.json)}`)
    } else {
      const model = statementRes.json.data
      const table = (model.sections || []).find((s) => s.kind === "table")
      check("statement builds", model.type === "client-statement" && !!model.documentNumber,
        model.documentNumber)
      check("statement lists every open item", (table?.rows?.length ?? 0) === EXPECTED.open,
        `rows=${table?.rows?.length}`)
      check("statement total matches the receivables screen",
        String(table?.totals?.balance ?? "").replace(/,/g, "") === EXPECTED.outstanding.toFixed(2),
        `${table?.totals?.balance} vs ${EXPECTED.outstanding.toFixed(2)}`)
      check("statement carries the tenant letterhead", !!model.branding?.companyName,
        model.branding?.companyName)
      check("statement has an ageing summary",
        (model.sections || []).some((s) => s.kind === "fields" && s.title === "Ageing Summary"))
      check("statement has signature blocks",
        (model.sections || []).some((s) => s.kind === "signatures" && s.blocks.length === 4))
      // A statement is a point-in-time list with no record to verify against, so
      // it must not print a QR that resolves to nothing.
      check("statement carries no verification QR", !model.qr, model.qr?.url)
    }

    // ---- a credit note reduces outstanding ----------------------------------
    await issueCreditNote(companyId, clientId, invoiceIds.old, 4000)
    const afterCredit = await api(`/finance/receivables?client_id=${clientId}`, { token })
    const creditedRow = (afterCredit.json?.data?.rows ?? []).find((r) => Number(r.client_id) === clientId)
    check("credit note reduces outstanding",
      money(creditedRow?.outstanding) === EXPECTED.outstanding - 4000,
      `got ${money(creditedRow?.outstanding)} want ${EXPECTED.outstanding - 4000}`)
    check("credit note is reported separately", money(creditedRow?.credit_notes) === 4000,
      `got ${money(creditedRow?.credit_notes)}`)
    check("credit note ages out of the 90+ bucket, not off the report",
      money(creditedRow?.bucket_90_plus) === 6000, `got ${money(creditedRow?.bucket_90_plus)}`)
  } finally {
    await cleanup(companyId, clientId)
  }

  console.log(failures === 0 ? "\nAll receivables checks passed." : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
