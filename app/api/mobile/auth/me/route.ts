import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const result = await query(
      `SELECT
        u.id,
        u.username,
        u.full_name,
        u.email,
        u.warehouse_id,
        w.warehouse_code,
        w.warehouse_name,
        c.company_code
       FROM users u
       LEFT JOIN warehouses w ON w.id = u.warehouse_id AND w.company_id = u.company_id
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1
       LIMIT 1`,
      [session.userId]
    )

    if (!result.rows.length) return fail("NOT_FOUND", "User not found", 404)

    const scopeResult = await query(
      `SELECT scope_id
       FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2
         AND scope_type = 'warehouse'`,
      [session.companyId, session.userId]
    )
    const scopedWarehouseIds = scopeResult.rows
      .map((row: { scope_id: number }) => Number(row.scope_id))
      .filter((id: number) => Number.isFinite(id) && id > 0)

    let allowedWarehouses: Array<{ id: number; warehouse_code: string; warehouse_name: string }> = []
    if (scopedWarehouseIds.length > 0) {
      const scopedWarehousesResult = await query(
        `SELECT id, warehouse_code, warehouse_name
         FROM warehouses
         WHERE company_id = $1
           AND is_active = true
           AND id = ANY($2::int[])
         ORDER BY warehouse_name ASC`,
        [session.companyId, scopedWarehouseIds]
      )
      allowedWarehouses = scopedWarehousesResult.rows
    } else if (result.rows[0].warehouse_id) {
      allowedWarehouses = [
        {
          id: Number(result.rows[0].warehouse_id),
          warehouse_code: String(result.rows[0].warehouse_code || ""),
          warehouse_name: String(result.rows[0].warehouse_name || ""),
        },
      ]
    } else if (String(session.role || "").toUpperCase() === "SUPER_ADMIN" || String(session.role || "").toUpperCase() === "ADMIN") {
      const allWarehousesResult = await query(
        `SELECT id, warehouse_code, warehouse_name
         FROM warehouses
         WHERE company_id = $1
           AND is_active = true
         ORDER BY warehouse_name ASC`,
        [session.companyId]
      )
      allowedWarehouses = allWarehousesResult.rows
    }

    const dedupedAllowedWarehouses = Array.from(
      new Map(
        allowedWarehouses.map((warehouse) => [
          Number(warehouse.id),
          {
            id: Number(warehouse.id),
            warehouse_code: String(warehouse.warehouse_code || ""),
            warehouse_name: String(warehouse.warehouse_name || ""),
          },
        ])
      ).values()
    ).sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name))

    return ok({
      ...result.rows[0],
      role: session.role,
      roles: session.roles || [session.role],
      permissions: session.permissions || [],
      company_id: session.companyId,
      company_code: session.companyCode || result.rows[0].company_code,
      warehouse: result.rows[0].warehouse_id
        ? {
            id: Number(result.rows[0].warehouse_id),
            code: String(result.rows[0].warehouse_code || ""),
            name: String(result.rows[0].warehouse_name || ""),
          }
        : null,
      allowed_warehouses: dedupedAllowedWarehouses,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch profile"
    return fail("SERVER_ERROR", message, 500)
  }
}
