import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

// Serials that are neither held nor owed to anyone. They are not stock, and
// counting them made the summary's `total` column disagree with its own
// in-stock/reserved/dispatched breakdown by exactly the cancelled population.
const NON_STOCK_STATUSES = ["CANCELLED"]

const SLOW_MOVING_LIMIT = 500

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const mode = searchParams.get("mode") || "summary"
    const clientId = searchParams.get("client_id")
    const warehouseId = searchParams.get("warehouse_id")
    const params: Array<unknown> = [session.companyId]
    const filters = ["ssn.company_id = $1"]

    if (clientId && clientId !== "all") {
      params.push(Number(clientId))
      filters.push(`ssn.client_id = $${params.length}`)
    }

    if (warehouseId && warehouseId !== "all") {
      params.push(Number(warehouseId))
      filters.push(`ssn.warehouse_id = $${params.length}`)
    }

    const whereClause = filters.join("\n          AND ")

    if (mode === "slow") {
      // The row cap stays, but the caller is told the true size. It used to
      // return a bare 300 rows, and the page's "slow moving SKUs" KPI counted
      // the array -- so a warehouse with 1,057 aged serials reported 300.
      const result = await query(
        `SELECT
          ssn.serial_number AS serial,
          i.item_name AS item,
          c.client_name AS client,
          (CURRENT_DATE - ssn.received_date::date) AS age_days,
          ssn.status,
          COALESCE(i.standard_mrp, 0)::numeric AS value,
          COUNT(*) OVER ()::int AS total_matching
        FROM stock_serial_numbers ssn
        JOIN items i ON i.id = ssn.item_id AND i.company_id = ssn.company_id
        JOIN clients c ON c.id = ssn.client_id AND c.company_id = ssn.company_id
        WHERE ssn.status = 'IN_STOCK'
          AND (CURRENT_DATE - ssn.received_date::date) > 60
          AND ${whereClause}
        ORDER BY age_days DESC
        LIMIT ${SLOW_MOVING_LIMIT}`,
        params
      )

      const total = result.rows[0]?.total_matching ?? 0
      return ok({
        rows: result.rows.map((row) => {
          const { total_matching, ...rest } = row
          void total_matching
          return rest
        }),
        total,
        truncated: total > result.rows.length,
      })
    }

    params.push(NON_STOCK_STATUSES)
    const nonStockParam = `$${params.length}`

    // Grouped by item id, not item name: two items sharing a name are two items,
    // and merging them merged their stock and double-counted one MRP across both.
    const result = await query(
      `SELECT
        c.client_name AS client,
        i.item_name AS item,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock,
        COUNT(*) FILTER (WHERE ssn.status = 'RESERVED')::int AS reserved,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched,
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK') * COALESCE(i.standard_mrp, 0))::numeric AS value,
        (COALESCE(i.standard_mrp, 0) = 0)::boolean AS unvalued
      FROM stock_serial_numbers ssn
      JOIN clients c ON c.id = ssn.client_id AND c.company_id = ssn.company_id
      JOIN items i ON i.id = ssn.item_id AND i.company_id = ssn.company_id
      WHERE NOT (ssn.status = ANY(${nonStockParam}::text[]))
        AND ${whereClause}
      GROUP BY c.id, c.client_name, i.id, i.item_name, i.standard_mrp
      ORDER BY c.client_name, i.item_name`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch stock report"
    return fail("SERVER_ERROR", message, 500)
  }
}
