import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { getWesAccess } from "@/app/api/wes/_utils"

const commandSchema = z.object({
  equipment_id: z.number().int().positive(),
  command_type: z.enum(["MOVE", "PICK", "DROP", "CHARGE", "PAUSE", "RESUME", "RESET", "ESTOP", "CUSTOM"]),
  command_payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(100).default(50),
  max_attempts: z.number().int().min(1).max(20).default(3),
  correlation_id: z.string().trim().max(120).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const equipmentId = Number(searchParams.get("equipment_id") || 0)
    const status = searchParams.get("status")

    const result = await query(
      `SELECT
         c.id,
         c.equipment_id,
         e.equipment_code,
         e.equipment_name,
         c.command_type,
         c.priority,
         c.status,
         c.attempt_count,
         c.max_attempts,
         c.last_error,
         c.next_attempt_at,
         c.created_at,
         c.updated_at
       FROM wes_command_queue c
       JOIN wes_equipment e ON e.id = c.equipment_id AND e.company_id = c.company_id
       WHERE c.company_id = $1
         AND ($2::int = 0 OR c.equipment_id = $2)
         AND ($3::text IS NULL OR c.status = $3)
       ORDER BY c.created_at DESC
       LIMIT 500`,
      [access.companyId, equipmentId, status || null]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch command queue"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = commandSchema.parse(await request.json())
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `wes.command.create:${payload.equipment_id}:${payload.command_type}:${payload.correlation_id || "na"}`
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

    const equipment = await db.query(
      `SELECT id, status, safety_mode
       FROM wes_equipment
       WHERE company_id = $1
         AND id = $2
       LIMIT 1`,
      [access.companyId, payload.equipment_id]
    )
    if (!equipment.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Equipment not found", 404)
    }
    const eq = equipment.rows[0] as { status: string; safety_mode: boolean }
    if (eq.safety_mode) {
      await db.query("ROLLBACK")
      return fail("SAFETY_LOCK", "Equipment is in safety mode; commands are blocked", 409)
    }
    if (["FAULT", "ESTOP", "OFFLINE"].includes(String(eq.status))) {
      await db.query("ROLLBACK")
      return fail("STATE_BLOCKED", `Cannot dispatch command while equipment is ${eq.status}`, 409)
    }

    const created = await db.query(
      `INSERT INTO wes_command_queue (
         company_id, equipment_id, command_type, command_payload, correlation_id,
         requested_by, priority, max_attempts, status
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'QUEUED')
       RETURNING *`,
      [
        access.companyId,
        payload.equipment_id,
        payload.command_type,
        JSON.stringify(payload.command_payload),
        payload.correlation_id || null,
        access.userId,
        payload.priority,
        payload.max_attempts,
      ]
    )
    const row = created.rows[0]

    await db.query(
      `INSERT INTO wes_event_log (company_id, equipment_id, command_id, event_type, event_payload, source_type, source_ref)
       VALUES ($1,$2,$3,'STATUS',$4::jsonb,'OPERATOR','command.queued')`,
      [
        access.companyId,
        payload.equipment_id,
        row.id,
        JSON.stringify({ command_type: payload.command_type, priority: payload.priority }),
      ]
    )

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "wes.command.create",
        entityType: "wes_command_queue",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    const responseBody = { id: row.id, status: row.status }
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: access.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Command queued")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to queue command"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
