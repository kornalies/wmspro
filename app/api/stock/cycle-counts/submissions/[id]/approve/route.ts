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
import { CycleCountError, applyVariance } from "@/lib/cycle-count"

/**
 * Decide a cycle count variance.
 *
 * This is the half of cycle counting that did not exist: mobile could raise a
 * variance and mark it PENDING, but nothing could act on one, so approvals
 * accumulated with no route to a stock adjustment.
 *
 * Approving a shortage writes stock off. That is a real, auditable inventory
 * loss, so it needs the same permission as any other stock mutation and leaves
 * a stock_movements row of type LOST per serial.
 */

type RouteContext = {
  params: Promise<{ id: string }>
}

const decisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
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
      return fail("VALIDATION_ERROR", "Invalid submission id", 400)
    }
    const payload = decisionSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    // Scope from the submission's own warehouse/client, so a narrow-scoped user
    // cannot write off stock at a site they do not cover by guessing an id.
    const scopeRes = await db.query(
      `SELECT warehouse_id, client_id
       FROM mobile_cycle_count_submissions
       WHERE company_id = $1 AND id = $2::uuid`,
      [session.companyId, id]
    )
    if (!scopeRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Cycle count submission not found", 404)
    }
    requireScope(policy, "warehouse", Number(scopeRes.rows[0].warehouse_id))
    requireScope(policy, "client", Number(scopeRes.rows[0].client_id))

    const outcome = await applyVariance(db, {
      companyId: session.companyId,
      submissionId: id,
      decision: payload.decision,
      userId: session.userId,
      remarks: payload.remarks ?? null,
    })

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.cycle_count.variance.decide",
        entityType: "mobile_cycle_count_submissions",
        entityId: id,
        after: {
          decision: outcome.decision,
          discrepancy: outcome.discrepancy,
          adjusted_serial_count: outcome.adjustedSerialCount,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      outcome,
      outcome.note ||
        (outcome.decision === "APPROVED"
          ? `Variance approved. ${outcome.adjustedSerialCount} serial(s) written off.`
          : "Variance rejected. Stock unchanged.")
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof CycleCountError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to decide variance"
    return fail("CYCLE_COUNT_APPROVAL_FAILED", message, 400)
  } finally {
    db.release()
  }
}