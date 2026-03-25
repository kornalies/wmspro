import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

const assignSchema = z.object({
  user_id: z.number().int().positive().optional(),
})

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
    const payload = assignSchema.parse(await request.json().catch(() => ({})))
    const assignee = payload.user_id || session.userId
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `do.wave.task.assign:${taskId}:${assignee}`
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
      `SELECT id, status, warehouse_id, client_id, assigned_to
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
    const status = String(task.rows[0].status)
    requireScope(policy, "warehouse", Number(task.rows[0].warehouse_id))
    requireScope(policy, "client", Number(task.rows[0].client_id))
    if (!["QUEUED", "ASSIGNED"].includes(status)) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot assign task in status ${status}`, 409)
    }
    const userRes = await db.query(
      `SELECT id
       FROM users
       WHERE company_id = $1
         AND id = $2
         AND is_active = true`,
      [session.companyId, assignee]
    )
    if (!userRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Assignee user not found or inactive", 400)
    }

    await db.query(
      `UPDATE do_pick_tasks
       SET assigned_to = $1,
           assigned_at = CURRENT_TIMESTAMP,
           status = 'ASSIGNED',
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [assignee, session.companyId, taskId]
    )
    const responseBody = { id: taskId, status: "ASSIGNED", assigned_to: assignee }
    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.task.assign",
        entityType: "do_pick_tasks",
        entityId: String(taskId),
        before: { status, assigned_to: task.rows[0].assigned_to ?? null },
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
    return ok(responseBody, "Task assigned")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to assign task"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
