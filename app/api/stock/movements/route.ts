import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, paginated } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const clientId = Number(searchParams.get("client_id") || 0)
    const userId = Number(searchParams.get("user_id") || 0)
    const serial = searchParams.get("serial")?.trim()
    const item = searchParams.get("item")?.trim()
    const fromBin = searchParams.get("from_bin")?.trim()
    const toBin = searchParams.get("to_bin")?.trim()
    const dateFrom = searchParams.get("date_from")?.trim()
    const dateTo = searchParams.get("date_to")?.trim()
    const page = Math.max(1, Number(searchParams.get("page") || 1))
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)))

    const where: string[] = ["spm.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2

    if (warehouseId) {
      where.push(`spm.warehouse_id = $${idx++}`)
      params.push(warehouseId)
    }
    if (clientId) {
      where.push(`ssn.client_id = $${idx++}`)
      params.push(clientId)
    }
    if (userId) {
      where.push(`spm.moved_by = $${idx++}`)
      params.push(userId)
    }
    if (serial) {
      where.push(`spm.serial_number ILIKE $${idx++}`)
      params.push(`%${serial}%`)
    }
    if (item) {
      where.push(`(i.item_code ILIKE $${idx} OR i.item_name ILIKE $${idx})`)
      params.push(`%${item}%`)
      idx++
    }
    if (fromBin) {
      where.push(`COALESCE(spm.from_bin_location, 'Unassigned') ILIKE $${idx++}`)
      params.push(`%${fromBin}%`)
    }
    if (toBin) {
      where.push(`spm.to_bin_location ILIKE $${idx++}`)
      params.push(`%${toBin}%`)
    }
    if (dateFrom) {
      where.push(`spm.moved_at::date >= $${idx++}`)
      params.push(dateFrom)
    }
    if (dateTo) {
      where.push(`spm.moved_at::date <= $${idx++}`)
      params.push(dateTo)
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const baseFrom = `
      FROM stock_putaway_movements spm
      JOIN items i ON i.id = spm.item_id
      JOIN warehouses w ON w.id = spm.warehouse_id
      JOIN users u ON u.id = spm.moved_by AND u.company_id = spm.company_id
      LEFT JOIN stock_serial_numbers ssn ON ssn.id = spm.stock_serial_id
      LEFT JOIN clients c ON c.id = ssn.client_id
      ${whereClause}
    `

    const summaryResult = await query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE spm.moved_at::date = CURRENT_DATE)::int AS moves_today,
        COUNT(DISTINCT spm.item_id)::int AS unique_items,
        COUNT(DISTINCT spm.moved_by)::int AS unique_users,
        COALESCE(
          (
            SELECT w2.warehouse_name
            FROM stock_putaway_movements spm2
            JOIN warehouses w2 ON w2.id = spm2.warehouse_id
            WHERE spm2.company_id = $1
            GROUP BY w2.warehouse_name
            ORDER BY COUNT(*) DESC, w2.warehouse_name ASC
            LIMIT 1
          ),
          '-'
        ) AS most_active_warehouse
      ${baseFrom}`,
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
        spm.id,
        ('PWM-' || LPAD(spm.id::text, 8, '0')) AS movement_ref,
        spm.stock_serial_id,
        spm.serial_number,
        i.item_code,
        i.item_name,
        c.client_name,
        c.client_code,
        spm.warehouse_id,
        w.warehouse_name,
        COALESCE(spm.from_bin_location, 'Unassigned') AS from_bin_location,
        spm.to_bin_location,
        spm.remarks,
        spm.moved_at,
        spm.moved_by AS moved_by_user_id,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS moved_by_name,
        u.username AS moved_by_username,
        u.role AS moved_by_role,
        'web' AS movement_source
      ${baseFrom}
      ORDER BY spm.moved_at DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}`,
      dataParams
    )

    return paginated(
      {
        rows: result.rows,
        summary: {
          total,
          moves_today: Number(summaryResult.rows[0]?.moves_today || 0),
          unique_items: Number(summaryResult.rows[0]?.unique_items || 0),
          unique_users: Number(summaryResult.rows[0]?.unique_users || 0),
          most_active_warehouse: String(summaryResult.rows[0]?.most_active_warehouse || "-"),
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
    const message = error instanceof Error ? error.message : "Failed to fetch movement history"
    return fail("SERVER_ERROR", message, 500)
  }
}
