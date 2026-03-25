import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const from = searchParams.get("date_from") || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)
    const to = searchParams.get("date_to") || new Date().toISOString().slice(0, 10)

    const result = await query(
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
       ),
       grn AS (
         SELECT gh.grn_date::date AS day, COUNT(*) AS grn_count, COALESCE(SUM(gli.quantity), 0) AS items_received
         FROM grn_header gh
         LEFT JOIN grn_line_items gli ON gli.grn_header_id = gh.id
         WHERE gh.grn_date::date BETWEEN $1::date AND $2::date
         GROUP BY gh.grn_date::date
       ),
       dox AS (
         SELECT
           dh.request_date::date AS day,
           COUNT(*) AS do_count,
           COALESCE(SUM(dli.quantity_dispatched), 0) AS items_dispatched,
           COALESCE(SUM(dh.no_of_cases), 0) AS do_cases,
           COALESCE(SUM(dh.no_of_pallets), 0) AS do_pallets,
           COALESCE(SUM(dh.weight_kg), 0) AS do_weight_kg
         FROM do_header dh
         LEFT JOIN do_line_items dli ON dli.do_header_id = dh.id
         WHERE dh.request_date::date BETWEEN $1::date AND $2::date
         GROUP BY dh.request_date::date
       ),
       gin AS (
         SELECT gate_in_datetime::date AS day, COUNT(*) AS gate_in
         FROM gate_in
         WHERE gate_in_datetime::date BETWEEN $1::date AND $2::date
         GROUP BY gate_in_datetime::date
       ),
       gout AS (
         SELECT gate_out_datetime::date AS day, COUNT(*) AS gate_out
         FROM gate_out
         WHERE gate_out_datetime::date BETWEEN $1::date AND $2::date
         GROUP BY gate_out_datetime::date
       )
       SELECT
         days.day::text AS date,
         COALESCE(grn.grn_count, 0)::int AS grn_count,
         COALESCE(dox.do_count, 0)::int AS do_count,
         COALESCE(gin.gate_in, 0)::int AS gate_in,
         COALESCE(gout.gate_out, 0)::int AS gate_out,
         COALESCE(grn.items_received, 0)::int AS items_received,
         COALESCE(dox.items_dispatched, 0)::int AS items_dispatched,
         COALESCE(dox.do_cases, 0)::int AS do_cases,
         COALESCE(dox.do_pallets, 0)::int AS do_pallets,
         ROUND(COALESCE(dox.do_weight_kg, 0)::numeric, 3)::float8 AS do_weight_kg
       FROM days
       LEFT JOIN grn ON grn.day = days.day
       LEFT JOIN dox ON dox.day = days.day
       LEFT JOIN gin ON gin.day = days.day
       LEFT JOIN gout ON gout.day = days.day
       ORDER BY days.day DESC`,
      [from, to]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch movement report"
    return fail("SERVER_ERROR", message, 500)
  }
}
