import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const clientId = Number(searchParams.get("client_id") || 0)
    const rawItemIds = (searchParams.get("item_ids") || "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0)
    const itemIds = Array.from(new Set(rawItemIds))

    if (!warehouseId || !clientId || itemIds.length === 0) {
      return fail("VALIDATION_ERROR", "warehouse_id, client_id and item_ids are required", 400)
    }

    const result = await query(
      `SELECT
         i.id AS item_id,
         i.item_name,
         i.item_code,
         COUNT(ssn.id)::int AS available_qty
       FROM items i
       LEFT JOIN stock_serial_numbers ssn
         ON ssn.company_id = i.company_id
        AND ssn.item_id = i.id
        AND ssn.client_id = $1
        AND ssn.warehouse_id = $2
        AND ssn.status = 'IN_STOCK'
        AND ssn.do_line_item_id IS NULL
       WHERE i.company_id = $3
         AND i.id = ANY($4::int[])
       GROUP BY i.id, i.item_name, i.item_code
       ORDER BY i.id ASC`,
      [clientId, warehouseId, session.companyId, itemIds]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch DO inventory availability"
    return fail("SERVER_ERROR", message, 500)
  }
}
