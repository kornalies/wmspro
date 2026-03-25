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
    const taskId = Number(id)
    if (!taskId) return fail("VALIDATION_ERROR", "Invalid task id", 400)
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `do.wave.task.start:${taskId}:${session.userId}`
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

    const task = await db.query(
      `SELECT id, wave_id, status, assigned_to, warehouse_id, client_id
       FROM do_pick_tasks
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, taskId]
    )
    if (!task.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Task not found", 404)
    }

    const row = task.rows[0] as {
      wave_id: number
      status: string
      assigned_to: number | null
      warehouse_id: number
      client_id: number
    }
    requireScope(policy, "warehouse", Number(row.warehouse_id))
    requireScope(policy, "client", Number(row.client_id))
    if (!row.assigned_to || Number(row.assigned_to) !== session.userId) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Task must be assigned to you before start", 409)
    }
    if (!["ASSIGNED", "IN_PROGRESS"].includes(String(row.status))) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot start task in status ${String(row.status)}`, 409)
    }

    await db.query(
      `UPDATE do_pick_tasks
       SET status = 'IN_PROGRESS',
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, taskId]
    )

    await db.query(
      `UPDATE do_wave_header
       SET status = CASE WHEN status = 'RELEASED' THEN 'IN_PROGRESS' ELSE status END,
           started_at = CASE WHEN status = 'RELEASED' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, Number(row.wave_id)]
    )
    const responseBody = { id: taskId, status: "IN_PROGRESS" }
    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.task.start",
        entityType: "do_pick_tasks",
        entityId: String(taskId),
        before: { status: row.status, assigned_to: row.assigned_to },
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
    return ok(responseBody, "Task started")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to start task"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
