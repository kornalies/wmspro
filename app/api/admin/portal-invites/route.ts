import { randomBytes } from "crypto"

import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { writeAudit } from "@/lib/audit"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { ensurePortalTables } from "@/lib/portal"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission } from "@/lib/policy/guards"

const createInviteSchema = z.object({
  user_id: z.number().int().positive(),
  expires_hours: z.number().int().min(1).max(168).default(72),
})

async function requirePortalInvitePolicy(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  requirePermission(session, "admin.users.manage")
  const policy = await getEffectivePolicy(
    session.companyId,
    session.userId,
    resolvePolicyActorType(session)
  )
  requireFeature(policy, "admin")
  requirePolicyPermission(policy, "admin.users.manage")
}

function buildPublicBaseUrl(request: NextRequest) {
  const envBase = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (envBase) return envBase.replace(/\/+$/, "")
  return request.nextUrl.origin
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await requirePortalInvitePolicy(session)
    await ensurePortalTables()

    const userId = Number(request.nextUrl.searchParams.get("user_id") || 0)
    if (!userId) return fail("VALIDATION_ERROR", "user_id is required", 400)

    const result = await query(
      `SELECT
         pui.id,
         pui.user_id,
         pui.status,
         pui.expires_at,
         pui.accepted_at,
         pui.created_at
       FROM portal_user_invites pui
       WHERE pui.company_id = $1
         AND pui.user_id = $2
       ORDER BY pui.created_at DESC
       LIMIT 20`,
      [session.companyId, userId]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch portal invites"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await requirePortalInvitePolicy(session)
    await ensurePortalTables()

    const payload = createInviteSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const userResult = await db.query(
      `SELECT id, username, full_name, email, is_active
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

    await db.query(
      `UPDATE portal_user_invites
       SET status = 'EXPIRED'
       WHERE company_id = $1
         AND user_id = $2
         AND status = 'PENDING'`,
      [session.companyId, payload.user_id]
    )

    const token = randomBytes(24).toString("hex")
    const created = await db.query(
      `INSERT INTO portal_user_invites (
         company_id, user_id, invite_token, status, expires_at, invited_by
       )
       VALUES ($1, $2, $3, 'PENDING', NOW() + ($4::int || ' hours')::interval, $5)
       RETURNING id, user_id, invite_token, status, expires_at, created_at`,
      [session.companyId, payload.user_id, token, payload.expires_hours, session.userId]
    )
    const invite = created.rows[0]
    const activationUrl = `${buildPublicBaseUrl(request)}/portal/activate?token=${token}`

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "portal.invite.create",
        entityType: "users",
        entityId: String(payload.user_id),
        after: { invite_id: invite.id, expires_at: invite.expires_at },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        ...invite,
        activation_url: activationUrl,
      },
      "Portal invite created"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to create portal invite"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

