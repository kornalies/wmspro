/**
 * Which outbound path has each tenant actually used?
 *
 * Read-only. Answers the backfill question for the tenant-level fulfilment_path
 * setting: defaulting every company to DISPATCH is only safe if no company has
 * live orders in the tail. Classifies each DO by the evidence it left behind:
 *
 *   DISPATCH — total_quantity_dispatched > 0 and no pack units
 *   TAIL     — has at least one non-cancelled pack unit
 *   BOTH     — has pack units AND dispatched quantity exceeding its packed
 *              serials, i.e. the reconciliation hazard per tail/route.ts:131
 *   NEITHER  — untouched (DRAFT/PENDING), free to adopt either path
 *
 * "dispatched > 0" alone is NOT evidence of the legacy path: delivery-note
 * finalize also writes total_quantity_dispatched (finalize/route.ts:136), so a
 * cleanly completed tail order carries both markers. Only the excess counts.
 *
 * Open orders matter more than closed ones: a COMPLETED DO cannot strand, an
 * open TAIL order under a DISPATCH default can.
 */
import pg from "pg"

const { Client } = pg

const OPEN_STATUSES = ["DRAFT", "PENDING", "PICKED", "PACKED", "STAGED", "ISSUED", "LOADED", "PARTIALLY_FULFILLED"]

const client = new Client({ connectionString: process.env.DATABASE_URL })

function pad(value, width) {
  return String(value ?? "").padEnd(width)
}

function padLeft(value, width) {
  return String(value ?? "").padStart(width)
}

