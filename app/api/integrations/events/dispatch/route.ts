import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

const dispatchSchema = z.object({
  connector_id: z.number().int().positive(),
  mapping_id: z.number().int().positive().optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("OUTBOUND"),
  entity_type: z.string().trim().min(2).max(40),
  entity_id: z.string().trim().max(120).optional(),
  request_payload: z.record(z.string(), z.unknown()),
})

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = dispatchSchema.parse(await request.json())
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `integration.dispatch:${payload.connector_id}:${payload.direction}:${payload.entity_type}:${payload.entity_id || "na"}`

    if (idempotencyKey) {
      const cached = await getIdempotentResponse({
        companyId: access.companyId,
        key: idempotencyKey,
        routeKey,
      })
      if (cached) return ok(cached.body as Record<string, unknown>, "Idempotent replay")
    }

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const connector = await db.query(
      `SELECT id, status
       FROM integration_connectors
       WHERE company_id = $1
         AND id = $2`,
      [access.companyId, payload.connector_id]
    )
    if (!connector.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Connector not found", 404)
    }
    if (String(connector.rows[0].status) !== "ACTIVE") {
      await db.query("ROLLBACK")
      return fail("CONNECTOR_INACTIVE", "Connector is not active", 409)
    }

    const insert = await db.query(
      `INSERT INTO integration_events (
         company_id,
         connector_id,
         mapping_id,
         direction,
         entity_type,
         entity_id,
         idempotency_key,
         request_payload,
         status,
         attempt_count,
         created_at,
         updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'QUEUED',0,NOW(),NOW())
       ON CONFLICT (company_id, connector_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET updated_at = NOW()
       RETURNING id, status, created_at`,
      [
        access.companyId,
        payload.connector_id,
        payload.mapping_id || null,
        payload.direction,
        payload.entity_type.toUpperCase(),
        payload.entity_id || null,
        idempotencyKey || null,
        JSON.stringify(payload.request_payload),
      ]
    )

    const row = insert.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.event.dispatch",
        entityType: "integration_events",
        entityId: String(row.id),
        after: {
          connector_id: payload.connector_id,
          direction: payload.direction,
          entity_type: payload.entity_type,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    const responseBody = { id: row.id, status: row.status, queued_at: row.created_at }
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: access.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Event queued")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to queue integration event"
    return fail("DISPATCH_FAILED", message, 400)
  } finally {
    db.release()
  }
}
