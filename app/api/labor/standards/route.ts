import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getLaborAccess } from "@/app/api/labor/_utils"

const createStandardSchema = z.object({
  operation_code: z.string().trim().min(2).max(50),
  operation_name: z.string().trim().min(2).max(150),
  unit_of_measure: z.string().trim().min(1).max(20).default("UNITS"),
  standard_units_per_hour: z.number().positive(),
  warning_threshold_pct: z.number().positive().max(200).default(85),
  critical_threshold_pct: z.number().positive().max(200).default(65),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const onlyActive = searchParams.get("active") !== "false"

    const result = await query(
      `SELECT
         id,
         operation_code,
         operation_name,
         unit_of_measure,
         standard_units_per_hour::float8 AS standard_units_per_hour,
         warning_threshold_pct::float8 AS warning_threshold_pct,
         critical_threshold_pct::float8 AS critical_threshold_pct,
         is_active,
         created_at,
         updated_at
       FROM labor_standards
       WHERE company_id = $1
         AND ($2::boolean = false OR is_active = true)
       ORDER BY operation_name ASC`,
      [access.companyId, onlyActive]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor standards"
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

    const payload = createStandardSchema.parse(await request.json())
    if (payload.critical_threshold_pct > payload.warning_threshold_pct) {
      return fail(
        "INVALID_THRESHOLD",
        "Critical threshold cannot be greater than warning threshold",
        400
      )
    }

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const created = await db.query(
      `INSERT INTO labor_standards (
         company_id,
         operation_code,
         operation_name,
         unit_of_measure,
         standard_units_per_hour,
         warning_threshold_pct,
         critical_threshold_pct,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (company_id, operation_code)
       DO UPDATE SET
         operation_name = EXCLUDED.operation_name,
         unit_of_measure = EXCLUDED.unit_of_measure,
         standard_units_per_hour = EXCLUDED.standard_units_per_hour,
         warning_threshold_pct = EXCLUDED.warning_threshold_pct,
         critical_threshold_pct = EXCLUDED.critical_threshold_pct,
         is_active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING
         id,
         operation_code,
         operation_name,
         unit_of_measure,
         standard_units_per_hour::float8 AS standard_units_per_hour,
         warning_threshold_pct::float8 AS warning_threshold_pct,
         critical_threshold_pct::float8 AS critical_threshold_pct,
         is_active`,
      [
        access.companyId,
        payload.operation_code.toUpperCase(),
        payload.operation_name,
        payload.unit_of_measure.toUpperCase(),
        payload.standard_units_per_hour,
        payload.warning_threshold_pct,
        payload.critical_threshold_pct,
        access.userId,
      ]
    )

    const row = created.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "labor.standard.upsert",
        entityType: "labor_standards",
        entityId: String(row.id),
        after: row,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Labor standard saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save labor standard"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
