import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get("client_id")
    const whereClient = clientId && clientId !== "all" ? "WHERE c.id = $1" : ""
    const params = clientId && clientId !== "all" ? [Number(clientId)] : []

    const invoicesTable = await query(`SELECT to_regclass('public.invoices') AS table_name`)
    const hasInvoices = !!invoicesTable.rows[0]?.table_name

    const billingExpr = hasInvoices
      ? `(SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i WHERE i.client_id = c.id)`
      : `(SELECT COALESCE(SUM(dli.quantity_dispatched * COALESCE(it.standard_mrp, 0)), 0)
          FROM do_header dh
          LEFT JOIN do_line_items dli ON dli.do_header_id = dh.id
          LEFT JOIN items it ON it.id = dli.item_id
          WHERE dh.client_id = c.id)`

    const result = await query(
      `SELECT
        c.client_name AS name,
        (SELECT COUNT(*) FROM stock_serial_numbers ssn WHERE ssn.client_id = c.id AND ssn.status = 'IN_STOCK')::int AS stock,
        ${billingExpr}::numeric AS billing,
        (SELECT COUNT(*) FROM grn_header gh WHERE gh.client_id = c.id)::int AS grns,
        (SELECT COUNT(*) FROM do_header dh WHERE dh.client_id = c.id)::int AS dos
      FROM clients c
      ${whereClient}
      ORDER BY c.client_name`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch analytics report"
    return fail("SERVER_ERROR", message, 500)
  }
}
