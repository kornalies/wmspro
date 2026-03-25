import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { ensurePortalTables } from "@/lib/portal"

function canManagePortalMappings(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return false
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return true
  if (session.permissions?.includes("admin.users.manage")) return true
  if (session.permissions?.includes("admin.companies.manage")) return true
  return false
}

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!canManagePortalMappings(session)) {
      return fail("FORBIDDEN", "Insufficient permissions", 403)
    }

    await ensurePortalTables()

    const adminSeed = await query(
      `INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
       SELECT u.company_id, u.id, c.id, true
       FROM users u
       LEFT JOIN LATERAL (
         SELECT r.role_code
         FROM rbac_user_roles ur
         JOIN rbac_roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND r.is_active = true
         ORDER BY ur.is_primary DESC, r.role_code ASC
         LIMIT 1
       ) primary_role ON true
       JOIN clients c ON c.company_id = u.company_id AND c.is_active = true
       WHERE u.is_active = true
         AND UPPER(COALESCE(primary_role.role_code, u.role)) IN ('SUPER_ADMIN', 'ADMIN')
       ON CONFLICT (company_id, user_id, client_id)
       DO UPDATE SET is_active = EXCLUDED.is_active
       RETURNING id`
    )

    const clientSeed = await query(
      `INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
       SELECT u.company_id, u.id, c.id, true
       FROM users u
       LEFT JOIN LATERAL (
         SELECT r.role_code
         FROM rbac_user_roles ur
         JOIN rbac_roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND r.is_active = true
         ORDER BY ur.is_primary DESC, r.role_code ASC
         LIMIT 1
       ) primary_role ON true
       JOIN clients c
         ON c.company_id = u.company_id
        AND c.is_active = true
        AND (
          UPPER(c.client_code) = UPPER(u.username)
          OR UPPER(c.client_code) = UPPER(split_part(COALESCE(u.email, ''), '@', 1))
        )
       WHERE u.is_active = true
         AND UPPER(COALESCE(primary_role.role_code, u.role)) IN ('CLIENT', 'VIEWER')
       ON CONFLICT (company_id, user_id, client_id)
       DO UPDATE SET is_active = EXCLUDED.is_active
       RETURNING id`
    )

    const total = await query(
      `SELECT COUNT(*)::int AS count
       FROM portal_user_clients
       WHERE is_active = true`
    )

    return ok({
      admin_seeded: adminSeed.rowCount || 0,
      client_seeded: clientSeed.rowCount || 0,
      total_active_mappings: Number(total.rows[0]?.count || 0),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to auto-seed portal mappings"
    return fail("SEED_FAILED", message, 400)
  }
}
