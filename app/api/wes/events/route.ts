import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { assertTransition, type EquipmentState } from "@/lib/wes/state-machine"
import { getWesAccess } from "@/app/api/wes/_utils"

const eventSchema = z.object({
  equipment_id: z.number().int().positive(),
  event_type: z.enum(["HEARTBEAT", "STATUS", "COMMAND_ACCEPTED", "COMMAND_FAILED", "COMMAND_DONE", "SAFETY_TRIP", "ALARM", "CUSTOM"]),
  equipment_status: z
    .enum(["OFFLINE", "IDLE", "READY", "BUSY", "CHARGING", "PAUSED", "FAULT", "ESTOP"])
    .optional(),
  command_id: z.number().int().positive().optional(),
  source_ref: z.string().trim().max(120).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const equipmentId = Number(searchParams.get("equipment_id") || 0)

    const result = await query(
      `SELECT
         ev.id,
         ev.equipment_id,
         e.equipment_code,
         ev.command_id,
         ev.event_type,
         ev.event_payload,
         ev.source_type,
         ev.source_ref,
         ev.created_at
       FROM wes_event_log ev
       LEFT JOIN wes_equipment e ON e.id = ev.equipment_id AND e.company_id = ev.company_id
       WHERE ev.company_id = $1
         AND ($2::int = 0 OR ev.equipment_id = $2)
       ORDER BY ev.created_at DESC
       LIMIT 500`,
      [access.companyId, equipmentId]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch WES events"
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

    const payload = eventSchema.parse(await request.json())
    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const equipment = await db.query(
      `SELECT id, status
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

    const currentStatus = String(equipment.rows[0].status) as EquipmentState
    const nextStatus = payload.equipment_status
      ? (payload.equipment_status as EquipmentState)
      : currentStatus
    const transition = assertTransition(currentStatus, nextStatus)
    if (!transition.ok) {
      await db.query("ROLLBACK")
      return fail("STATE_MACHINE_GUARD", transition.reason, 409)
    }

    await db.query(
      `INSERT INTO wes_event_log (
         company_id, equipment_id, command_id, event_type, event_payload, source_type, source_ref
       ) VALUES ($1,$2,$3,$4,$5::jsonb,'DEVICE',$6)`,
      [
        access.companyId,
        payload.equipment_id,
        payload.command_id || null,
        payload.event_type,
        JSON.stringify(payload.payload || {}),
        payload.source_ref || "device.event",
      ]
    )

    await db.query(
      `UPDATE wes_equipment
       SET status = $1,
           last_heartbeat_at = CASE WHEN $2 = 'HEARTBEAT' THEN NOW() ELSE last_heartbeat_at END,
           safety_mode = CASE WHEN $2 = 'SAFETY_TRIP' THEN true ELSE safety_mode END,
           last_error = CASE WHEN $2 IN ('ALARM', 'COMMAND_FAILED', 'SAFETY_TRIP') THEN COALESCE($3, last_error) ELSE NULL END,
           updated_at = NOW()
       WHERE company_id = $4
         AND id = $5`,
      [
        nextStatus,
        payload.event_type,
        typeof payload.payload?.error === "string" ? payload.payload.error : null,
        access.companyId,
        payload.equipment_id,
      ]
    )

    if (payload.event_type === "SAFETY_TRIP") {
      await db.query(
        `INSERT INTO wes_failover_incidents (
           company_id, equipment_id, command_id, incident_type, severity, status, reason, context
         ) VALUES ($1,$2,$3,'SAFETY_TRIP','CRITICAL','OPEN',$4,$5::jsonb)`,
        [
          access.companyId,
          payload.equipment_id,
          payload.command_id || null,
          String(payload.payload?.reason || "Safety trip event received"),
          JSON.stringify(payload.payload || {}),
        ]
      )
    }

    await db.query("COMMIT")
    return ok({ equipment_id: payload.equipment_id, event_type: payload.event_type }, "Event accepted")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to ingest event"
    return fail("INGEST_FAILED", message, 400)
  } finally {
    db.release()
  }
}
