import { query } from "@/lib/db"
import { normalizeRoleCode, normalizeRoleCodes } from "@/lib/role-utils"

export type AccessProfile = {
  primaryRole: string
  roles: string[]
  permissions: string[]
}

export async function getUserAccessProfile(userId: number, fallbackRole?: string): Promise<AccessProfile> {
  const rolesResult = await query(
    `SELECT r.role_code
     FROM rbac_user_roles ur
     JOIN rbac_roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.is_active = true
     ORDER BY ur.is_primary DESC, r.role_code ASC`,
    [userId]
  )

  const roles = rolesResult.rows.map((row: { role_code: string }) => normalizeRoleCode(row.role_code))
  const normalizedRoles = roles.length
    ? normalizeRoleCodes(roles)
    : fallbackRole
      ? normalizeRoleCodes([fallbackRole])
      : []
  const primaryRole = normalizedRoles[0] || "OPERATOR"

  const permsResult = await query(
    `SELECT DISTINCT p.permission_key
     FROM rbac_user_roles ur
     JOIN rbac_roles r ON r.id = ur.role_id
     JOIN rbac_role_permissions rp ON rp.role_id = r.id
     JOIN rbac_permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1
       AND r.is_active = true
       AND p.is_active = true
     ORDER BY p.permission_key ASC`,
    [userId]
  )

  const permissions = permsResult.rows.map((row: { permission_key: string }) =>
    String(row.permission_key)
  )
  return {
    primaryRole,
    roles: normalizedRoles,
    permissions,
  }
}

export function hasPermission(permissions: string[] | undefined, key: string) {
  if (!permissions || !permissions.length) return false
  return permissions.includes(key)
}
