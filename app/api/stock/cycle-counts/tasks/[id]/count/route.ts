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
import { CycleCountError, expectedQtyForBin } from "@/lib/cycle-count"

/**
 * Record a count against a task from the web.
 *
 * The handheld writes submissions directly; this is the same act from a desk,
 * for sites that count on paper and key the results in. It writes the same
 * mobile_cycle_count_submissions row so both paths land in one approval queue.
 *
 * The expected quantity is resolved HERE from live stock, never taken from the
 * request. On a blind count the task deliberately carries no expected figure,
 * and trusting a client-supplied one would let a counter set their own variance
 * to zero.
 */

type RouteContext = {
  params: Promise<{ id: string }>
}

const countSchema = z.object({
  counted_qty: z.number().int().nonnegative(),
  remarks: z.string().trim().max(2000).optional(),
})

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
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return fail("VALIDATION_ERROR", "Invalid task id", 400)
    }
    const payload = countSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const taskRes = await db.query(
      `SELECT id, warehouse_id, client_id, bin_id, sku, blind_count, status, lp_id
       FROM mobile_cycle_count_tasks
       WHERE company_id = $1 AND id = $2::uuid
       FOR UPDATE`,
      [session.companyId, id]
    )
    if (!taskRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Cycle count task not found", 404)
    }
    const task = taskRes.rows[0]

    requireScope(policy, "warehouse", Number(task.warehouse_id))
    requireScope(policy, "client", Number(task.client_id))

    if (String(task.status) === "COMPLETED") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "This task has already been counted and decided.", 409)
    }

    const expected = await expectedQtyForBin(db, {
      companyId: session.companyId,
      warehouseId: Number(task.warehouse_id),
      binLocation: String(task.bin_id),
      itemCode: String(task.sku),
    })
    const discrepancy = payload.counted_qty - expected
    const requiresApproval = discrepancy !== 0

    const submission = await db.query(
      `INSERT INTO mobile_cycle_count_submissions (
         task_id, company_id, warehouse_id, client_id, worker_id,
         bin_id, lp_id, sku, expected_qty, counted_qty, discrepancy,
         blind_count, requires_approval, approval_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        String(task.id),
        session.companyId,
        Number(task.warehouse_id),
        Number(task.client_id),
        session.userId,
        String(task.bin_id),
        task.lp_id ?? null,
        String(task.sku),
        expected,
        payload.counted_qty,
        discrepancy,
        task.blind_count === true,
        requiresApproval,
        requiresApproval ? "PENDING" : "NOT_REQUIRED",
      ]
    )
    const submissionId = String(submission.rows[0].id)

    // An exact count needs no decision, so it closes the task immediately. A
    // variance leaves the task open until someone approves or rejects it — the
    // task is the counter's outstanding work, and it is not finished while the
    // stock question is unresolved.
    await db.query(
      `UPDATE mobile_cycle_count_tasks
       SET status = $1, worker_id = COALESCE(worker_id, $2), updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $3 AND id = $4::uuid`,
      [requiresApproval ? "COUNTED" : "COMPLETED", session.userId, session.companyId, id]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.cycle_count.task.count",
        entityType: "mobile_cycle_count_submissions",
        entityId: submissionId,
        after: {
          bin_id: String(task.bin_id),
          sku: String(task.sku),
          expected_qty: expected,
          counted_qty: payload.counted_qty,
          discrepancy,
          requires_approval: requiresApproval,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        submission_id: submissionId,
        expected_qty: expected,
        counted_qty: payload.counted_qty,
        discrepancy,
        requires_approval: requiresApproval,
      },
      requiresApproval
        ? `Variance of ${discrepancy} recorded and sent for approval.`
        : "Count matches stock on hand."
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof CycleCountError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to record count"
    return fail("CYCLE_COUNT_SUBMIT_FAILED", message, 400)
  } finally {
    db.release()
  }
}