async function main() {
  await client.connect()

  // companies has no RLS, so this read needs no tenant context.
  const companies = await client.query(
    `SELECT id, company_code, company_name, settings->>'outbound_billing_trigger' AS billing_trigger
     FROM companies
     ORDER BY id`
  )

  const rows = []

  for (const company of companies.rows) {
    // is_local = false: session-scoped. With true, outside a BEGIN, the setting
    // dies with this statement and every later SELECT silently returns nothing.
    await client.query("SELECT set_config('app.company_id', $1, false)", [String(company.id)])

    const result = await client.query(
      `WITH classified AS (
         SELECT dh.id,
                dh.status,
                COALESCE(dh.total_quantity_dispatched, 0) AS dispatched,
                (SELECT COUNT(*)::int
                   FROM do_pack_unit_serials s
                   JOIN do_line_items l
                     ON l.id = s.do_line_item_id AND l.company_id = s.company_id
                  WHERE s.company_id = dh.company_id
                    AND l.do_header_id = dh.id) AS packed_serials,
                EXISTS (
                  SELECT 1
                  FROM do_pack_units u
                  WHERE u.company_id = dh.company_id
                    AND u.do_header_id = dh.id
                    AND u.status <> 'CANCELLED'
                ) AS has_pack_units
           FROM do_header dh
          WHERE dh.company_id = $1
       ),
       labelled AS (
         SELECT *,
                CASE
                  WHEN has_pack_units AND dispatched > packed_serials THEN 'BOTH'
                  WHEN has_pack_units THEN 'TAIL'
                  WHEN dispatched > 0 THEN 'DISPATCH'
                  ELSE 'NEITHER'
                END AS path
           FROM classified
       )
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE path = 'DISPATCH')::int AS dispatch_only,
         COUNT(*) FILTER (WHERE path = 'TAIL')::int AS tail_only,
         COUNT(*) FILTER (WHERE path = 'BOTH')::int AS both,
         COUNT(*) FILTER (WHERE path = 'NEITHER')::int AS neither,
         COUNT(*) FILTER (WHERE path = 'TAIL' AND status = ANY($2))::int AS open_tail,
         COUNT(*) FILTER (WHERE path = 'DISPATCH' AND status = ANY($2))::int AS open_dispatch,
         COUNT(*) FILTER (WHERE path = 'BOTH' AND status = ANY($2))::int AS open_both
       FROM labelled`,
      [company.id, OPEN_STATUSES]
    )

    rows.push({ company, stats: result.rows[0] })
  }

  console.log("")
  console.log("DO classification by tenant (all time / open orders)")
  console.log("=".repeat(104))
  console.log(
    pad("id", 4) +
      pad("code", 10) +
      padLeft("DOs", 6) +
      padLeft("dispatch", 12) +
      padLeft("tail", 10) +
      padLeft("BOTH", 8) +
      padLeft("neither", 10) +
      "   " +
      pad("billing_trigger", 16)
  )
  console.log("-".repeat(104))

  let anyBoth = 0
  let anyOpenTail = 0

  for (const { company, stats } of rows) {
    if (Number(stats.total) === 0) continue
    anyBoth += Number(stats.both)
    anyOpenTail += Number(stats.open_tail)
    console.log(
      pad(company.id, 4) +
        pad(company.company_code, 10) +
        padLeft(stats.total, 6) +
        padLeft(`${stats.dispatch_only} (${stats.open_dispatch})`, 12) +
        padLeft(`${stats.tail_only} (${stats.open_tail})`, 10) +
        padLeft(`${stats.both} (${stats.open_both})`, 8) +
        padLeft(stats.neither, 10) +
        "   " +
        pad(company.billing_trigger ?? "(unset→DISPATCH)", 16)
    )
  }

  const emptyTenants = rows.filter((r) => Number(r.stats.total) === 0)
  console.log("-".repeat(104))
  console.log(
    `${emptyTenants.length} tenant(s) with zero DOs: ${emptyTenants.map((r) => r.company.company_code).join(", ") || "none"}`
  )

  // The mixed orders are the ones worth looking at individually -- each is a DO
  // whose fulfilment progress is recorded in two counters at once.
  if (anyBoth > 0) {
    console.log("")
    console.log("Mixed-path DOs (dispatched quantity AND pack units on the same order)")
    console.log("=".repeat(104))
    for (const { company } of rows) {
      await client.query("SELECT set_config('app.company_id', $1, false)", [String(company.id)])
      const mixed = await client.query(
        `SELECT dh.id, dh.do_number, dh.status,
                dh.total_quantity_dispatched,
                (SELECT COUNT(*)::int FROM do_pack_units u
                  WHERE u.company_id = dh.company_id AND u.do_header_id = dh.id
                    AND u.status <> 'CANCELLED') AS pack_units,
                (SELECT COUNT(*)::int FROM do_pack_unit_serials s
                  WHERE s.company_id = dh.company_id
                    AND s.do_line_item_id IN (
                      SELECT l.id FROM do_line_items l
                       WHERE l.company_id = dh.company_id AND l.do_header_id = dh.id
                    )) AS packed_serials
           FROM do_header dh
          WHERE dh.company_id = $1
            AND EXISTS (
              SELECT 1 FROM do_pack_units u
               WHERE u.company_id = dh.company_id AND u.do_header_id = dh.id
                 AND u.status <> 'CANCELLED'
            )
            AND COALESCE(dh.total_quantity_dispatched, 0) > (
              SELECT COUNT(*)::int FROM do_pack_unit_serials s
               JOIN do_line_items l
                 ON l.id = s.do_line_item_id AND l.company_id = s.company_id
               WHERE s.company_id = dh.company_id AND l.do_header_id = dh.id
            )
          ORDER BY dh.id`,
        [company.id]
      )
      for (const row of mixed.rows) {
        console.log(
          `  ${pad(company.company_code, 10)} DO ${pad(row.do_number, 22)} ${pad(row.status, 20)} ` +
            `dispatched=${padLeft(row.total_quantity_dispatched, 5)}  pack_units=${padLeft(row.pack_units, 4)}  packed_serials=${padLeft(row.packed_serials, 5)}`
        )
      }
    }
  }

  console.log("")
  console.log("Backfill verdict")
  console.log("=".repeat(104))
  console.log(`  mixed-path DOs (all time) : ${anyBoth}`)
  console.log(`  OPEN tail-path DOs        : ${anyOpenTail}   <- these strand if their tenant defaults to DISPATCH`)
  console.log("")
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => client.end())
