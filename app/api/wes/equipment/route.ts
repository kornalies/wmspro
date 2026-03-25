import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { assertTransition, type EquipmentState } from "@/lib/wes/state-machine"
import { getWesAccess } from "@/app/api/wes/_utils"

const equipmentSchema = z.object({
  equipment_code: z.string().trim().min(2).max(60),
  equipment_name: z.string().trim().min(2).max(150),
  equipment_type: z.enum(["AMR", "CONVEYOR", "SORTER", "ASRS", "SHUTTLE", "PICK_ARM", "OTHER"]),
  adapter_type: z.enum(["MOCK", "REST", "MQTT", "PLC", "OPCUA"]).default("MOCK"),
  warehouse_id: z.number().int().positive().optional(),
  zone_layout_id: z.number().int().positive().optional(),
  status: z
    .enum(["OFFLINE", "IDLE", "READY", "BUSY", "CHARGING", "PAUSED", "FAULT", "ESTOP"])
    .default("IDLE"),
  heartbeat_timeout_seconds: z.number().int().min(10).max(600).default(60),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)

    const rows = await query(
      `SELECT
         e.id,
         e.equipment_code,
         e.equipment_name,
         e.equipment_type,
         e.adapter_type,
         e.warehouse_id,
         w.warehouse_name,
         e.zone_layout_id,
         e.status,
         e.safety_mode,
         e.heartbeat_timeout_seconds,
         e.last_heartbeat_at,
         e.last_error,
         e.updated_at
       FROM wes_equipment e
       LEFT JOIN warehouses w ON w.id = e.warehouse_id AND w.company_id = e.company_id
       WHERE e.company_id = $1
         AND ($2::text IS NULL OR e.status = $2)
         AND ($3::int = 0 OR e.warehouse_id = $3)
       ORDER BY e.updated_at DESC`,
      [access.companyId, status || null, warehouseId]
    )

    return ok(rows.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch equipment"
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

    const payload = equipmentSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const existing = await db.query(
      `SELECT id, status
       FROM wes_equipment
       WHERE company_id = $1
         AND equipment_code = $2
       LIMIT 1`,
      [access.companyId, payload.equipment_code.toUpperCase()]
    )

    if (existing.rows.length) {
      const current = existing.rows[0] as { id: number; status: EquipmentState }
      const transition = assertTransition(current.status, payload.status)
      if (!transition.ok) {
        await db.query("ROLLBACK")
        return fail("STATE_MACHINE_GUARD", transition.reason, 409)
      }
    }

    const result = await db.query(
      `INSERT INTO wes_equipment (
         company_id, equipment_code, equipment_name, equipment_type, adapter_type,
         warehouse_id, zone_layout_id, status, heartbeat_timeout_seconds, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT (company_id, equipment_code)
       DO UPDATE SET
         equipment_name = EXCLUDED.equipment_name,
         equipment_type = EXCLUDED.equipment_type,
         adapter_type = EXCLUDED.adapter_type,
         warehouse_id = EXCLUDED.warehouse_id,
         zone_layout_id = EXCLUDED.zone_layout_id,
         status = EXCLUDED.status,
         heartbeat_timeout_seconds = EXCLUDED.heartbeat_timeout_seconds,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        access.companyId,
        payload.equipment_code.toUpperCase(),
        payload.equipment_name,
        payload.equipment_type,
        payload.adapter_type,
        payload.warehouse_id || null,
        payload.zone_layout_id || null,
        payload.status,
        payload.heartbeat_timeout_seconds,
        access.userId,
      ]
    )

    const row = result.rows[0]
    await db.query(
      `INSERT INTO wes_event_log (company_id, equipment_id, event_type, event_payload, source_type, source_ref)
       VALUES ($1,$2,'STATUS',$3::jsonb,'OPERATOR','equipment.upsert')`,
      [
        access.companyId,
        row.id,
        JSON.stringify({ status: row.status, adapter_type: row.adapter_type }),
      ]
    )

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "wes.equipment.upsert",
        entityType: "wes_equipment",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Equipment saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save equipment"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
