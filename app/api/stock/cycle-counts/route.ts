import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import { CycleCountError, nextPlanNumber, selectTasksForPlan } from "@/lib/cycle-count"

/**
 * Cycle count plans and the outstanding count queue.
 *
 * Tasks are written to mobile_cycle_count_tasks — the same table the handheld
 * already reads — so a plan raised here appears on a counter's device with no
 * second task system to keep in step.
 */

const createPlanSchema = z.object({
  warehouse_id: z.number().positive(),
  client_id: z.number().positive().optional(),
  strategy: z.enum(["ZONE", "ABC", "MANUAL"]).default("ZONE"),
  zone_code: z.string().trim().min(1).max(50).optional(),
  bin_locations: z.array(z.string().trim().min(1)).optional(),
  blind_count: z.boolean().default(true),
  limit: z.number().int().positive().max(500).default(50),
  notes: z.string().trim().max(2000).optional(),
})

export async function GET(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")
    requirePolicyPermission(policy, "stock.putaway.manage")

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")

    // is_local = true: the tenant setting only survives inside a transaction.
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const plans = await db.query(
      `SELECT p.id, p.plan_number, p.strategy, p.status, p.blind_count, p.zone_code,
              p.total_tasks, p.notes, p.created_at, p.closed_at,
              w.warehouse_name, c.client_name,
              u.full_name AS created_by_name,
              COUNT(t.id) FILTER (WHERE t.status <> 'COMPLETED')::int AS open_tasks
       FROM cycle_count_plans p
       JOIN warehouses w ON w.id = p.warehouse_id AND w.company_id = p.company_id
       LEFT JOIN clients c ON c.id = p.client_id AND c.company_id = p.company_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN mobile_cycle_count_tasks t
         ON t.plan_id = p.id AND t.company_id = p.company_id
       WHERE p.company_id = $1
         AND ($2::text IS NULL OR p.status = $2)
       GROUP BY p.id, w.warehouse_name, c.client_name, u.full_name
       ORDER BY p.id DESC
       LIMIT 100`,
      [session.companyId, status]
    )

    // Variances awaiting a decision. This queue had no reader before Track C,
    // which is why submissions could sit at PENDING indefinitely.
    const pending = await db.query(
      `SELECT s.id, s.task_id, s.bin_id, s.sku, s.expected_qty, s.counted_qty,
              s.discrepancy, s.blind_count, s.approval_status, s.created_at,
              w.warehouse_name, c.client_name, u.full_name AS counted_by_name
       FROM mobile_cycle_count_submissions s
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
       LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
       LEFT JOIN users u ON u.id = s.worker_id
       WHERE s.company_id = $1
         AND s.approval_status = 'PENDING'
       ORDER BY s.created_at ASC
       LIMIT 200`,
      [session.companyId]
    )

    // Accuracy is the number the SLA is written against: how many counts came
    // back exactly right, over a rolling 90 days.
    const accuracy = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE COALESCE(discrepancy, 0) = 0)::int AS exact,
              COALESCE(SUM(ABS(COALESCE(discrepancy, 0))), 0)::int AS total_variance
       FROM mobile_cycle_count_submissions
       WHERE company_id = $1
         AND created_at >= CURRENT_DATE - INTERVAL '90 days'`,
      [session.companyId]
    )
    const acc = accuracy.rows[0] ?? {}
    const total = Number(acc.total ?? 0)
    const exact = Number(acc.exact ?? 0)

    await db.query("COMMIT")

    return ok({
      plans: plans.rows,
      pending_approvals: pending.rows,
      accuracy: {
        counts: total,
        exact,
        total_variance: Number(acc.total_variance ?? 0),
        accuracy_pct: total > 0 ? Math.round((exact / total) * 1000) / 10 : null,
      },
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof CycleCountError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to load cycle counts"
    return fail("CYCLE_COUNT_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")
    requirePolicyPermission(policy, "stock.putaway.manage")

    const payload = createPlanSchema.parse(await request.json())
    requireScope(policy, "warehouse", payload.warehouse_id)
    if (payload.client_id) requireScope(policy, "client", payload.client_id)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const tasks = await selectTasksForPlan(db, {
      companyId: session.companyId,
      warehouseId: payload.warehouse_id,
      clientId: payload.client_id ?? null,
      strategy: payload.strategy,
      zoneCode: payload.zone_code ?? null,
      binLocations: payload.bin_locations,
      limit: payload.limit,
    })

    if (tasks.length === 0) {
      await db.query("ROLLBACK")
      return fail(
        "NO_STOCK_IN_SCOPE",
        "No occupied bins match this plan. Counting bins the system already believes are empty proves nothing about accuracy.",
        409
      )
    }

    const planNumber = await nextPlanNumber(db)
    const plan = await db.query(
      `INSERT INTO cycle_count_plans (
         company_id, plan_number, warehouse_id, client_id, strategy, blind_count,
         status, zone_code, total_tasks, notes, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9, $10)
       RETURNING id, plan_number`,
      [
        session.companyId,
        planNumber,
        payload.warehouse_id,
        payload.client_id ?? null,
        payload.strategy,
        payload.blind_count,
        payload.zone_code ?? null,
        tasks.length,
        payload.notes ?? null,
        session.userId,
      ]
    )
    const planId = Number(plan.rows[0].id)

    for (const task of tasks) {
      await db.query(
        `INSERT INTO mobile_cycle_count_tasks (
           company_id, warehouse_id, client_id, task_type, blind_count,
           bin_id, sku, expected_qty, status, plan_id
         )
         VALUES ($1, $2, $3, 'PLANNED', $4, $5, $6, $7, 'OPEN', $8)`,
        [
          session.companyId,
          payload.warehouse_id,
          task.clientId,
          payload.blind_count,
          task.binLocation,
          task.itemCode,
          // A blind count must not ship the answer to the handheld. The expected
          // figure still exists on the plan side for variance calculation; it is
          // simply withheld from the task the counter sees.
          payload.blind_count ? null : task.expectedQty,
          planId,
        ]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.cycle_count.plan.create",
        entityType: "cycle_count_plans",
        entityId: String(planId),
        after: {
          plan_number: planNumber,
          strategy: payload.strategy,
          blind_count: payload.blind_count,
          total_tasks: tasks.length,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      { id: planId, plan_number: planNumber, total_tasks: tasks.length },
      `Cycle count plan raised with ${tasks.length} task(s)`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof CycleCountError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to create cycle count plan"
    return fail("CYCLE_COUNT_PLAN_FAILED", message, 400)
  } finally {
    db.release()
  }
}