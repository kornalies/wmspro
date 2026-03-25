import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const serial = searchParams.get("serial")?.trim()

    const where: string[] = []
    const params: Array<string | number> = []
    let idx = 1

    if (warehouseId) {
      where.push(`spm.warehouse_id = $${idx++}`)
      params.push(warehouseId)
    }
    if (serial) {
      where.push(`spm.serial_number ILIKE $${idx++}`)
      params.push(`%${serial}%`)
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const result = await query(
      `SELECT
        spm.id,
        spm.stock_serial_id,
        spm.serial_number,
        i.item_code,
        i.item_name,
        w.warehouse_name,
        COALESCE(spm.from_bin_location, 'Unassigned') AS from_bin_location,
        spm.to_bin_location,
        spm.remarks,
        spm.moved_at,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS moved_by_name,
        u.username AS moved_by_username
      FROM stock_putaway_movements spm
      JOIN items i ON i.id = spm.item_id
      JOIN warehouses w ON w.id = spm.warehouse_id
      JOIN users u ON u.id = spm.moved_by AND u.company_id = spm.company_id
      ${whereClause}
      ORDER BY spm.moved_at DESC
      LIMIT 500`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch movement history"
    return fail("SERVER_ERROR", message, 500)
  }
}
