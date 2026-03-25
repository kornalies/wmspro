import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, paginated } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const serial = searchParams.get("serial")?.trim()
    const item = searchParams.get("item")?.trim()
    const status = searchParams.get("status")
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const minAge = searchParams.get("min_age")
    const maxAge = searchParams.get("max_age")
    const page = Math.max(1, Number(searchParams.get("page") || 1))
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)))

    const where: string[] = []
    const params: Array<string | number> = []
    let idx = 1

    if (serial) {
      where.push(`ssn.serial_number ILIKE $${idx++}`)
      params.push(`%${serial}%`)
    }
    if (item) {
      where.push(
        `EXISTS (
          SELECT 1
          FROM items i2
          WHERE i2.id = ssn.item_id
            AND (i2.item_name ILIKE $${idx} OR i2.item_code ILIKE $${idx})
        )`
      )
      params.push(`%${item}%`)
      idx += 1
    }
    if (status && status !== "all") {
      where.push(`ssn.status = $${idx++}`)
      params.push(status)
    }
    if (warehouseId) {
      where.push(`ssn.warehouse_id = $${idx++}`)
      params.push(warehouseId)
    }
    if (minAge) {
      where.push(`(CURRENT_DATE - ssn.received_date::date) >= $${idx++}`)
      params.push(Number(minAge))
    }
    if (maxAge) {
      where.push(`(CURRENT_DATE - ssn.received_date::date) <= $${idx++}`)
      params.push(Number(maxAge))
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const summaryResult = await query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock,
        COUNT(*) FILTER (WHERE ssn.status = 'RESERVED')::int AS reserved,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched,
        COALESCE(ROUND(AVG(CURRENT_DATE - ssn.received_date::date)), 0)::int AS avg_age_days
      FROM stock_serial_numbers ssn
      ${whereClause}`,
      params
    )

    const total = Number(summaryResult.rows[0]?.total || 0)
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1
    const safePage = Math.min(page, totalPages)
    const offset = (safePage - 1) * limit

    const dataParams = [...params, limit, offset]
    const limitParamIndex = params.length + 1
    const offsetParamIndex = params.length + 2
    const result = await query(
      `SELECT
        ssn.id,
        ssn.serial_number,
        ssn.status,
        ssn.received_date,
        ssn.warehouse_id,
        (CURRENT_DATE - ssn.received_date::date) AS age_days,
        i.item_name,
        i.item_code,
        c.client_name,
        w.warehouse_name,
        COALESCE(zl.zone_name, 'Unassigned') AS zone_name,
        zl.rack_name,
        zl.bin_name,
        COALESCE(ssn.bin_location, CONCAT(zl.zone_code, '/', zl.rack_code, '/', zl.bin_code), 'Unassigned') AS bin_location
      FROM stock_serial_numbers ssn
      JOIN items i ON i.id = ssn.item_id
      JOIN clients c ON c.id = ssn.client_id
      JOIN warehouses w ON w.id = ssn.warehouse_id
      LEFT JOIN warehouse_zone_layouts zl ON zl.id = ssn.zone_layout_id
      ${whereClause}
      ORDER BY ssn.received_date DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}`,
      dataParams
    )

    return paginated(
      {
        rows: result.rows,
        summary: {
          in_stock: Number(summaryResult.rows[0]?.in_stock || 0),
          reserved: Number(summaryResult.rows[0]?.reserved || 0),
          dispatched: Number(summaryResult.rows[0]?.dispatched || 0),
          avg_age_days: Number(summaryResult.rows[0]?.avg_age_days || 0),
        },
      },
      {
        page: safePage,
        limit,
        total,
        totalPages,
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to search stock"
    return fail("SERVER_ERROR", message, 500)
  }
}
