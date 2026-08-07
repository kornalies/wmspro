import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { traceLot, traceSerial } from "@/lib/lots"

/**
 * Genealogy, at whichever granularity the question was asked.
 *
 *   ?serial=SER-123                       -> one unit, including its movements
 *   ?client_id=1&item_id=2&batch=LOT-7    -> the whole lot, aggregated per document
 *
 * Both are the same endpoint because they answer the same question ("where did
 * this come from and where did it go") and an auditor following a trail moves
 * between the two without wanting to know they are different reports.
 */
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
    const serial = searchParams.get("serial")?.trim()

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    if (serial) {
      const trace = await traceSerial(db, session.companyId, serial)
      await db.query("COMMIT")
      if (!trace) return fail("NOT_FOUND", `No serial ${serial} in this tenant`, 404)
      return ok({ scope: "serial", ...trace })
    }

    const clientId = Number(searchParams.get("client_id"))
    const itemId = Number(searchParams.get("item_id"))
    const batch = searchParams.get("batch")?.trim()
    if (!Number.isFinite(clientId) || !Number.isFinite(itemId) || !batch) {
      await db.query("ROLLBACK")
      return fail(
        "VALIDATION_ERROR",
        "Provide either serial, or all of client_id, item_id and batch",
        400
      )
    }

    const trace = await traceLot(db, session.companyId, { clientId, itemId, batch })
    await db.query("COMMIT")

    if (!trace.inbound.length && !trace.outbound.length && !trace.locations.length) {
      return fail("NOT_FOUND", `No stock found for batch ${batch}`, 404)
    }
    return ok({ scope: "lot", lot: { clientId, itemId, batch }, ...trace })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to trace"
    return fail("TRACE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
