import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { invalidateEffectivePolicyCache } from "@/lib/policy/cache"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

const updateSchema = z.object({
  user_id: z.number().int().positive(),
  warehouse_ids: z.array(z.number().int().positive()).default([]),
  zone_ids: z.array(z.number().int().positive()).default([]),
  client_ids: z.array(z.number().int().positive()).default([]),
})

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "scopes.read")

    const url = new URL(request.url)
    const userId = Number(url.searchParams.get("user_id") || 0)

    const usersResult = await query(
      `SELECT id, username, full_name, role, is_active
       FROM users
       WHERE company_id = $1
       ORDER BY full_name ASC`,
      [session.companyId]
    )

    const scopeResult = await query(
      `SELECT id, user_id, scope_type, scope_id, created_at
       FROM user_scopes
       WHERE company_id = $1
         AND ($2::int = 0 OR user_id = $2)
       ORDER BY user_id ASC, scope_type ASC, scope_id ASC`,
      [session.companyId, userId]
    )

    return ok({
      users: usersResult.rows,
      scopes: scopeResult.rows,
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch scopes"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PUT(request: Request) {
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
    requirePolicyPermission(policy, "scopes.update")

    const payload = updateSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const beforeResult = await db.query(
      `SELECT scope_type, scope_id
       FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2
       ORDER BY scope_type, scope_id`,
      [session.companyId, payload.user_id]
    )

    await db.query(
      `DELETE FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2`,
      [session.companyId, payload.user_id]
    )

    const rows: Array<[string, number]> = [
      ...payload.warehouse_ids.map((id) => ["warehouse", id] as [string, number]),
      ...payload.zone_ids.map((id) => ["zone", id] as [string, number]),
      ...payload.client_ids.map((id) => ["client", id] as [string, number]),
    ]

    for (const [scopeType, scopeId] of rows) {
      await db.query(
        `INSERT INTO user_scopes (company_id, user_id, scope_type, scope_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, user_id, scope_type, scope_id) DO NOTHING`,
        [session.companyId, payload.user_id, scopeType, scopeId]
      )
    }

    const afterResult = await db.query(
      `SELECT scope_type, scope_id
       FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2
       ORDER BY scope_type, scope_id`,
      [session.companyId, payload.user_id]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "user_scopes.update",
        entityType: "user",
        entityId: String(payload.user_id),
        before: beforeResult.rows,
        after: afterResult.rows,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    invalidateEffectivePolicyCache(session.companyId)
    return ok({ user_id: payload.user_id, scopes: afterResult.rows }, "Scopes updated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update scopes"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
