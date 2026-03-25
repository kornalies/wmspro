import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

const payloadSchema = z.object({
  barcode: z.string().trim().min(1, "barcode is required"),
  warehouse_id: z.number().int().positive().optional(),
})

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = payloadSchema.parse(await request.json())
    const barcode = payload.barcode.trim()
    const likeBarcode = `%${barcode}%`

    const serialRows = await query(
      `SELECT
         ssn.id AS stock_serial_id,
         ssn.serial_number,
         ssn.status,
         ssn.received_date,
         ssn.warehouse_id,
         ssn.client_id,
         i.id AS item_id,
         i.item_code,
         i.item_name,
         i.uom
       FROM stock_serial_numbers ssn
       JOIN items i ON i.id = ssn.item_id
       WHERE (ssn.serial_number = $1 OR ssn.serial_number ILIKE $2)
         AND ($3::int IS NULL OR ssn.warehouse_id = $3)
       ORDER BY ssn.id DESC
       LIMIT 20`,
      [barcode, likeBarcode, payload.warehouse_id ?? null]
    )

    if (serialRows.rows.length > 0) {
      return ok({
        barcode,
        match_type: "SERIAL",
        matches: serialRows.rows,
      })
    }

    const itemRows = await query(
      `SELECT id AS item_id, item_code, item_name, uom, is_active
       FROM items
       WHERE is_active = true
         AND (item_code = $1 OR item_code ILIKE $2 OR item_name ILIKE $2)
       ORDER BY item_name ASC
       LIMIT 20`,
      [barcode, likeBarcode]
    )

    if (itemRows.rows.length > 0) {
      return ok({
        barcode,
        match_type: "ITEM",
        matches: itemRows.rows,
      })
    }

    return fail("NOT_FOUND", "No matching barcode found", 404)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to lookup barcode"
    return fail("LOOKUP_FAILED", message, 400)
  }
}

