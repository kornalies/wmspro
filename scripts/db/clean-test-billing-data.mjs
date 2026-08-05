// Removes billing artefacts left behind by the test suites.
//
// Two suites write invoices into whatever database they are pointed at and never
// clean up, so a dev environment slowly fills with invoices dated 2099 and later
// that show up in the finance register alongside real ones:
//
//   * tests/chaos/finance-hardening.mjs  -> INV-HARD-* / INV-VOID-* (far-future
//     periods, chosen so they cannot collide with real billing periods)
//   * a scheduled-run test using a far-future run_date -> storage snapshots and
//     UNRATED storage charges for that date, plus the real invoices the cycle run
//     then raised over those fixture charges
//
// Both sources are fixed at the root now; this clears what they already wrote.
//
//   node scripts/db/run-with-env.mjs scripts/db/clean-test-billing-data.mjs
//   node scripts/db/run-with-env.mjs scripts/db/clean-test-billing-data.mjs --apply
//
// Dry run by default. It never touches anything dated before CUTOFF except the
// two fixture invoice-number series, so real billing history is out of reach.
import pg from "pg"
import process from "node:process"

const APPLY = process.argv.includes("--apply")
// Fixture data is deliberately parked far in the future to stay clear of real
// periods. Nothing legitimate is dated 2090+.
const CUTOFF = "2090-01-01"

const client = new pg.Client({
  connectionString: process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL,
})
await client.connect()

const counts = {}
async function report(label, sql, params = []) {
  const res = await client.query(sql, params)
  counts[label] = res.rows[0]?.n ?? 0
  return counts[label]
}

try {
  await client.query("BEGIN")
  // Superuser-free connection: these tables are RLS-protected, so every company
  // has to be visited under its own tenant context.
  const companies = await client.query("SELECT id, company_code FROM companies ORDER BY id")

  for (const company of companies.rows) {
    await client.query("SELECT set_config('app.company_id', $1, true)", [String(company.id)])

    const targets = await client.query(
      `SELECT id, invoice_number, period_from::text AS period_from, grand_total::text AS grand_total
         FROM invoice_header
        WHERE invoice_number LIKE 'INV-HARD-%'
           OR invoice_number LIKE 'INV-VOID-%'
           OR period_from >= $1::date`,
      [CUTOFF]
    )
    const ids = targets.rows.map((r) => r.id)

    if (ids.length) {
      console.log(`\n${company.company_code} (company ${company.id}): ${ids.length} invoice(s)`)
      for (const row of targets.rows.slice(0, 5)) {
        console.log(`  ${row.invoice_number}  period ${row.period_from}  total ${row.grand_total}`)
      }
      if (targets.rows.length > 5) console.log(`  ... and ${targets.rows.length - 5} more`)
    }

    const scope = [company.id, ids.length ? ids : [0], CUTOFF]

    await report(
      `${company.company_code}:invoice_lines`,
      `SELECT COUNT(*)::int AS n FROM invoice_lines WHERE company_id = $1 AND invoice_id = ANY($2::int[])`,
      [scope[0], scope[1]]
    )
    await report(
      `${company.company_code}:invoice_payments`,
      `SELECT COUNT(*)::int AS n FROM invoice_payments WHERE company_id = $1 AND invoice_id = ANY($2::int[])`,
      [scope[0], scope[1]]
    )
    await report(
      `${company.company_code}:billing_transactions`,
      `SELECT COUNT(*)::int AS n FROM billing_transactions
        WHERE company_id = $1 AND (invoice_id = ANY($2::int[]) OR event_date >= $3::date)`,
      scope
    )
    await report(
      `${company.company_code}:storage_snapshot`,
      `SELECT COUNT(*)::int AS n FROM storage_snapshot WHERE company_id = $1 AND snapshot_date >= $2::date`,
      [company.id, CUTOFF]
    )
    await report(
      `${company.company_code}:billing_job_runs`,
      `SELECT COUNT(*)::int AS n FROM billing_job_runs
        WHERE company_id = $1 AND run_key ~ 'CRON-.*-(20[9-9][0-9]|2[1-9][0-9][0-9])-'`,
      [scope[0]]
    )
    counts[`${company.company_code}:invoice_header`] = ids.length

    if (!APPLY) continue

    // Children first. billing_transactions are DELETED rather than released back
    // to UNBILLED: unlike the invoice-regeneration case, these charges are
    // fixtures themselves, and releasing them would just leave them waiting to be
    // billed onto the next invoice.
    if (ids.length) {
      await client.query(`DELETE FROM invoice_lines WHERE company_id = $1 AND invoice_id = ANY($2::int[])`, [
        company.id,
        ids,
      ])
      await client.query(`DELETE FROM invoice_payments WHERE company_id = $1 AND invoice_id = ANY($2::int[])`, [
        company.id,
        ids,
      ])
    }
    await client.query(
      `DELETE FROM billing_transactions
        WHERE company_id = $1 AND (invoice_id = ANY($2::int[]) OR event_date >= $3::date)`,
      scope
    )
    await client.query(
      `DELETE FROM storage_snapshot WHERE company_id = $1 AND snapshot_date >= $2::date`,
      [company.id, CUTOFF]
    )
    await client.query(
      `DELETE FROM billing_job_runs
        WHERE company_id = $1 AND run_key ~ 'CRON-.*-(20[9-9][0-9]|2[1-9][0-9][0-9])-'`,
      [company.id]
    )
    if (ids.length) {
      await client.query(`DELETE FROM invoice_header WHERE company_id = $1 AND id = ANY($2::int[])`, [
        company.id,
        ids,
      ])
    }
  }

  console.log(`\n--- ${APPLY ? "DELETED" : "WOULD DELETE"} ---`)
  for (const [label, n] of Object.entries(counts)) {
    if (n) console.log(`${String(n).padStart(5)}  ${label}`)
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) console.log("nothing to clean")

  await client.query("COMMIT")
  if (!APPLY && total) console.log("\nDry run. Re-run with --apply to delete.")
} catch (error) {
  await client.query("ROLLBACK")
  throw error
} finally {
  await client.end()
}
