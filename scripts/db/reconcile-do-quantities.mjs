import process from "node:process"
import pg from "pg"

const { Client } = pg

function getDatabaseUrl() {
  const value = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL
  if (!value || !String(value).trim()) {
    throw new Error("Missing MIGRATOR_DATABASE_URL or DATABASE_URL")
  }
  return String(value)
}

function isApplyMode() {
  return process.argv.includes("--apply")
}

async function fetchMismatches(client) {
  const sql = `
    SELECT
      dh.id,
      dh.company_id,
      dh.do_number,
      dh.status,
      dh.invoice_qty,
      dh.dispatched_qty,
      dh.total_quantity_dispatched,
      COALESCE(lines.total_dispatched, 0)::int AS line_total_dispatched,
      dh.quantity_difference
    FROM do_header dh
    LEFT JOIN (
      SELECT
        company_id,
        do_header_id,
        COALESCE(SUM(quantity_dispatched), 0)::int AS total_dispatched
      FROM do_line_items
      GROUP BY company_id, do_header_id
    ) lines
      ON lines.company_id = dh.company_id
     AND lines.do_header_id = dh.id
    WHERE
      COALESCE(dh.total_quantity_dispatched, 0) <> COALESCE(lines.total_dispatched, 0)
      OR COALESCE(dh.dispatched_qty, 0) <> COALESCE(lines.total_dispatched, 0)
      OR (
        dh.invoice_qty IS NOT NULL
        AND COALESCE(dh.quantity_difference, 0) <> (dh.invoice_qty - COALESCE(lines.total_dispatched, 0))
      )
      OR (
        dh.invoice_qty IS NULL
        AND dh.quantity_difference IS NOT NULL
      )
    ORDER BY dh.id ASC
  `
  const res = await client.query(sql)
  return res.rows
}

async function applyFixes(client, rows) {
  let updated = 0
  for (const row of rows) {
    const lineTotal = Number(row.line_total_dispatched || 0)
    const invoiceQty = row.invoice_qty == null ? null : Number(row.invoice_qty)
    const quantityDifference = invoiceQty == null ? null : invoiceQty - lineTotal

    await client.query(
      `UPDATE do_header
       SET total_quantity_dispatched = $1,
           dispatched_qty = $1,
           quantity_difference = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $3
         AND id = $4`,
      [lineTotal, quantityDifference, Number(row.company_id), Number(row.id)]
    )
    updated += 1
  }
  return updated
}

async function main() {
  const apply = isApplyMode()
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    const mismatches = await fetchMismatches(client)
    if (mismatches.length === 0) {
      console.log("No DO quantity mismatches found.")
      return
    }

    console.log(`Found ${mismatches.length} mismatched DO record(s):`)
    for (const row of mismatches.slice(0, 20)) {
      console.log(
        [
          `id=${row.id}`,
          `do=${row.do_number}`,
          `status=${row.status}`,
          `invoice_qty=${row.invoice_qty ?? "null"}`,
          `dispatched_qty=${row.dispatched_qty ?? "null"}`,
          `total_quantity_dispatched=${row.total_quantity_dispatched ?? "null"}`,
          `line_total_dispatched=${row.line_total_dispatched}`,
          `quantity_difference=${row.quantity_difference ?? "null"}`,
        ].join(" | ")
      )
    }
    if (mismatches.length > 20) {
      console.log(`...and ${mismatches.length - 20} more`)
    }

    if (!apply) {
      console.log("Dry-run complete. Re-run with --apply to update records.")
      return
    }

    await client.query("BEGIN")
    const updated = await applyFixes(client, mismatches)
    await client.query("COMMIT")
    console.log(`Updated ${updated} DO record(s).`)
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
