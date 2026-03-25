import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

const allocateSchema = z.object({
  user_ids: z.array(z.number().int().positive()).min(1),
  max_tasks_per_user: z.number().int().positive().max(200).default(30),
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
    const waveId = Number(id)
    if (!waveId) return fail("VALIDATION_ERROR", "Invalid wave id", 400)
    const payload = allocateSchema.parse(await request.json())
    const normalizedUserIds = Array.from(new Set(payload.user_ids)).slice(0, 50)

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const usersKey = normalizedUserIds.join(",")
    const compactUsersKey = usersKey.length > 60 ? `${usersKey.slice(0, 60)}#${usersKey.length}` : usersKey
    const routeKey = `do.waves.allocate:${waveId}:${compactUsersKey}:${payload.max_tasks_per_user}`
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

    const waveRes = await db.query(
      `SELECT id, status, warehouse_id
       FROM do_wave_header
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, waveId]
    )
    if (!waveRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Wave not found", 404)
    }
    const wave = waveRes.rows[0] as { status: string; warehouse_id: number }
    requireScope(policy, "warehouse", Number(wave.warehouse_id))
    if (!["RELEASED", "IN_PROGRESS"].includes(String(wave.status))) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Wave must be RELEASED or IN_PROGRESS. Current ${String(wave.status)}`, 409)
    }

    const usersRes = await db.query(
      `SELECT id
       FROM users
       WHERE company_id = $1
         AND is_active = true
         AND id = ANY($2::int[])`,
      [session.companyId, normalizedUserIds]
    )
    const availableUsers = usersRes.rows.map((r: { id: number }) => Number(r.id)).filter(Boolean)
    if (!availableUsers.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "No active users found in user_ids for allocation", 400)
    }

    const tasksRes = await db.query(
      `SELECT id
       FROM do_pick_tasks
       WHERE company_id = $1
         AND wave_id = $2
         AND status = 'QUEUED'
       ORDER BY id ASC
       FOR UPDATE SKIP LOCKED`,
      [session.companyId, waveId]
    )
    const taskIds = tasksRes.rows.map((r: { id: number }) => Number(r.id)).filter(Boolean)
    if (!taskIds.length) {
      await db.query("ROLLBACK")
      return fail("NO_ELIGIBLE_TASKS", "No QUEUED tasks available for allocation", 400)
    }

    const assignmentCounts = new Map<number, number>()
    for (const userId of availableUsers) assignmentCounts.set(userId, 0)
    let allocated = 0

    for (let i = 0; i < taskIds.length; i += 1) {
      let chosenUser = null
      let attempts = 0
      while (attempts < availableUsers.length) {
        const candidate = availableUsers[(i + attempts) % availableUsers.length]
        const current = assignmentCounts.get(candidate) || 0
        if (current < payload.max_tasks_per_user) {
          chosenUser = candidate
          break
        }
        attempts += 1
      }
      if (!chosenUser) break

      await db.query(
        `UPDATE do_pick_tasks
         SET assigned_to = $1,
             assigned_at = CURRENT_TIMESTAMP,
             status = 'ASSIGNED',
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $2
           AND id = $3
           AND status = 'QUEUED'`,
        [chosenUser, session.companyId, taskIds[i]]
      )
      assignmentCounts.set(chosenUser, (assignmentCounts.get(chosenUser) || 0) + 1)
      allocated += 1
    }

    const responseBody = {
      wave_id: waveId,
      allocated_tasks: allocated,
      attempted_tasks: taskIds.length,
      users: Array.from(assignmentCounts.entries()).map(([user_id, task_count]) => ({ user_id, task_count })),
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.allocate",
        entityType: "do_wave_header",
        entityId: String(waveId),
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
    return ok(responseBody, "Wave tasks allocated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to allocate wave tasks"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
