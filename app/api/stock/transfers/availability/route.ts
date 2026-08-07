import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { listTransferAvailability } from "@/lib/stock-transfer"

/**
 * What the raise form is allowed to offer.
 *
 * A static segment, so it takes precedence over /stock/transfers/[id] and never
 * reaches the id parser.
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
    const clientId = Number(searchParams.get("client_id"))
    const warehouseId = Number(searchParams.get("warehouse_id"))
    if (!Number.isFinite(clientId) || !Number.isFinite(warehouseId)) {
      return fail("VALIDATION_ERROR", "client_id and warehouse_id are required", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const rows = await listTransferAvailability(db, session.companyId, { clientId, warehouseId })
    await db.query("COMMIT")

    return ok({ rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load availability"
    return fail("TRANSFER_AVAILABILITY_FAILED", message, 400)
  } finally {
    db.release()
  }
}
