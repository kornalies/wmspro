import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getLaborAccess } from "@/app/api/labor/_utils"

function resolveDateRange(inputFrom?: string | null, inputTo?: string | null) {
  const to = inputTo || new Date().toISOString().slice(0, 10)
  const from =
    inputFrom ||
    new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from, to }
}

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const range = resolveDateRange(searchParams.get("from"), searchParams.get("to"))
    const limit = Math.min(Number(searchParams.get("limit") || 200), 500)
    const userId = Number(searchParams.get("user_id") || 0)
    const shiftId = Number(searchParams.get("shift_id") || 0)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)

    const rowsResult = await query(
      `WITH base AS (
         SELECT
           e.id,
           e.event_ts,
           e.user_id,
           u.full_name AS user_name,
           e.shift_id,
           sh.shift_name,
           e.standard_id,
           s.operation_code,
           s.operation_name,
           e.quantity,
           e.duration_minutes,
           ROUND((e.quantity / NULLIF(e.duration_minutes, 0) * 60)::numeric, 2)::float8 AS actual_units_per_hour,
           s.standard_units_per_hour::float8 AS standard_units_per_hour,
           ROUND(((e.quantity / NULLIF(e.duration_minutes, 0) * 60) / NULLIF(s.standard_units_per_hour, 0) * 100)::numeric, 2)::float8 AS performance_pct,
           s.warning_threshold_pct::float8 AS warning_threshold_pct,
           s.critical_threshold_pct::float8 AS critical_threshold_pct
         FROM labor_productivity_events e
         JOIN labor_standards s ON s.id = e.standard_id AND s.company_id = e.company_id
         LEFT JOIN users u ON u.id = e.user_id AND u.company_id = e.company_id
         LEFT JOIN labor_shifts sh ON sh.id = e.shift_id AND sh.company_id = e.company_id
         WHERE e.company_id = $1
           AND e.event_ts::date BETWEEN $2::date AND $3::date
           AND ($5::int = 0 OR e.user_id = $5)
           AND ($6::int = 0 OR e.shift_id = $6)
           AND ($7::int = 0 OR COALESCE(e.warehouse_id, sh.warehouse_id) = $7)
       )
       SELECT
         id,
         event_ts,
         user_id,
         user_name,
         shift_id,
         shift_name,
         standard_id,
         operation_code,
         operation_name,
         quantity::float8 AS quantity,
         duration_minutes::float8 AS duration_minutes,
         actual_units_per_hour,
         standard_units_per_hour,
         performance_pct,
         warning_threshold_pct,
         critical_threshold_pct,
         CASE
           WHEN performance_pct < critical_threshold_pct THEN 'CRITICAL'
           WHEN performance_pct < warning_threshold_pct THEN 'WARNING'
           ELSE 'NORMAL'
         END AS severity
       FROM base
       ORDER BY severity DESC, performance_pct ASC, event_ts DESC
       LIMIT $4`,
      [access.companyId, range.from, range.to, limit, userId, shiftId, warehouseId]
    )

    const rows = rowsResult.rows as Array<{
      severity: "CRITICAL" | "WARNING" | "NORMAL"
      performance_pct: number
      standard_id: number
      operation_name: string
    }>

    const summary = {
      from: range.from,
      to: range.to,
      total_records: rows.length,
      critical_count: rows.filter((r) => r.severity === "CRITICAL").length,
      warning_count: rows.filter((r) => r.severity === "WARNING").length,
      normal_count: rows.filter((r) => r.severity === "NORMAL").length,
      avg_performance_pct: rows.length
        ? Number((rows.reduce((sum, row) => sum + Number(row.performance_pct || 0), 0) / rows.length).toFixed(2))
        : 0,
      top_exception_operations: Object.entries(
        rows
          .filter((r) => r.severity !== "NORMAL")
          .reduce((acc, row) => {
            const key = `${row.standard_id}:${row.operation_name}`
            acc[key] = (acc[key] || 0) + 1
            return acc
          }, {} as Record<string, number>)
      )
        .map(([key, count]) => {
          const [, operation_name] = key.split(":")
          return { operation_name, count }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    }

    const shiftGapResult = await query(
      `SELECT
         s.id AS shift_id,
         s.shift_name,
         s.planned_headcount,
         COALESCE(a.assigned_headcount, 0)::int AS assigned_headcount,
         (s.planned_headcount - COALESCE(a.assigned_headcount, 0))::int AS headcount_gap
       FROM labor_shifts s
       LEFT JOIN (
         SELECT shift_id, COUNT(*) FILTER (WHERE assignment_status = 'ASSIGNED') AS assigned_headcount
         FROM labor_shift_assignments
         WHERE company_id = $1
           AND shift_date BETWEEN $2::date AND $3::date
         GROUP BY shift_id
       ) a ON a.shift_id = s.id
       WHERE s.company_id = $1
         AND s.is_active = true
         AND ($4::int = 0 OR s.warehouse_id = $4)
       ORDER BY headcount_gap DESC, s.shift_name ASC
       LIMIT 20`,
      [access.companyId, range.from, range.to, warehouseId]
    )

    return ok({
      summary,
      rows,
      shift_headcount_gaps: shiftGapResult.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor exceptions"
    return fail("SERVER_ERROR", message, 500)
  }
}
