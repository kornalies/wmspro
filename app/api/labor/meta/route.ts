import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getLaborAccess } from "@/app/api/labor/_utils"

export async function GET() {
  try {
    const accessResult = await getLaborAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const [usersResult, warehousesResult, standardsResult, shiftsResult] = await Promise.all([
      query(
        `SELECT id, full_name
         FROM users
         WHERE company_id = $1
           AND is_active = true
         ORDER BY full_name ASC
         LIMIT 500`,
        [access.companyId]
      ),
      query(
        `SELECT id, warehouse_name
         FROM warehouses
         WHERE company_id = $1
           AND is_active = true
         ORDER BY warehouse_name ASC`,
        [access.companyId]
      ),
      query(
        `SELECT id, operation_code, operation_name, unit_of_measure
         FROM labor_standards
         WHERE company_id = $1
           AND is_active = true
         ORDER BY operation_name ASC`,
        [access.companyId]
      ),
      query(
        `SELECT id, shift_code, shift_name
         FROM labor_shifts
         WHERE company_id = $1
           AND is_active = true
         ORDER BY shift_name ASC`,
        [access.companyId]
      ),
    ])

    return ok({
      users: usersResult.rows,
      warehouses: warehousesResult.rows,
      standards: standardsResult.rows,
      shifts: shiftsResult.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch labor metadata"
    return fail("SERVER_ERROR", message, 500)
  }
}
