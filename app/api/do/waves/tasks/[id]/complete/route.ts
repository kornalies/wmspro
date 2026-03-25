import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

const completeSchema = z.object({
  picked_quantity: z.number().int().positive().optional(),
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
    const payload = completeSchema.parse(await request.json().catch(() => ({})))
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `do.wave.task.complete:${taskId}:${session.userId}:${payload.picked_quantity || "full"}`
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

    const taskRes = await db.query(
      `SELECT id, wave_id, do_header_id, status, required_quantity, assigned_to, warehouse_id, client_id
       FROM do_pick_tasks
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, taskId]
    )
    if (!taskRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Task not found", 404)
    }

    const task = taskRes.rows[0] as {
      wave_id: number
      do_header_id: number
      status: string
      required_quantity: number
      assigned_to: number | null
      warehouse_id: number
      client_id: number
    }
    requireScope(policy, "warehouse", Number(task.warehouse_id))
    requireScope(policy, "client", Number(task.client_id))

    if (!task.assigned_to || Number(task.assigned_to) !== session.userId) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Task must be assigned to you before complete", 409)
    }
    if (!["ASSIGNED", "IN_PROGRESS", "DONE"].includes(String(task.status))) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot complete task in status ${String(task.status)}`, 409)
    }

    const requiredQty = Number(task.required_quantity)
    const pickedQty = payload.picked_quantity ?? requiredQty
    if (pickedQty <= 0 || pickedQty > requiredQty) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", `picked_quantity must be between 1 and ${requiredQty}`, 400)
    }

    await db.query(
      `UPDATE do_pick_tasks
       SET picked_quantity = $1,
           status = 'DONE',
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [pickedQty, session.companyId, taskId]
    )

    await db.query(
      `UPDATE do_wave_orders wo
       SET status = CASE
         WHEN NOT EXISTS (
           SELECT 1
           FROM do_pick_tasks t
           WHERE t.company_id = wo.company_id
             AND t.wave_id = wo.wave_id
             AND t.do_header_id = wo.do_header_id
             AND t.status <> 'DONE'
         ) THEN 'DONE'
         ELSE wo.status
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE wo.company_id = $1
         AND wo.wave_id = $2
         AND wo.do_header_id = $3`,
      [session.companyId, Number(task.wave_id), Number(task.do_header_id)]
    )

    const doAllDoneRes = await db.query(
      `SELECT NOT EXISTS (
         SELECT 1
         FROM do_pick_tasks t
         WHERE t.company_id = $1
           AND t.wave_id = $2
           AND t.do_header_id = $3
           AND t.status <> 'DONE'
       ) AS is_done`,
      [session.companyId, Number(task.wave_id), Number(task.do_header_id)]
    )
    const isDoDone = Boolean(doAllDoneRes.rows[0]?.is_done)
    await db.query(
      `UPDATE do_header
       SET status = CASE
         WHEN $3::boolean = true AND status IN ('PENDING', 'DRAFT') THEN 'PICKED'
         ELSE status
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, Number(task.do_header_id), isDoDone]
    )

    await db.query(
      `UPDATE do_wave_header
       SET status = CASE
         WHEN NOT EXISTS (
           SELECT 1
           FROM do_pick_tasks t
           WHERE t.company_id = do_wave_header.company_id
             AND t.wave_id = do_wave_header.id
             AND t.status <> 'DONE'
         ) THEN 'COMPLETED'
         ELSE CASE
           WHEN status = 'RELEASED' THEN 'IN_PROGRESS'
           ELSE status
         END
       END,
       completed_at = CASE
         WHEN NOT EXISTS (
           SELECT 1
           FROM do_pick_tasks t
           WHERE t.company_id = do_wave_header.company_id
             AND t.wave_id = do_wave_header.id
             AND t.status <> 'DONE'
         ) THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
         ELSE completed_at
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, Number(task.wave_id)]
    )

    const responseBody = { id: taskId, status: "DONE", picked_quantity: pickedQty }
    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.task.complete",
        entityType: "do_pick_tasks",
        entityId: String(taskId),
        before: { status: task.status, required_quantity: requiredQty },
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
    return ok(responseBody, "Task completed")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to complete task"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
