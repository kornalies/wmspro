import { NextRequest, NextResponse } from "next/server"

import { fail } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getLaborAccess } from "@/app/api/labor/_utils"

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  const lines = [headers.map(csvEscape).join(",")]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","))
  }
  return lines.join("\n")
}

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
    const mode = (searchParams.get("mode") || "exceptions").toLowerCase()
    const range = resolveDateRange(searchParams.get("from"), searchParams.get("to"))

    if (mode === "productivity") {
      const result = await query(
        `SELECT
           e.id,
           e.event_ts,
           s.operation_code,
           s.operation_name,
           u.full_name AS user_name,
           sh.shift_name,
           e.source_type,
           e.source_ref,
           e.quantity::float8 AS quantity,
           e.duration_minutes::float8 AS duration_minutes,
           ROUND((e.quantity / NULLIF(e.duration_minutes, 0) * 60)::numeric, 2)::float8 AS actual_units_per_hour,
           s.standard_units_per_hour::float8 AS standard_units_per_hour,
           ROUND(((e.quantity / NULLIF(e.duration_minutes, 0) * 60) / NULLIF(s.standard_units_per_hour, 0) * 100)::numeric, 2)::float8 AS performance_pct,
           e.quality_score::float8 AS quality_score,
           e.notes
         FROM labor_productivity_events e
         JOIN labor_standards s ON s.id = e.standard_id AND s.company_id = e.company_id
         LEFT JOIN users u ON u.id = e.user_id AND u.company_id = e.company_id
         LEFT JOIN labor_shifts sh ON sh.id = e.shift_id AND sh.company_id = e.company_id
         WHERE e.company_id = $1
           AND e.event_ts::date BETWEEN $2::date AND $3::date
         ORDER BY e.event_ts DESC
         LIMIT 5000`,
        [access.companyId, range.from, range.to]
      )

      const headers = [
        "id",
        "event_ts",
        "operation_code",
        "operation_name",
        "user_name",
        "shift_name",
        "source_type",
        "source_ref",
        "quantity",
        "duration_minutes",
        "actual_units_per_hour",
        "standard_units_per_hour",
        "performance_pct",
        "quality_score",
        "notes",
      ]
      const csv = toCsv(headers, result.rows as Array<Record<string, unknown>>)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="labor_productivity_${range.from}_to_${range.to}.csv"`,
        },
      })
    }

    if (mode === "exceptions") {
      const result = await query(
        `WITH base AS (
           SELECT
             e.id,
             e.event_ts,
             u.full_name AS user_name,
             sh.shift_name,
             s.operation_code,
             s.operation_name,
             e.quantity::float8 AS quantity,
             e.duration_minutes::float8 AS duration_minutes,
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
         )
         SELECT
           id,
           event_ts,
           user_name,
           shift_name,
           operation_code,
           operation_name,
           quantity,
           duration_minutes,
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
         LIMIT 5000`,
        [access.companyId, range.from, range.to]
      )

      const headers = [
        "id",
        "event_ts",
        "user_name",
        "shift_name",
        "operation_code",
        "operation_name",
        "quantity",
        "duration_minutes",
        "actual_units_per_hour",
        "standard_units_per_hour",
        "performance_pct",
        "warning_threshold_pct",
        "critical_threshold_pct",
        "severity",
      ]
      const csv = toCsv(headers, result.rows as Array<Record<string, unknown>>)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="labor_exceptions_${range.from}_to_${range.to}.csv"`,
        },
      })
    }

    return fail("INVALID_MODE", "mode must be exceptions or productivity", 400)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to export labor report"
    return fail("SERVER_ERROR", message, 500)
  }
}
