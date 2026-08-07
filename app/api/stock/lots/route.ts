import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { listLots, normalizeBatchStatus } from "@/lib/lots"

/**
 * The lot master.
 *
 * Derived from stock_serial_numbers rather than stored -- see lib/lots.ts for
 * why a second copy of batch data is a liability rather than a convenience.
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
    const num = (key: string) => {
      const raw = searchParams.get(key)
      if (raw === null || raw.trim() === "") return null
      const value = Number(raw)
      return Number.isFinite(value) ? Math.trunc(value) : null
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const rows = await listLots(db, session.companyId, {
      clientId: num("client_id"),
      itemId: num("item_id"),
      warehouseId: num("warehouse_id"),
      batch: searchParams.get("batch"),
      status: normalizeBatchStatus(searchParams.get("status")),
      expiringInDays: num("expiring_in_days"),
      limit: num("limit") ?? 200,
    })

    await db.query("COMMIT")

    const totals = {
      lots: rows.length,
      on_hand_units: rows.reduce((sum, row) => sum + Number(row.on_hand_units ?? 0), 0),
      held_lots: rows.filter((row) => String(row.batch_status) !== "ACTIVE").length,
    }
    return ok({ totals, rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load lots"
    return fail("LOTS_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}
