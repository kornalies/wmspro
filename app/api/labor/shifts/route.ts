import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getLaborAccess } from "@/app/api/labor/_utils"

const createShiftSchema = z.object({
  shift_code: z.string().trim().min(1).max(30),
  shift_name: z.string().trim().min(2).max(120),
  warehouse_id: z.number().int().positive().optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  planned_headcount: z.number().int().positive().max(500).default(1),
  break_minutes: z.number().int().min(0).max(240).default(30),
  is_overnight: z.boolean().default(false),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const shiftDate = searchParams.get("shift_date")
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const onlyActive = searchParams.get("active") !== "false"

    const result = await query(
      `SELECT
         s.id,
         s.shift_code,
         s.shift_name,
         s.warehouse_id,
         w.warehouse_name,
         to_char(s.start_time, 'HH24:MI') AS start_time,
         to_char(s.end_time, 'HH24:MI') AS end_time,
         s.planned_headcount,
         s.break_minutes,
         s.is_overnight,
         s.is_active,
         COALESCE(a.assigned_headcount, 0)::int AS assigned_headcount
       FROM labor_shifts s
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
       LEFT JOIN (
         SELECT
           shift_id,
           COUNT(*) FILTER (WHERE assignment_status = 'ASSIGNED') AS assigned_headcount
         FROM labor_shift_assignments
         WHERE company_id = $1
           AND ($2::date IS NULL OR shift_date = $2::date)
         GROUP BY shift_id
       ) a ON a.shift_id = s.id
       WHERE s.company_id = $1
         AND ($3::boolean = false OR s.is_active = true)
         AND ($4::int = 0 OR s.warehouse_id = $4)
       ORDER BY s.shift_name ASC`,
      [access.companyId, shiftDate || null, onlyActive, warehouseId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor shifts"
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

    const payload = createShiftSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const created = await db.query(
      `INSERT INTO labor_shifts (
         company_id,
         shift_code,
         shift_name,
         warehouse_id,
         start_time,
         end_time,
         planned_headcount,
         break_minutes,
         is_overnight,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9,$10,$10)
       ON CONFLICT (company_id, shift_code)
       DO UPDATE SET
         shift_name = EXCLUDED.shift_name,
         warehouse_id = EXCLUDED.warehouse_id,
         start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time,
         planned_headcount = EXCLUDED.planned_headcount,
         break_minutes = EXCLUDED.break_minutes,
         is_overnight = EXCLUDED.is_overnight,
         is_active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING
         id,
         shift_code,
         shift_name,
         warehouse_id,
         to_char(start_time, 'HH24:MI') AS start_time,
         to_char(end_time, 'HH24:MI') AS end_time,
         planned_headcount,
         break_minutes,
         is_overnight,
         is_active`,
      [
        access.companyId,
        payload.shift_code.toUpperCase(),
        payload.shift_name,
        payload.warehouse_id || null,
        payload.start_time,
        payload.end_time,
        payload.planned_headcount,
        payload.break_minutes,
        payload.is_overnight,
        access.userId,
      ]
    )

    const row = created.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "labor.shift.upsert",
        entityType: "labor_shifts",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Labor shift saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save labor shift"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
