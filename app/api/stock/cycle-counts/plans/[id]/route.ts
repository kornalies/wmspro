import { NextRequest } from "next/server"

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

/** One plan and its count sheet. POST closes the plan. */

type RouteContext = {
  params: Promise<{ id: string }>
}

async function loadPlan(
  db: { query: (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  companyId: number,
  planId: number
) {
  const plan = await db.query(
    `SELECT p.id, p.plan_number, p.strategy, p.status, p.blind_count, p.zone_code,
            p.total_tasks, p.notes, p.created_at, p.closed_at,
            p.warehouse_id, p.client_id,
            w.warehouse_name, c.client_name, u.full_name AS created_by_name
     FROM cycle_count_plans p
     JOIN warehouses w ON w.id = p.warehouse_id AND w.company_id = p.company_id
     LEFT JOIN clients c ON c.id = p.client_id AND c.company_id = p.company_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.company_id = $1 AND p.id = $2`,
    [companyId, planId]
  )
  return plan.rows[0] ?? null
}

export async function GET(_: NextRequest, context: RouteContext) {
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

    const { id } = await context.params
    const planId = Number(id)
    if (!Number.isInteger(planId) || planId <= 0) {
      return fail("VALIDATION_ERROR", "Invalid plan id", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const plan = await loadPlan(db, session.companyId, planId)
    if (!plan) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Cycle count plan not found", 404)
    }
    requireScope(policy, "warehouse", Number(plan.warehouse_id))
    if (plan.client_id) requireScope(policy, "client", Number(plan.client_id))

    const tasks = await db.query(
      `SELECT t.id, t.bin_id, t.sku, t.status, t.blind_count, t.expected_qty,
              t.created_at, u.full_name AS worker_name,
              s.id AS submission_id, s.counted_qty, s.discrepancy, s.approval_status
       FROM mobile_cycle_count_tasks t
       LEFT JOIN users u ON u.id = t.worker_id
       LEFT JOIN LATERAL (
         SELECT id, counted_qty, discrepancy, approval_status
         FROM mobile_cycle_count_submissions
         WHERE company_id = t.company_id AND task_id = t.id::text
         ORDER BY created_at DESC
         LIMIT 1
       ) s ON true
       WHERE t.company_id = $1 AND t.plan_id = $2
       ORDER BY t.bin_id ASC, t.sku ASC`,
      [session.companyId, planId]
    )

    await db.query("COMMIT")
    return ok({ plan, tasks: tasks.rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load plan"
    return fail("CYCLE_COUNT_PLAN_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
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

    const { id } = await context.params
    const planId = Number(id)
    if (!Number.isInteger(planId) || planId <= 0) {
      return fail("VALIDATION_ERROR", "Invalid plan id", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const plan = await loadPlan(db, session.companyId, planId)
    if (!plan) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Cycle count plan not found", 404)
    }
    requireScope(policy, "warehouse", Number(plan.warehouse_id))

    if (String(plan.status) === "CLOSED") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Plan is already closed.", 409)
    }

    // A plan cannot close over an undecided variance. Closing would strand the
    // approval in a queue nobody revisits, which is the exact failure Track C
    // exists to fix.
    const undecided = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM mobile_cycle_count_submissions s
       JOIN mobile_cycle_count_tasks t ON t.id::text = s.task_id AND t.company_id = s.company_id
       WHERE s.company_id = $1
         AND t.plan_id = $2
         AND s.approval_status = 'PENDING'`,
      [session.companyId, planId]
    )
    if (Number(undecided.rows[0]?.n ?? 0) > 0) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        `${undecided.rows[0].n} variance(s) on this plan are still awaiting approval. Decide them before closing.`,
        409
      )
    }

    await db.query(
      `UPDATE cycle_count_plans
       SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2 AND id = $3`,
      [session.userId, session.companyId, planId]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.cycle_count.plan.close",
        entityType: "cycle_count_plans",
        entityId: String(planId),
        before: { status: String(plan.status) },
        after: { status: "CLOSED" },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({ id: planId, status: "CLOSED" }, "Cycle count plan closed")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to close plan"
    return fail("CYCLE_COUNT_PLAN_CLOSE_FAILED", message, 400)
  } finally {
    db.release()
  }
}