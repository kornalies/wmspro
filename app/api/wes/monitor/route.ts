import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getWesAccess } from "@/app/api/wes/_utils"

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const equipmentId = Number(searchParams.get("equipment_id") || 0)

    const [equipment, queue, incidents] = await Promise.all([
      query(
        `SELECT
           id,
           equipment_code,
           equipment_name,
           equipment_type,
           adapter_type,
           status,
           safety_mode,
           last_heartbeat_at,
           last_error,
           updated_at
         FROM wes_equipment
         WHERE company_id = $1
           AND ($2::int = 0 OR id = $2)
         ORDER BY updated_at DESC`,
        [access.companyId, equipmentId]
      ),
      query(
        `SELECT
           COUNT(*)::int AS total_commands,
           COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
           COUNT(*) FILTER (WHERE status = 'RETRY')::int AS retry,
           COUNT(*) FILTER (WHERE status = 'DONE')::int AS done,
           COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter
         FROM wes_command_queue
         WHERE company_id = $1
           AND ($2::int = 0 OR equipment_id = $2)`,
        [access.companyId, equipmentId]
      ),
      query(
        `SELECT
           i.id,
           i.equipment_id,
           e.equipment_code,
           i.command_id,
           i.incident_type,
           i.severity,
           i.status,
           i.reason,
           i.opened_at,
           i.closed_at
         FROM wes_failover_incidents i
         LEFT JOIN wes_equipment e ON e.id = i.equipment_id AND e.company_id = i.company_id
         WHERE i.company_id = $1
           AND ($2::int = 0 OR i.equipment_id = $2)
         ORDER BY i.opened_at DESC
         LIMIT 200`,
        [access.companyId, equipmentId]
      ),
    ])

    return ok({
      summary: queue.rows[0] || {},
      equipment: equipment.rows,
      incidents: incidents.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch WES monitor"
    return fail("SERVER_ERROR", message, 500)
  }
}
