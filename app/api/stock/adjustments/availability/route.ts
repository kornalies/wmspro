import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import {
  listAdjustableItems,
  listAdjustableSerials,
  listReceiptLines,
} from "@/lib/inventory-adjustment"

/**
 * What the raise form is allowed to offer.
 *
 * The form used to be a free-text serial box over the whole item master, so an
 * operator typed serial numbers from memory and discovered one at a time, as
 * 400s, that the warehouse did not hold them. Everything the screen offers now
 * comes from here, which means the screen cannot propose a unit the approval
 * will refuse.
 *
 * Three shapes off one endpoint, chosen by what you pass:
 *   client+warehouse            -> the items actually held, with counts
 *   ... + item_id               -> the units themselves, with their claims
 *   ... + item_id&mode=receipts -> the GRN lines found stock can be attributed to
 *
 * A static segment, so it takes precedence over /stock/adjustments/[id] and
 * never reaches the id parser.
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
    const itemIdRaw = searchParams.get("item_id")
    const mode = String(searchParams.get("mode") ?? "").toLowerCase()
    if (!Number.isFinite(clientId) || !Number.isFinite(warehouseId)) {
      return fail("VALIDATION_ERROR", "client_id and warehouse_id are required", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    let payload: Record<string, unknown>
    if (itemIdRaw == null || !Number.isFinite(Number(itemIdRaw))) {
      payload = { items: await listAdjustableItems(db, session.companyId, { clientId, warehouseId }) }
    } else if (mode === "receipts") {
      payload = {
        receipts: await listReceiptLines(db, session.companyId, {
          clientId,
          warehouseId,
          itemId: Number(itemIdRaw),
        }),
      }
    } else {
      payload = {
        serials: await listAdjustableSerials(db, session.companyId, {
          clientId,
          warehouseId,
          itemId: Number(itemIdRaw),
          // Filtered in SQL, not in the browser: the put-away screen's
          // "Unassigned only" filter ran client-side over a server LIMIT and so
          // could not see stock that was not in the page it happened to get.
          q: searchParams.get("q"),
          limit: Number(searchParams.get("limit")) || undefined,
        }),
      }
    }

    await db.query("COMMIT")
    return ok(payload)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load availability"
    return fail("ADJUSTMENT_AVAILABILITY_FAILED", message, 400)
  } finally {
    db.release()
  }
}
