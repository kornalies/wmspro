import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getLaborAccess } from "@/app/api/labor/_utils"

const createAssignmentSchema = z.object({
  shift_id: z.number().int().positive(),
  shift_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  user_id: z.number().int().positive(),
  assignment_role: z.string().trim().min(2).max(50).default("OPERATOR"),
  assignment_status: z.enum(["ASSIGNED", "ABSENT", "REPLACED", "OFF"]).default("ASSIGNED"),
  remarks: z.string().trim().max(400).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const shiftDate = searchParams.get("shift_date")
    const shiftId = Number(searchParams.get("shift_id") || 0)

    const result = await query(
      `SELECT
         a.id,
         a.shift_id,
         s.shift_code,
         s.shift_name,
         a.shift_date::text AS shift_date,
         a.user_id,
         u.full_name AS user_name,
         a.assignment_role,
         a.assignment_status,
         a.remarks,
         a.created_at
       FROM labor_shift_assignments a
       JOIN labor_shifts s ON s.id = a.shift_id AND s.company_id = a.company_id
       JOIN users u ON u.id = a.user_id AND u.company_id = a.company_id
       WHERE a.company_id = $1
         AND ($2::date IS NULL OR a.shift_date = $2::date)
         AND ($3::int = 0 OR a.shift_id = $3)
       ORDER BY a.shift_date DESC, s.shift_name ASC, u.full_name ASC
       LIMIT 500`,
      [access.companyId, shiftDate || null, shiftId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor assignments"
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

    const payload = createAssignmentSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const created = await db.query(
      `INSERT INTO labor_shift_assignments (
         company_id,
         shift_id,
         shift_date,
         user_id,
         assignment_role,
         assignment_status,
         remarks,
         created_by
       ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, shift_id, shift_date, user_id)
       DO UPDATE SET
         assignment_role = EXCLUDED.assignment_role,
         assignment_status = EXCLUDED.assignment_status,
         remarks = EXCLUDED.remarks,
         updated_at = NOW()
       RETURNING
         id,
         shift_id,
         shift_date::text AS shift_date,
         user_id,
         assignment_role,
         assignment_status,
         remarks`,
      [
        access.companyId,
        payload.shift_id,
        payload.shift_date,
        payload.user_id,
        payload.assignment_role.toUpperCase(),
        payload.assignment_status,
        payload.remarks || null,
        access.userId,
      ]
    )

    const row = created.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "labor.shift.assignment.upsert",
        entityType: "labor_shift_assignments",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Shift assignment saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save labor assignment"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
