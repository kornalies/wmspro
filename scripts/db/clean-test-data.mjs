// Removes what the test suites leave behind in a dev database.
//
// Suites write into whatever database they are pointed at, and for a long time
// none of them cleaned up. Two symptoms, both visible to anyone using the app:
//
//   BILLING -- invoices dated 2099 and later in the finance register.
//     * tests/chaos/finance-hardening.mjs -> INV-HARD-* / INV-VOID-*, parked far
//       in the future so their periods cannot collide with real ones
//     * a scheduled-run test using a far-future run_date -> storage snapshots and
//       UNRATED charges for that date, plus the invoices the cycle run then
//       raised over those fixture charges
//
//   STOCK -- throwaway items in Stock Search among real inventory.
//     * tests/allocation.mjs -> ITM-ALLOC-*, one per scenario, eight per run
//     * tests/documents.mjs  -> ITM-DOCS-* and ITM-GRN-*
//     * tests/lots.mjs       -> ITM-LOT-*
//
// Every source is fixed at the root now (the suites tear their own fixtures down
// via deleteTestFixtures in tests/chaos/_shared.mjs); this clears what they
// already wrote.
//
//   npm run db:clean-test-data
//   npm run db:clean-test-data:apply
//
// Dry run by default. It only ever touches rows dated 2090+, the two fixture
// invoice-number series, and items whose code matches a suite's prefix -- real
// history and real master data are out of reach.
import pg from "pg"
import process from "node:process"

