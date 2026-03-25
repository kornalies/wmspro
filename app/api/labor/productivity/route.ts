import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getLaborAccess } from "@/app/api/labor/_utils"

const createProductivitySchema = z.object({
  standard_id: z.number().int().positive(),
  shift_id: z.number().int().positive().optional(),
  assignment_id: z.number().int().positive().optional(),
  warehouse_id: z.number().int().positive().optional(),
  client_id: z.number().int().positive().optional(),
  user_id: z.number().int().positive().optional(),
  source_type: z.enum(["MANUAL", "TASK", "SCAN"]).default("MANUAL"),
  source_ref: z.string().trim().max(120).optional(),
  event_ts: z.string().datetime().optional(),
  quantity: z.number().positive(),
  duration_minutes: z.number().positive(),
  quality_score: z.number().min(0).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const from = searchParams.get("from")
    const to = searchParams.get("to")
    const userId = Number(searchParams.get("user_id") || 0)
    const shiftId = Number(searchParams.get("shift_id") || 0)

    const result = await query(
      `SELECT
         e.id,
         e.standard_id,
         s.operation_code,
         s.operation_name,
         s.unit_of_measure,
         s.standard_units_per_hour::float8 AS standard_units_per_hour,
         e.shift_id,
         sh.shift_name,
         e.user_id,
         u.full_name AS user_name,
         e.source_type,
         e.source_ref,
         e.event_ts,
         e.quantity::float8 AS quantity,
         e.duration_minutes::float8 AS duration_minutes,
         ROUND((e.quantity / NULLIF(e.duration_minutes, 0) * 60)::numeric, 2)::float8 AS actual_units_per_hour,
         ROUND(((e.quantity / NULLIF(e.duration_minutes, 0) * 60) / NULLIF(s.standard_units_per_hour, 0) * 100)::numeric, 2)::float8 AS performance_pct,
         e.quality_score::float8 AS quality_score,
         e.notes
       FROM labor_productivity_events e
       JOIN labor_standards s ON s.id = e.standard_id AND s.company_id = e.company_id
       LEFT JOIN labor_shifts sh ON sh.id = e.shift_id AND sh.company_id = e.company_id
       LEFT JOIN users u ON u.id = e.user_id AND u.company_id = e.company_id
       WHERE e.company_id = $1
         AND ($2::timestamptz IS NULL OR e.event_ts >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR e.event_ts <= $3::timestamptz)
         AND ($4::int = 0 OR e.user_id = $4)
         AND ($5::int = 0 OR e.shift_id = $5)
       ORDER BY e.event_ts DESC
       LIMIT 500`,
      [access.companyId, from || null, to || null, userId, shiftId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor productivity"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = createProductivitySchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const created = await db.query(
      `INSERT INTO labor_productivity_events (
         company_id,
         standard_id,
         shift_id,
         assignment_id,
         warehouse_id,
         client_id,
         user_id,
         source_type,
         source_ref,
         event_ts,
         quantity,
         duration_minutes,
         quality_score,
         notes,
         created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14,$15)
       RETURNING
         id,
         standard_id,
         shift_id,
         assignment_id,
         warehouse_id,
         client_id,
         user_id,
         source_type,
         source_ref,
         event_ts,
         quantity::float8 AS quantity,
         duration_minutes::float8 AS duration_minutes,
         quality_score::float8 AS quality_score,
         notes`,
      [
        access.companyId,
        payload.standard_id,
        payload.shift_id || null,
        payload.assignment_id || null,
        payload.warehouse_id || null,
        payload.client_id || null,
        payload.user_id || null,
        payload.source_type,
        payload.source_ref || null,
        payload.event_ts || new Date().toISOString(),
        payload.quantity,
        payload.duration_minutes,
        payload.quality_score ?? null,
        payload.notes || null,
        access.userId,
      ]
    )

    const row = created.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "labor.productivity.record",
        entityType: "labor_productivity_events",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Productivity event saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save labor productivity event"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
