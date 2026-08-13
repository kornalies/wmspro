import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

// A day's "movement" is what actually moved, not what was typed into a form.
// Draft and cancelled paperwork used to be counted here, so a cancelled GRN of
// 67 units showed up as 67 units received on a day nothing was received.
const GRN_RECEIVED_STATUSES = ["CONFIRMED", "APPROVED"]
const DO_EXCLUDED_STATUSES = ["DRAFT", "CANCELLED"]

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const from = searchParams.get("date_from") || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)
    const to = searchParams.get("date_to") || new Date().toISOString().slice(0, 10)
    const clientId = searchParams.get("client_id")
    const warehouseId = searchParams.get("warehouse_id")

    // $1/$2 date range, $3 company, $4 GRN statuses, $5 excluded DO statuses.
    // company_id is filtered explicitly rather than left to RLS alone: this route
    // reads five tables, and a query that only works because of a session GUC is
    // one connection-handling change away from reading every tenant's movement.
    const params: Array<unknown> = [from, to, session.companyId, GRN_RECEIVED_STATUSES, DO_EXCLUDED_STATUSES]
    let clientParam = ""
    let warehouseParam = ""
    if (clientId && clientId !== "all") {
      params.push(Number(clientId))
      clientParam = `$${params.length}`
    }
    if (warehouseId && warehouseId !== "all") {
      params.push(Number(warehouseId))
      warehouseParam = `$${params.length}`
    }

    // The client and warehouse pickers used to be decorative on this report: the
    // route accepted neither, so a warehouse-scoped user read company-wide totals.
    const scopeOf = (alias: string) => {
      const parts = [`${alias}.company_id = $3`]
      if (clientParam) parts.push(`${alias}.client_id = ${clientParam}`)
      if (warehouseParam) parts.push(`${alias}.warehouse_id = ${warehouseParam}`)
      return parts.join(" AND ")
    }

    const result = await query(
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
       ),
       -- Header counts and line sums are computed separately on purpose. Counting
       -- COUNT(*) across a header-to-line join counts LINES, which reported 46
       -- GRNs as 52.
       grn_docs AS (
         SELECT gh.grn_date::date AS day, COUNT(*)::int AS grn_count
         FROM grn_header gh
         WHERE gh.grn_date::date BETWEEN $1::date AND $2::date
           AND gh.status = ANY($4::text[])
           AND ${scopeOf("gh")}
         GROUP BY gh.grn_date::date
       ),
       grn_lines AS (
         SELECT gh.grn_date::date AS day, COALESCE(SUM(gli.quantity), 0) AS items_received
         FROM grn_header gh
         JOIN grn_line_items gli ON gli.grn_header_id = gh.id
         WHERE gh.grn_date::date BETWEEN $1::date AND $2::date
           AND gh.status = ANY($4::text[])
           AND ${scopeOf("gh")}
         GROUP BY gh.grn_date::date
       ),
       do_docs AS (
         SELECT
           dh.request_date::date AS day,
           COUNT(*)::int AS do_count,
           COALESCE(SUM(dh.no_of_cases), 0) AS do_cases,
           COALESCE(SUM(dh.no_of_pallets), 0) AS do_pallets,
           COALESCE(SUM(dh.weight_kg), 0) AS do_weight_kg
         FROM do_header dh
         WHERE dh.request_date::date BETWEEN $1::date AND $2::date
           AND NOT (dh.status = ANY($5::text[]))
           AND ${scopeOf("dh")}
         GROUP BY dh.request_date::date
       ),
       do_lines AS (
         SELECT dh.request_date::date AS day, COALESCE(SUM(dli.quantity_dispatched), 0) AS items_dispatched
         FROM do_header dh
         JOIN do_line_items dli ON dli.do_header_id = dh.id
         WHERE dh.request_date::date BETWEEN $1::date AND $2::date
           AND NOT (dh.status = ANY($5::text[]))
           AND ${scopeOf("dh")}
         GROUP BY dh.request_date::date
       ),
       gin AS (
         SELECT gi.gate_in_datetime::date AS day, COUNT(*)::int AS gate_in
         FROM gate_in gi
         WHERE gi.gate_in_datetime::date BETWEEN $1::date AND $2::date
           AND ${scopeOf("gi")}
         GROUP BY gi.gate_in_datetime::date
       ),
       gout AS (
         SELECT go.gate_out_datetime::date AS day, COUNT(*)::int AS gate_out
         FROM gate_out go
         WHERE go.gate_out_datetime::date BETWEEN $1::date AND $2::date
           AND ${scopeOf("go")}
         GROUP BY go.gate_out_datetime::date
       )
       SELECT
         days.day::text AS date,
         COALESCE(grn_docs.grn_count, 0)::int AS grn_count,
         COALESCE(do_docs.do_count, 0)::int AS do_count,
         COALESCE(gin.gate_in, 0)::int AS gate_in,
         COALESCE(gout.gate_out, 0)::int AS gate_out,
         COALESCE(grn_lines.items_received, 0)::int AS items_received,
         COALESCE(do_lines.items_dispatched, 0)::int AS items_dispatched,
         COALESCE(do_docs.do_cases, 0)::int AS do_cases,
         COALESCE(do_docs.do_pallets, 0)::int AS do_pallets,
         ROUND(COALESCE(do_docs.do_weight_kg, 0)::numeric, 3)::float8 AS do_weight_kg
       FROM days
       LEFT JOIN grn_docs ON grn_docs.day = days.day
       LEFT JOIN grn_lines ON grn_lines.day = days.day
       LEFT JOIN do_docs ON do_docs.day = days.day
       LEFT JOIN do_lines ON do_lines.day = days.day
       LEFT JOIN gin ON gin.day = days.day
       LEFT JOIN gout ON gout.day = days.day
       ORDER BY days.day DESC`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch movement report"
    return fail("SERVER_ERROR", message, 500)
  }
}
