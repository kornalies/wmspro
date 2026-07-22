import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, paginated } from "@/lib/api-response"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import {
  STOCK_SERIAL_JOINS,
  STOCK_SERIAL_SELECT,
  buildStockSearchFilters,
} from "@/lib/stock-search"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get("page") || 1))
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)))
    // group=item returns lightweight item-summary rows (one per item, paginated by
    // item) instead of serial rows. This keeps the default consolidated view flat and
    // cheap no matter how deep the stock is; the UI drills into an item's serials
    // on demand via item_id. Serial mode (default) stays for existing API consumers.
    const groupByItem = searchParams.get("group") === "item"

    const { whereClause, params } = buildStockSearchFilters(searchParams, session.companyId)

    const summaryResult = await query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT ssn.item_id)::int AS items_total,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock,
        COUNT(*) FILTER (WHERE ssn.status = 'RESERVED')::int AS reserved,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched,
        COALESCE(ROUND(AVG(CURRENT_DATE - ssn.received_date::date)), 0)::int AS avg_age_days
      FROM stock_serial_numbers ssn
      ${whereClause}`,
      params
    )

    const serialTotal = Number(summaryResult.rows[0]?.total || 0)
    const itemsTotal = Number(summaryResult.rows[0]?.items_total || 0)
    // In grouped mode the "unit" of pagination is the item, not the serial.
    const total = groupByItem ? itemsTotal : serialTotal
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1
    const safePage = Math.min(page, totalPages)
    const offset = (safePage - 1) * limit

    const dataParams = [...params, limit, offset]
    const limitParamIndex = params.length + 1
    const offsetParamIndex = params.length + 2

    let rows: unknown[]
    if (groupByItem) {
      // Item-summary rows: aggregate counts per item, paginated by item. No serial-row
      // joins (LP lateral, zones) so the collapsed list stays cheap at any depth.
      const summaryRows = await query(
        `SELECT
          ssn.item_id,
          i.item_name,
          i.item_code,
          COUNT(*)::int AS serial_count,
          COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock,
          COUNT(*) FILTER (WHERE ssn.status = 'RESERVED')::int AS reserved,
          COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched,
          COUNT(*) FILTER (WHERE ssn.status = 'CANCELLED')::int AS cancelled,
          COUNT(DISTINCT ssn.warehouse_id)::int AS warehouse_count,
          MAX(ssn.received_date) AS last_received,
          MAX(CURRENT_DATE - ssn.received_date::date)::int AS max_age_days
        FROM stock_serial_numbers ssn
        JOIN items i ON i.id = ssn.item_id AND i.company_id = ssn.company_id
        ${whereClause}
        GROUP BY ssn.item_id, i.item_name, i.item_code
        ORDER BY MAX(ssn.received_date) DESC, ssn.item_id
        LIMIT $${limitParamIndex}
        OFFSET $${offsetParamIndex}`,
        dataParams
      )
      rows = summaryRows.rows
    } else {
      // Serial rows (default, or an item drill-down when item_id is supplied).
      const serialRows = await query(
        `SELECT ${STOCK_SERIAL_SELECT}
        ${STOCK_SERIAL_JOINS}
        ${whereClause}
        ORDER BY ssn.received_date DESC
        LIMIT $${limitParamIndex}
        OFFSET $${offsetParamIndex}`,
        dataParams
      )
      rows = serialRows.rows
    }

    return paginated(
      {
        rows,
        summary: {
          in_stock: Number(summaryResult.rows[0]?.in_stock || 0),
          reserved: Number(summaryResult.rows[0]?.reserved || 0),
          dispatched: Number(summaryResult.rows[0]?.dispatched || 0),
          avg_age_days: Number(summaryResult.rows[0]?.avg_age_days || 0),
          total_serials: serialTotal,
          total_items: itemsTotal,
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
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to search stock"
    return fail("SERVER_ERROR", message, 500)
  }
}