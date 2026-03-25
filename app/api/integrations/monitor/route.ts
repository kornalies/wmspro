import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

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
    const status = searchParams.get("status")
    const range = resolveDateRange(searchParams.get("from"), searchParams.get("to"))

    const rows = await query(
      `SELECT
         e.id,
         e.connector_id,
         c.connector_name,
         c.provider_type,
         e.mapping_id,
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
       ORDER BY
         CASE e.status
           WHEN 'DEAD_LETTER' THEN 1
           WHEN 'RETRY' THEN 2
           WHEN 'PROCESSING' THEN 3
           WHEN 'QUEUED' THEN 4
           ELSE 5
         END,
         e.created_at DESC
       LIMIT 500`,
      [access.companyId, connectorId, status || null, range.from, range.to]
    )

    const summary = await query(
      `SELECT
         COUNT(*)::int AS total_events,
         COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success_count,
         COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS queued_count,
         COUNT(*) FILTER (WHERE status = 'RETRY')::int AS retry_count,
         COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter_count,
         COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing_count
       FROM integration_events
       WHERE company_id = $1
         AND created_at::date BETWEEN $2::date AND $3::date`,
      [access.companyId, range.from, range.to]
    )

    return ok({
      range,
      summary: summary.rows[0],
      rows: rows.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch integration monitoring"
    return fail("SERVER_ERROR", message, 500)
  }
}
