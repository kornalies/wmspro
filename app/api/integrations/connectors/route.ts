import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

const connectorSchema = z.object({
  connector_code: z.string().trim().min(2).max(60),
  connector_name: z.string().trim().min(2).max(150),
  provider_type: z.enum(["EDI", "CARRIER", "ERP"]),
  transport_type: z.enum(["REST", "SFTP", "FTP", "EMAIL", "WEBHOOK"]),
  direction: z.enum(["INBOUND", "OUTBOUND", "BIDIRECTIONAL"]).default("BIDIRECTIONAL"),
  endpoint_url: z.string().trim().max(500).optional(),
  auth_type: z.enum(["NONE", "API_KEY", "BASIC", "BEARER", "OAUTH2"]).default("NONE"),
  status: z.enum(["ACTIVE", "INACTIVE", "ERROR"]).default("ACTIVE"),
  timeout_seconds: z.number().int().min(1).max(300).default(30),
  retry_limit: z.number().int().min(0).max(20).default(3),
  retry_backoff_seconds: z.number().int().min(5).max(86400).default(60),
  dead_letter_after: z.number().int().min(1).max(50).default(5),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const provider = searchParams.get("provider")
    const status = searchParams.get("status")

    const rows = await query(
      `SELECT
         c.id,
         c.connector_code,
         c.connector_name,
         c.provider_type,
         c.transport_type,
         c.direction,
         c.endpoint_url,
         c.auth_type,
         c.status,
         c.timeout_seconds,
         c.retry_limit,
         c.retry_backoff_seconds,
         c.dead_letter_after,
         c.created_at,
         c.updated_at,
         COUNT(cr.id)::int AS credential_count
       FROM integration_connectors c
       LEFT JOIN integration_connector_credentials cr
         ON cr.company_id = c.company_id
        AND cr.connector_id = c.id
        AND cr.is_active = true
       WHERE c.company_id = $1
         AND ($2::text IS NULL OR c.provider_type = $2)
         AND ($3::text IS NULL OR c.status = $3)
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [access.companyId, provider || null, status || null]
    )

    return ok(rows.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch connectors"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = connectorSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const result = await db.query(
      `INSERT INTO integration_connectors (
         company_id,
         connector_code,
         connector_name,
         provider_type,
         transport_type,
         direction,
         endpoint_url,
         auth_type,
         status,
         timeout_seconds,
         retry_limit,
         retry_backoff_seconds,
         dead_letter_after,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (company_id, connector_code)
       DO UPDATE SET
         connector_name = EXCLUDED.connector_name,
         provider_type = EXCLUDED.provider_type,
         transport_type = EXCLUDED.transport_type,
         direction = EXCLUDED.direction,
         endpoint_url = EXCLUDED.endpoint_url,
         auth_type = EXCLUDED.auth_type,
         status = EXCLUDED.status,
         timeout_seconds = EXCLUDED.timeout_seconds,
         retry_limit = EXCLUDED.retry_limit,
         retry_backoff_seconds = EXCLUDED.retry_backoff_seconds,
         dead_letter_after = EXCLUDED.dead_letter_after,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        access.companyId,
        payload.connector_code.toUpperCase(),
        payload.connector_name,
        payload.provider_type,
        payload.transport_type,
        payload.direction,
        payload.endpoint_url || null,
        payload.auth_type,
        payload.status,
        payload.timeout_seconds,
        payload.retry_limit,
        payload.retry_backoff_seconds,
        payload.dead_letter_after,
        access.userId,
      ]
    )

    const row = result.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.connector.upsert",
        entityType: "integration_connectors",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Connector saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save connector"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
