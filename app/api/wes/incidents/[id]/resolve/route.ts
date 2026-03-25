import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getWesAccess } from "@/app/api/wes/_utils"

const resolveSchema = z.object({
  resolution_notes: z.string().trim().min(3).max(2000),
  close_equipment_safety_mode: z.boolean().default(false),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const incidentId = Number((await context.params).id || 0)
    if (!incidentId) return fail("VALIDATION_ERROR", "Invalid incident id", 400)
    const payload = resolveSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const result = await db.query(
      `UPDATE wes_failover_incidents
       SET status = 'RESOLVED',
           closed_at = NOW(),
           resolved_by = $1,
           resolution_notes = $2
       WHERE company_id = $3
         AND id = $4
         AND status IN ('OPEN', 'ACKNOWLEDGED')
       RETURNING id, equipment_id, incident_type, status`,
      [access.userId, payload.resolution_notes, access.companyId, incidentId]
    )
    if (!result.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Open incident not found", 404)
    }

    const incident = result.rows[0] as { equipment_id: number | null }
    if (payload.close_equipment_safety_mode && incident.equipment_id) {
      await db.query(
        `UPDATE wes_equipment
         SET safety_mode = false,
             status = CASE WHEN status IN ('FAULT', 'OFFLINE') THEN 'IDLE' ELSE status END,
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2`,
        [access.companyId, incident.equipment_id]
      )
    }

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "wes.incident.resolve",
        entityType: "wes_failover_incidents",
        entityId: String(incidentId),
        after: {
          resolution_notes: payload.resolution_notes,
          close_equipment_safety_mode: payload.close_equipment_safety_mode,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(result.rows[0], "Incident resolved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to resolve incident"
    return fail("RESOLVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
