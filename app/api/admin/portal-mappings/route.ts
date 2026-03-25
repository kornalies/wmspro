import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { writeAudit } from "@/lib/audit"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { ensurePortalTables } from "@/lib/portal"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission } from "@/lib/policy/guards"

const updateSchema = z.object({
  user_id: z.number().int().positive(),
  client_ids: z.array(z.number().int().positive()).default([]),
  feature_permissions: z.array(z.string().min(3).max(80)).default([]),
})

async function requirePortalMappingPolicy(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  requirePermission(session, "admin.users.manage")
  const policy = await getEffectivePolicy(
    session.companyId,
    session.userId,
    resolvePolicyActorType(session)
  )
  requireFeature(policy, "admin")
  requirePolicyPermission(policy, "admin.users.manage")
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await requirePortalMappingPolicy(session)
    await ensurePortalTables()

    const userId = Number(request.nextUrl.searchParams.get("user_id") || 0)
    if (!userId) return fail("VALIDATION_ERROR", "user_id is required", 400)

    const userResult = await query(
      `SELECT id, username, full_name, role, is_active
       FROM users
       WHERE id = $1
         AND company_id = $2
       LIMIT 1`,
      [userId, session.companyId]
    )
    if (!userResult.rows.length) {
      return fail("NOT_FOUND", "User not found", 404)
    }

    const clientsResult = await query(
      `SELECT id, client_code, client_name, is_active
       FROM clients
       WHERE company_id = $1
       ORDER BY client_name ASC`,
      [session.companyId]
    )

    const mappingResult = await query(
      `SELECT client_id
       FROM portal_user_clients
       WHERE company_id = $1
         AND user_id = $2
         AND is_active = true
       ORDER BY client_id`,
      [session.companyId, userId]
    )
    const permissionResult = await query(
      `SELECT feature_key
       FROM portal_user_permissions
       WHERE company_id = $1
         AND user_id = $2
         AND is_allowed = true
       ORDER BY feature_key ASC`,
      [session.companyId, userId]
    )

    return ok({
      user: userResult.rows[0],
      clients: clientsResult.rows,
      mapped_client_ids: mappingResult.rows.map((row: { client_id: number | string }) => Number(row.client_id)),
      feature_permissions: permissionResult.rows.map((row: { feature_key: string }) => String(row.feature_key)),
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch portal mappings"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PUT(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await requirePortalMappingPolicy(session)
    await ensurePortalTables()

    const payload = updateSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const userResult = await db.query(
      `SELECT id, username, full_name, role, is_active
       FROM users
       WHERE id = $1
         AND company_id = $2
       LIMIT 1`,
      [payload.user_id, session.companyId]
    )
    if (!userResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "User not found", 404)
    }

    const validClientsResult = await db.query(
      `SELECT id
       FROM clients
       WHERE company_id = $1
         AND id = ANY($2::int[])`,
      [session.companyId, payload.client_ids]
    )
    const validClientIds = validClientsResult.rows.map((row: { id: number | string }) => Number(row.id))
    const invalidCount = payload.client_ids.length - validClientIds.length
    if (invalidCount > 0) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "One or more selected clients are invalid for this tenant", 400)
    }

    await db.query(
      `UPDATE portal_user_clients
       SET is_active = false
       WHERE company_id = $1
         AND user_id = $2`,
      [session.companyId, payload.user_id]
    )

    if (validClientIds.length > 0) {
      await db.query(
        `INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
         SELECT $1, $2, x.client_id, true
         FROM UNNEST($3::int[]) AS x(client_id)
         ON CONFLICT (company_id, user_id, client_id)
         DO UPDATE SET is_active = true`,
        [session.companyId, payload.user_id, validClientIds]
      )
    }

    const normalizedFeatures = Array.from(
      new Set(payload.feature_permissions.map((v) => v.trim()).filter((v) => v.length > 0))
    )
    await db.query(
      `DELETE FROM portal_user_permissions
       WHERE company_id = $1
         AND user_id = $2`,
      [session.companyId, payload.user_id]
    )
    if (normalizedFeatures.length > 0) {
      await db.query(
        `INSERT INTO portal_user_permissions (company_id, user_id, feature_key, is_allowed)
         SELECT $1, $2, x.feature_key, true
         FROM UNNEST($3::text[]) AS x(feature_key)
         ON CONFLICT (company_id, user_id, feature_key)
         DO UPDATE SET is_allowed = true, updated_at = CURRENT_TIMESTAMP`,
        [session.companyId, payload.user_id, normalizedFeatures]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "portal.mapping.update",
        entityType: "users",
        entityId: String(payload.user_id),
        after: { mapped_client_ids: validClientIds, feature_permissions: normalizedFeatures },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        user_id: payload.user_id,
        mapped_client_ids: validClientIds,
        feature_permissions: normalizedFeatures,
      },
      "Portal access updated"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update portal mappings"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