const APPLY = process.argv.includes("--apply")
// Fixture data is deliberately parked far in the future to stay clear of real
// periods. Nothing legitimate is dated 2090+.
const CUTOFF = "2090-01-01"
// Prefixes each suite gives its throwaway items. Deliberately specific: a
// pattern like 'ITM-%' would match real master data.
const TEST_ITEM_PREFIXES = ["ITM-ALLOC-", "ITM-DOCS-", "ITM-GRN-", "ITM-LOT-", "ITM-TAIL-"]

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

  // -------------------------------------------------------------------------
  // Throwaway stock items, and everything hanging off them.
  // -------------------------------------------------------------------------
  for (const company of companies.rows) {
    await client.query("SELECT set_config('app.company_id', $1, true)", [String(company.id)])

    const itemsRes = await client.query(
      `SELECT id, item_code FROM items
        WHERE company_id = $1
          AND ($2::text[] IS NOT NULL)
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE items.item_code LIKE p || '%')
        ORDER BY id`,
      [company.id, TEST_ITEM_PREFIXES]
    )
    const itemIds = itemsRes.rows.map((r) => r.id)
    if (!itemIds.length) continue

    console.log(`\n${company.company_code} (company ${company.id}): ${itemIds.length} test item(s)`)
    for (const row of itemsRes.rows.slice(0, 5)) console.log(`  ${row.item_code}`)
    if (itemsRes.rows.length > 5) console.log(`  ... and ${itemsRes.rows.length - 5} more`)

    // The DOs and GRNs these items appear on. Only documents whose EVERY line is
    // a test item are removed: a test item that somehow reached a real document
    // is left alone rather than taking the document with it.
    const docs = await client.query(
      `SELECT
         (SELECT COALESCE(array_agg(DISTINCT dl.do_header_id), '{}')
            FROM do_line_items dl
           WHERE dl.company_id = $1 AND dl.item_id = ANY($2::int[])
             AND NOT EXISTS (
               SELECT 1 FROM do_line_items o
                WHERE o.do_header_id = dl.do_header_id AND NOT (o.item_id = ANY($2::int[]))
             )) AS do_ids,
         (SELECT COALESCE(array_agg(DISTINCT gl.grn_header_id), '{}')
            FROM grn_line_items gl
           WHERE gl.company_id = $1 AND gl.item_id = ANY($2::int[])
             AND NOT EXISTS (
               SELECT 1 FROM grn_line_items o
                WHERE o.grn_header_id = gl.grn_header_id AND NOT (o.item_id = ANY($2::int[]))
             )) AS grn_ids`,
      [company.id, itemIds]
    )
    const doIds = docs.rows[0]?.do_ids ?? []
    const grnIds = docs.rows[0]?.grn_ids ?? []

    await report(
      `${company.company_code}:stock_serial_numbers`,
      `SELECT COUNT(*)::int AS n FROM stock_serial_numbers WHERE company_id = $1 AND item_id = ANY($2::int[])`,
      [company.id, itemIds]
    )
    await report(
      `${company.company_code}:stock_movements`,
      `SELECT COUNT(*)::int AS n FROM stock_movements WHERE company_id = $1 AND item_id = ANY($2::int[])`,
      [company.id, itemIds]
    )
    counts[`${company.company_code}:do_header`] = doIds.length
    counts[`${company.company_code}:grn_header`] = grnIds.length
    counts[`${company.company_code}:items`] = itemIds.length

    if (!APPLY) continue

    if (doIds.length) {
      await client.query(`DELETE FROM gate_out WHERE company_id = $1 AND do_header_id = ANY($2::int[])`, [
        company.id,
        doIds,
      ])
      await client.query(
        `DELETE FROM billing_transactions
          WHERE company_id = $1 AND source_type = 'DO' AND source_doc_id = ANY($2::int[])`,
        [company.id, doIds]
      )
    }
    if (grnIds.length) {
      await client.query(
        `DELETE FROM billing_transactions
          WHERE company_id = $1 AND source_type = 'GRN' AND source_doc_id = ANY($2::int[])`,
        [company.id, grnIds]
      )
    }
    // Packed serials reference stock_serial_numbers, and a load references the
    // pack unit. Unwind the outbound tail before the stock it points at.
    await client.query(
      `DELETE FROM outbound_load_pack_units
        WHERE company_id = $1
          AND pack_unit_id IN (
            SELECT pu.id FROM do_pack_units pu WHERE pu.company_id = $1 AND pu.do_header_id = ANY($2::int[])
          )`,
      [company.id, doIds.length ? doIds : [0]]
    )
    await client.query(
      `DELETE FROM do_pack_unit_serials
        WHERE company_id = $1
          AND serial_id IN (
            SELECT s.id FROM stock_serial_numbers s WHERE s.company_id = $1 AND s.item_id = ANY($2::int[])
          )`,
      [company.id, itemIds]
    )
    await client.query(`DELETE FROM do_pack_units WHERE company_id = $1 AND do_header_id = ANY($2::int[])`, [
      company.id,
      doIds.length ? doIds : [0],
    ])
    await client.query(`DELETE FROM stock_movements WHERE company_id = $1 AND item_id = ANY($2::int[])`, [
      company.id,
      itemIds,
    ])
    await client.query(
      `DELETE FROM stock_serial_numbers WHERE company_id = $1 AND item_id = ANY($2::int[])`,
      [company.id, itemIds]
    )
    await client.query(`DELETE FROM do_line_items WHERE company_id = $1 AND item_id = ANY($2::int[])`, [
      company.id,
      itemIds,
    ])
    await client.query(`DELETE FROM grn_line_items WHERE company_id = $1 AND item_id = ANY($2::int[])`, [
      company.id,
      itemIds,
    ])
    if (doIds.length) {
      await client.query(`DELETE FROM do_header WHERE company_id = $1 AND id = ANY($2::int[])`, [
        company.id,
        doIds,
      ])
    }
    if (grnIds.length) {
      await client.query(`DELETE FROM grn_header WHERE company_id = $1 AND id = ANY($2::int[])`, [
        company.id,
        grnIds,
      ])
    }
    // Storage snapshots reference the item, and the nightly job takes one for
    // whatever is in stock -- including a suite's throwaway item if it existed
    // when the job ran. They are counts of stock that no longer exists.
    await client.query(`DELETE FROM storage_snapshot WHERE company_id = $1 AND item_id = ANY($2::int[])`, [
      company.id,
      itemIds,
    ])
    await client.query(`DELETE FROM items WHERE company_id = $1 AND id = ANY($2::int[])`, [
      company.id,
      itemIds,
    ])
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
