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

    if (!warehouseId || !clientId) {
      return fail("VALIDATION_ERROR", "warehouse_id and client_id are required", 400)
    }

    const result = await query(
      `SELECT
         i.id,
         i.item_code,
         i.item_name,
         i.is_active,
         COUNT(ssn.id)::int AS available_qty
       FROM stock_serial_numbers ssn
       JOIN items i
         ON i.id = ssn.item_id
        AND i.company_id = ssn.company_id
       WHERE ssn.company_id = $1
         AND ssn.client_id = $2
         AND ssn.warehouse_id = $3
         AND ssn.status = 'IN_STOCK'
         AND ssn.do_line_item_id IS NULL
       GROUP BY i.id, i.item_code, i.item_name, i.is_active
       HAVING COUNT(ssn.id) > 0
       ORDER BY i.item_name ASC`,
      [session.companyId, clientId, warehouseId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch DO available items"
    return fail("SERVER_ERROR", message, 500)
  }
}

