import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { normalizeBatchStatus, recallImpact, setBatchStatus } from "@/lib/lots"

/**
 * Recall: what a lot has touched, and the switch that stops it moving.
 *
 * GET reports impact, split into stock still in the building (a hold stops it)
 * and stock already shipped (a phone call is the only remedy). POST applies or
 * lifts the hold, which allocation honours on the next pick -- see
 * allocatableBatchPredicate in lib/allocation.ts.
 *
 * Read and write are the same route because in practice they are one action:
 * you look at the impact and then you stop the stock, and separating them
 * invites the first half to be run without the second.
 */

function parseLot(searchParams: URLSearchParams) {
  const clientId = Number(searchParams.get("client_id"))
  const itemId = Number(searchParams.get("item_id"))
  const batch = searchParams.get("batch")?.trim()
  if (!Number.isFinite(clientId) || !Number.isFinite(itemId) || !batch) return null
  return { clientId, itemId, batch }
}

export async function GET(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "reports.view")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")

    const { searchParams } = new URL(request.url)
    const lot = parseLot(searchParams)
    if (!lot) return fail("VALIDATION_ERROR", "client_id, item_id and batch are required", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const impact = await recallImpact(db, session.companyId, lot)
    await db.query("COMMIT")

    if (Number(impact.totals?.total_units ?? 0) === 0) {
      return fail("NOT_FOUND", `No stock found for batch ${lot.batch}`, 404)
    }
    return ok(impact)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to assess recall impact"
    return fail("RECALL_READ_FAILED", message, 400)
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

    const body = (await request.json().catch(() => ({}))) as {
      client_id?: number
      item_id?: number
      batch?: string
      status?: string
      reason?: string
      reference_no?: string
    }

    const clientId = Number(body.client_id)
    const itemId = Number(body.item_id)
    const batch = String(body.batch ?? "").trim()
    if (!Number.isFinite(clientId) || !Number.isFinite(itemId) || !batch) {
      return fail("VALIDATION_ERROR", "client_id, item_id and batch are required", 400)
    }

    const status = normalizeBatchStatus(body.status)
    if (!status) {
      return fail("VALIDATION_ERROR", "status must be ACTIVE, ON_HOLD or RECALLED", 400)
    }
    // A hold blocks stock from shipping; requiring a reason means the next
    // person can tell a recall from a mistake without asking around.
    if (status !== "ACTIVE" && !String(body.reason ?? "").trim()) {
      return fail("VALIDATION_ERROR", "reason is required when holding or recalling a batch", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const lot = { clientId, itemId, batch }
    // Read impact inside the same transaction as the hold so the numbers in the
    // audit record are the numbers as at the moment it was applied.
    const impact = await recallImpact(db, session.companyId, lot)
    if (Number(impact.totals?.total_units ?? 0) === 0) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", `No stock found for batch ${batch}`, 404)
    }

    const row = await setBatchStatus(db, session.companyId, lot, {
      status,
      reason: body.reason ?? null,
      referenceNo: body.reference_no ?? null,
      userId: session.userId,
    })

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: status === "ACTIVE" ? "stock.batch.released" : "stock.batch.held",
        entityType: "stock_batch_status",
        entityId: Number(row.id),
        // The impact figures are recorded with the decision: six months later,
        // "what did we know when we held this" is the question being asked.
        after: {
          batch,
          status,
          reason: body.reason ?? null,
          reference_no: body.reference_no ?? null,
          on_hand_units: impact.totals?.on_hand_units ?? 0,
          dispatched_units: impact.totals?.dispatched_units ?? 0,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        lot,
        status: row.status,
        // The two numbers that matter next: what the hold just stopped, and what
        // it is already too late to stop.
        blocked_units: impact.totals?.on_hand_units ?? 0,
        already_shipped_units: impact.totals?.dispatched_units ?? 0,
        affected_dos: impact.shipped.map((r) => r.do_number),
      },
      status === "ACTIVE" ? "Batch released" : `Batch ${status === "RECALLED" ? "recalled" : "held"}`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update batch status"
    return fail("RECALL_UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
