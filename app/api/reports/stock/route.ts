import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const mode = searchParams.get("mode") || "summary"
    const clientId = searchParams.get("client_id")
    const whereClient = clientId && clientId !== "all" ? "AND ssn.client_id = $1" : ""
    const params = clientId && clientId !== "all" ? [Number(clientId)] : []

    if (mode === "slow") {
      const result = await query(
        `SELECT
          ssn.serial_number AS serial,
          i.item_name AS item,
          c.client_name AS client,
          (CURRENT_DATE - ssn.received_date::date) AS age_days,
          ssn.status,
          COALESCE(i.standard_mrp, 0)::numeric AS value
        FROM stock_serial_numbers ssn
        JOIN items i ON i.id = ssn.item_id
        JOIN clients c ON c.id = ssn.client_id
        WHERE ssn.status = 'IN_STOCK'
          AND (CURRENT_DATE - ssn.received_date::date) > 60
          ${whereClient}
        ORDER BY age_days DESC
        LIMIT 300`,
        params
      )

      return ok(result.rows)
    }

    const result = await query(
      `SELECT
        c.client_name AS client,
        i.item_name AS item,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock,
        COUNT(*) FILTER (WHERE ssn.status = 'RESERVED')::int AS reserved,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched,
        COUNT(*)::int AS total,
        (COUNT(*) * COALESCE(i.standard_mrp, 0))::numeric AS value
      FROM stock_serial_numbers ssn
      JOIN clients c ON c.id = ssn.client_id
      JOIN items i ON i.id = ssn.item_id
      WHERE 1=1 ${whereClient}
      GROUP BY c.client_name, i.item_name, i.standard_mrp
      ORDER BY c.client_name, i.item_name`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch stock report"
    return fail("SERVER_ERROR", message, 500)
  }
}
