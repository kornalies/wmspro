import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { requireFeature, requirePolicyPermission, guardToFailResponse } from "@/lib/policy/guards"
import { writeAudit } from "@/lib/audit"

const promoteSchema = z.object({
  user_id: z.number().positive(),
})

async function canPromote(session: { role: string; permissions?: string[]; companyCode?: string }) {
  if (session.permissions?.includes("admin.users.manage")) return true

  const superAdminCount = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'SUPER_ADMIN' AND is_active = true"
  )
  const hasAnySuperAdmin = Number(superAdminCount.rows[0]?.count || 0) > 0

    if (!hasAnySuperAdmin && session.role === "ADMIN" && session.companyCode === "DEFAULT") {
      return true
    }

  return false
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "admin.users.manage")

    const allowed = await canPromote(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can promote users", 403)

    const payload = promoteSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const userResult = await db.query(
      `SELECT id, username, role, company_id
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [payload.user_id]
    )

    if (!userResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "User not found", 404)
    }

    const target = userResult.rows[0]

    if (!session.permissions?.includes("admin.companies.manage") && Number(target.company_id) !== Number(session.companyId)) {
      await db.query("ROLLBACK")
      return fail("FORBIDDEN", "Cannot promote user from another company", 403)
    }

    if (target.role === "SUPER_ADMIN") {
      await db.query("ROLLBACK")
      return ok(target, "User is already SUPER_ADMIN")
    }

    await db.query(
      `UPDATE users
       SET role = 'SUPER_ADMIN', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [payload.user_id]
    )

    const superAdminRoleResult = await db.query(
      "SELECT id FROM rbac_roles WHERE role_code = 'SUPER_ADMIN' AND is_active = true LIMIT 1"
    )
    if (!superAdminRoleResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "SUPER_ADMIN role is not configured", 400)
    }

    await db.query("DELETE FROM rbac_user_roles WHERE user_id = $1", [payload.user_id])
    await db.query(
      `INSERT INTO rbac_user_roles (user_id, role_id, is_primary, assigned_by)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (user_id, role_id)
       DO UPDATE SET is_primary = true, assigned_by = EXCLUDED.assigned_by, assigned_at = CURRENT_TIMESTAMP`,
      [payload.user_id, Number(superAdminRoleResult.rows[0].id), session.userId]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "user.promote_super_admin",
        entityType: "users",
        entityId: payload.user_id,
        before: { role: target.role },
        after: { role: "SUPER_ADMIN" },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: target.id,
        username: target.username,
        role: "SUPER_ADMIN",
      },
      "User promoted to SUPER_ADMIN"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to promote user"
    return fail("PROMOTION_FAILED", message, 400)
  } finally {
    db.release()
  }
}
