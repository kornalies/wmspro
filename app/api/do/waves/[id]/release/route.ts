import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(session.companyId, session.userId, resolvePolicyActorType(session))
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { id } = await context.params
    const waveId = Number(id)
    if (!waveId) return fail("VALIDATION_ERROR", "Invalid wave id", 400)
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `do.waves.release:${waveId}`
    if (idempotencyKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
      })
      if (cached) return ok(cached.body as Record<string, unknown>, "Idempotent replay")
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const wave = await db.query(
      `SELECT id, status, warehouse_id, total_tasks
       FROM do_wave_header
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, waveId]
    )
    if (!wave.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Wave not found", 404)
    }
    const currentStatus = String(wave.rows[0].status)
    requireScope(policy, "warehouse", Number(wave.rows[0].warehouse_id))
    if (currentStatus !== "DRAFT") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Only DRAFT wave can be released. Current status ${currentStatus}`, 409)
    }
    if (Number(wave.rows[0].total_tasks || 0) <= 0) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Cannot release empty wave with zero tasks", 409)
    }

    await db.query(
      `UPDATE do_wave_header
       SET status = 'RELEASED',
           released_by = $1,
           released_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [session.userId, session.companyId, waveId]
    )
    const responseBody = { id: waveId, status: "RELEASED" }
    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.release",
        entityType: "do_wave_header",
        entityId: String(waveId),
        before: { status: currentStatus },
        after: responseBody,
        req: request,
      },
      db
    )
    await db.query("COMMIT")
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Wave released")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to release wave"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
