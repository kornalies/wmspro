import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import {
  STOCK_SERIAL_JOINS,
  STOCK_SERIAL_SELECT,
  buildStockSearchFilters,
} from "@/lib/stock-search"

// Hard ceiling so an unfiltered export can't pull the entire tenant into memory.
// The UI surfaces `truncated` so the user knows to narrow filters if they hit it.
const EXPORT_LIMIT = 50000

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")

    const { searchParams } = new URL(request.url)
    const { whereClause, params } = buildStockSearchFilters(searchParams, session.companyId)

    const limitParamIndex = params.length + 1
    const result = await query(
      `SELECT ${STOCK_SERIAL_SELECT}
      ${STOCK_SERIAL_JOINS}
      ${whereClause}
      ORDER BY ssn.received_date DESC
      LIMIT $${limitParamIndex}`,
      [...params, EXPORT_LIMIT]
    )

    return ok({
      rows: result.rows,
      truncated: result.rows.length >= EXPORT_LIMIT,
      limit: EXPORT_LIMIT,
    })
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to export stock"
    return fail("SERVER_ERROR", message, 500)
  }
}