import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")

    const policy = await getEffectivePolicy(session.companyId, session.userId, resolvePolicyActorType(session))
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const warehouseId = Number(request.nextUrl.searchParams.get("warehouse_id") || 0)
    if (warehouseId) requireScope(policy, "warehouse", warehouseId)

    const params: Array<number | string[]> = [
      session.companyId,
      ["WAREHOUSE_MANAGER", "SUPERVISOR", "OPERATOR", "OPERATIONS", "GATE_STAFF"],
    ]
    let warehouseClause = ""
    if (warehouseId) {
      params.push(warehouseId)
      warehouseClause = "AND (u.warehouse_id = $3 OR u.warehouse_id IS NULL)"
    }

    const result = await query(
      `SELECT
         u.id,
         u.full_name,
         u.username,
         COALESCE(rr.role_code, u.role) AS role,
         u.warehouse_id,
         w.warehouse_name
       FROM users u
       LEFT JOIN rbac_user_roles rur
         ON rur.user_id = u.id
        AND rur.is_primary = true
       LEFT JOIN rbac_roles rr
         ON rr.id = rur.role_id
        AND rr.is_active = true
       LEFT JOIN warehouses w
         ON w.id = u.warehouse_id
        AND w.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.is_active = true
         AND COALESCE(rr.role_code, u.role) = ANY($2::text[])
         ${warehouseClause}
       ORDER BY
         CASE WHEN u.warehouse_id IS NULL THEN 1 ELSE 0 END,
         u.full_name ASC`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch wave pickers"
    return fail("SERVER_ERROR", message, 500)
  }
}
