import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

/**
 * Resolve a scanned barcode during packing or loading.
 *
 * Deliberately read-only. The pack/load mutations themselves are the shared
 * /api/do/* endpoints -- mobile bearer tokens resolve through the same
 * getSession(), so there is no second implementation of the packing rules to
 * drift out of sync with the web one.
 *
 * Accepts either a pack unit code (PU-... or a tenant's own pallet ID) or a
 * stock serial number, and tells the handheld what it may do with it next.
 */
const lookupSchema = z.object({
  barcode: z.string().trim().min(1).max(128),
  do_id: z.number().positive().optional(),
})

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")

    const payload = lookupSchema.parse(await request.json())
    // setTenantContext sets app.company_id with is_local = true, so it lasts only
    // to the end of the current transaction. Without this BEGIN it reverted after
    // its own statement, RLS filtered both lookups to zero rows, and every scan
    // came back NOT_FOUND regardless of the barcode.
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const packUnit = await db.query(
      `SELECT u.id, u.pack_code, u.pack_type, u.status, u.total_quantity,
              u.do_header_id, d.do_number, d.status AS do_status,
              (gi.pack_unit_id IS NOT NULL) AS is_issued,
              (lp.pack_unit_id IS NOT NULL) AS is_loaded
       FROM do_pack_units u
       JOIN do_header d ON d.id = u.do_header_id AND d.company_id = u.company_id
       LEFT JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       LEFT JOIN outbound_load_pack_units lp
         ON lp.pack_unit_id = u.id AND lp.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.pack_code = $2
         AND ($3::int IS NULL OR u.do_header_id = $3)
       LIMIT 1`,
      [session.companyId, payload.barcode, payload.do_id ?? null]
    )

    if (packUnit.rows.length) {
      const row = packUnit.rows[0]
      const isIssued = row.is_issued === true
      const isLoaded = row.is_loaded === true
      await db.query("COMMIT")
      return ok({
        match: "PACK_UNIT",
        pack_unit: row,
        // What the handheld should offer next, so the UI does not have to
        // re-derive the workflow rules.
        can_close: String(row.status) === "OPEN",
        can_issue: String(row.status) === "CLOSED" && !isIssued,
        can_load: String(row.status) === "CLOSED" && isIssued && !isLoaded,
      })
    }

    const serial = await db.query(
      `SELECT s.id, s.serial_number, s.item_id, s.status, s.warehouse_id, s.client_id,
              s.bin_location, s.lp_record_id,
              i.item_code, i.item_name,
              pus.pack_unit_id
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       LEFT JOIN do_pack_unit_serials pus
         ON pus.serial_id = s.id AND pus.company_id = s.company_id
       WHERE s.company_id = $1
         AND s.serial_number = $2
       LIMIT 1`,
      [session.companyId, payload.barcode]
    )

    if (serial.rows.length) {
      const row = serial.rows[0]
      const status = String(row.status)
      const alreadyPacked = row.pack_unit_id != null
      await db.query("COMMIT")
      return ok({
        match: "SERIAL",
        serial: row,
        can_pack: !alreadyPacked && (status === "IN_STOCK" || status === "RESERVED"),
        already_packed: alreadyPacked,
      })
    }

    await db.query("COMMIT")
    return fail("NOT_FOUND", `No pack unit or serial matches barcode ${payload.barcode}`, 404)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Barcode lookup failed"
    return fail("SCAN_LOOKUP_FAILED", message, 400)
  } finally {
    db.release()
  }
}