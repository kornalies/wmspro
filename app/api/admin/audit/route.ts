import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

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
    requirePolicyPermission(policy, "audit.view")

    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")
    const actorUserId = Number(searchParams.get("actor_user_id") || 0)
    const entityType = searchParams.get("entity_type")
    const fromDate = searchParams.get("from")
    const toDate = searchParams.get("to")
    const limit = Math.min(Number(searchParams.get("limit") || 100), 500)
    const offset = Math.max(Number(searchParams.get("offset") || 0), 0)

    const rows = await query(
      `SELECT
        id,
        company_id,
        actor_user_id,
        actor_type,
        action,
        entity_type,
        entity_id,
        before,
        after,
        ip,
        user_agent,
        created_at
       FROM audit_logs
       WHERE company_id = $1
         AND ($2::text IS NULL OR action = $2)
         AND ($3::int = 0 OR actor_user_id = $3)
         AND ($4::text IS NULL OR entity_type = $4)
         AND ($5::timestamptz IS NULL OR created_at >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR created_at <= $6::timestamptz)
       ORDER BY created_at DESC
       LIMIT $7 OFFSET $8`,
      [
        session.companyId,
        action || null,
        actorUserId,
        entityType || null,
        fromDate || null,
        toDate || null,
        limit,
        offset,
      ]
    )

    const totalResult = await query(
      `SELECT COUNT(*)::int AS total
       FROM audit_logs
       WHERE company_id = $1
         AND ($2::text IS NULL OR action = $2)
         AND ($3::int = 0 OR actor_user_id = $3)
         AND ($4::text IS NULL OR entity_type = $4)
         AND ($5::timestamptz IS NULL OR created_at >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR created_at <= $6::timestamptz)`,
      [
        session.companyId,
        action || null,
        actorUserId,
        entityType || null,
        fromDate || null,
        toDate || null,
      ]
    )
    const total = Number(totalResult.rows[0]?.total || 0)

    return ok({
      rows: rows.rows,
      paging: { limit, offset, count: rows.rowCount || rows.rows.length, total },
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch audit logs"
    return fail("SERVER_ERROR", message, 500)
  }
}
