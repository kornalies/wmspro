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
//     * tests/chaos/_shared.mjs -> ITM-DEF (company A) and ITM-DEM (company B),
//       the tenant-isolation marker items. Every DO-WH-DEF-* / GRN-WH-DEF-*
//       document hangs off these.
//
//   DOCUMENTS -- test delivery orders with no test item to key off: either they
//     carry no lines at all, or they were built over real master data. Matched
//     by document number instead, and only when nothing is stocked against them.
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
const TEST_ITEM_PREFIXES = ["ITM-ALLOC-", "ITM-DOCS-", "ITM-GRN-", "ITM-LOT-", "ITM-TAIL-", "ITM-DEF", "ITM-DEM"]
// Test DOs that carry no test item to key off. Matched on document number, and
// only removed when no stock is recorded against them -- see the guard below.
// DO-GWU-CI-STAGED-001 is deliberately absent: the copy that leaked into the
// DEFAULT company backs a 99.00 charge on a FINALIZED invoice, so it stays.
const TEST_DO_PATTERNS = ["DO-DEF-CHAOS", "DO-DEM-CHAOS", "DO-LOT-%", "DO-ITEM3-%"]

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
    // Transfers, adjustments and putaway all reference the serial without
    // cascading. A suite item can reach them (ITM-DEF is the chaos marker and
    // gets used well beyond the outbound path), so unwind them before the
    // serials they point at.
    for (const table of ["stock_transfer_serials", "inventory_adjustment_serials"]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE company_id = $1
            AND serial_id IN (
              SELECT s.id FROM stock_serial_numbers s WHERE s.company_id = $1 AND s.item_id = ANY($2::int[]))`,
        [company.id, itemIds]
      )
    }
    await client.query(
      `DELETE FROM stock_putaway_movements
        WHERE company_id = $1
          AND stock_serial_id IN (
            SELECT s.id FROM stock_serial_numbers s WHERE s.company_id = $1 AND s.item_id = ANY($2::int[]))`,
      [company.id, itemIds]
    )
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
    // Inventory adjustments over a test item. Same rule as the documents above:
    // the header goes only when every one of its lines is a test item, so an
    // adjustment that also touched real stock keeps its document.
    const adjRes = await client.query(
      `SELECT DISTINCT al.adjustment_id AS id
         FROM inventory_adjustment_lines al
        WHERE al.company_id = $1 AND al.item_id = ANY($2::int[])
          AND NOT EXISTS (
            SELECT 1 FROM inventory_adjustment_lines o
             WHERE o.adjustment_id = al.adjustment_id AND NOT (o.item_id = ANY($2::int[])))`,
      [company.id, itemIds]
    )
    const adjIds = adjRes.rows.map((r) => r.id)
    await client.query(
      `DELETE FROM inventory_adjustment_lines WHERE company_id = $1 AND item_id = ANY($2::int[])`,
      [company.id, itemIds]
    )
    if (adjIds.length) {
      counts[`${company.company_code}:inventory_adjustments`] = adjIds.length
      await client.query(`DELETE FROM inventory_adjustment_header WHERE company_id = $1 AND id = ANY($2::int[])`, [
        company.id,
        adjIds,
      ])
    }
    // Remaining item-keyed references. Most cascade off a document that is
    // already gone by now; these clear the stragglers left by a test item that
    // reached a document real enough to keep.
    for (const table of [
      "stock_transfer_lines",
      "asn_carton_details",
      "asn_line_items",
      "delivery_note_lines",
      "do_pick_tasks",
      "stock_batch_status",
      "client_rate_details",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE item_id = ANY($1::int[])`, [itemIds])
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

  // -------------------------------------------------------------------------
  // Test delivery orders matched by document number. These have no test item to
  // key off -- most carry no lines at all, and one was built over real master
  // data. The guard is stock, not naming: a DO with a serial or a movement
  // against it moved real inventory, so it is left alone rather than deleted.
  // -------------------------------------------------------------------------
  for (const company of companies.rows) {
    await client.query("SELECT set_config('app.company_id', $1, true)", [String(company.id)])

    const dosRes = await client.query(
      `SELECT h.id, h.do_number, h.status
         FROM do_header h
        WHERE h.company_id = $1
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE h.do_number LIKE p)
          AND NOT EXISTS (
            SELECT 1 FROM stock_movements m WHERE m.company_id = $1 AND m.do_header_id = h.id)
          AND NOT EXISTS (
            SELECT 1 FROM stock_serial_numbers s
             WHERE s.company_id = $1
               AND s.do_line_item_id IN (SELECT l.id FROM do_line_items l WHERE l.do_header_id = h.id))
        ORDER BY h.id`,
      [company.id, TEST_DO_PATTERNS]
    )
    const doIds = dosRes.rows.map((r) => r.id)
    if (!doIds.length) continue

    console.log(`\n${company.company_code} (company ${company.id}): ${doIds.length} test DO(s) by number`)
    for (const row of dosRes.rows) console.log(`  ${row.do_number}  ${row.status}`)

    counts[`${company.company_code}:do_header(by-number)`] = doIds.length
    await report(
      `${company.company_code}:do_line_items(by-number)`,
      `SELECT COUNT(*)::int AS n FROM do_line_items WHERE company_id = $1 AND do_header_id = ANY($2::int[])`,
      [company.id, doIds]
    )

    if (!APPLY) continue

    // gate_out and billing_transactions point at the DO without cascading; the
    // rest of the outbound tail (pack units, loads, picks, waves, goods issue,
    // delivery note, lines) cascades off do_header.
    await client.query(`DELETE FROM gate_out WHERE company_id = $1 AND do_header_id = ANY($2::int[])`, [
      company.id,
      doIds,
    ])
    await client.query(
      `DELETE FROM billing_transactions
        WHERE company_id = $1 AND source_type = 'DO' AND source_doc_id = ANY($2::int[])`,
      [company.id, doIds]
    )
    await client.query(`DELETE FROM do_header WHERE company_id = $1 AND id = ANY($2::int[])`, [company.id, doIds])
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
