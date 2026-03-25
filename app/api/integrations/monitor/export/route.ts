import { NextRequest, NextResponse } from "next/server"

import { fail } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

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

function resolveDateRange(from?: string | null, to?: string | null) {
  const resolvedTo = to || new Date().toISOString().slice(0, 10)
  const resolvedFrom =
    from || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from: resolvedFrom, to: resolvedTo }
}

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const connectorId = Number(searchParams.get("connector_id") || 0)
    const range = resolveDateRange(searchParams.get("from"), searchParams.get("to"))
    const statusFilter = searchParams.get("status") || "DEAD_LETTER"

    const result = await query(
      `SELECT
         e.id,
         e.connector_id,
         c.connector_code,
         c.connector_name,
         c.provider_type,
         c.transport_type,
         e.direction,
         e.entity_type,
         e.entity_id,
         e.status,
         e.attempt_count,
         e.last_error,
         e.next_retry_at,
         e.processed_at,
         e.created_at,
         e.updated_at
       FROM integration_events e
       JOIN integration_connectors c ON c.id = e.connector_id AND c.company_id = e.company_id
       WHERE e.company_id = $1
         AND ($2::int = 0 OR e.connector_id = $2)
         AND ($3::text IS NULL OR e.status = $3)
         AND e.created_at::date BETWEEN $4::date AND $5::date
       ORDER BY e.created_at DESC
       LIMIT 10000`,
      [access.companyId, connectorId, statusFilter || null, range.from, range.to]
    )

    const headers = [
      "id",
      "connector_id",
      "connector_code",
      "connector_name",
      "provider_type",
      "transport_type",
      "direction",
      "entity_type",
      "entity_id",
      "status",
      "attempt_count",
      "last_error",
      "next_retry_at",
      "processed_at",
      "created_at",
      "updated_at",
    ]
    const csv = toCsv(headers, result.rows as Array<Record<string, unknown>>)

    const safeStatus = String(statusFilter || "ALL").replace(/[^A-Z_]/gi, "").toUpperCase() || "ALL"
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="integration_monitor_${safeStatus}_${range.from}_to_${range.to}.csv"`,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to export integration monitor"
    return fail("SERVER_ERROR", message, 500)
  }
}
