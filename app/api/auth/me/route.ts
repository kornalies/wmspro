import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getUserAccessProfile } from "@/lib/rbac"

export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return fail("UNAUTHORIZED", "Not authenticated", 401)
    }

    const result = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.role, $2::int AS company_id, c.company_code, u.warehouse_id
       FROM users u
       JOIN companies c ON c.id = $2
       WHERE u.id = $1`,
      [session.userId, session.companyId]
    )

    if (result.rows.length === 0) {
      return fail("NOT_FOUND", "User not found", 404)
    }

    const access = await getUserAccessProfile(session.userId, session.role)

    return ok({
      ...result.rows[0],
      role: access.primaryRole,
      roles: access.roles,
      permissions: access.permissions,
    })
  } catch {
    return fail("SERVER_ERROR", "Failed to get user", 500)
  }
}
