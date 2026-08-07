import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"

/**
 * What is on the road to a warehouse.
 *
 * The transfer register is written from the sender's point of view: it answers
 * "what did we send". The receiving warehouse has the opposite question and no
 * screen that answered it — the first they knew of a truck was when it arrived.
 *
 * Ageing is the point of the view, not decoration. Stock in transit is stock
 * neither warehouse can sell, so a transfer that has been on the road longer
 * than it should be is the row that needs chasing, and nothing surfaces it today
 * (see `lots.ts` ON_HAND_STATUSES: in-transit units still count as on hand, so
 * they never look lost).
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
    const rawWarehouse = searchParams.get("warehouse_id")
    const warehouseId = rawWarehouse ? Number(rawWarehouse) : null
    if (rawWarehouse && !Number.isFinite(warehouseId)) {
      return fail("VALIDATION_ERROR", "warehouse_id must be a number", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const rows = await db.query(
      `SELECT h.id, h.transfer_number, h.status, h.expected_date, h.dispatched_at,
              h.vehicle_number, h.driver_name,
              c.client_name,
              fw.warehouse_name AS from_warehouse_name,
              tw.id AS to_warehouse_id, tw.warehouse_name AS to_warehouse_name,
              (SELECT COUNT(*)::int FROM stock_transfer_serials sts
                WHERE sts.company_id = h.company_id AND sts.transfer_id = h.id) AS units_on_truck,
              -- Whole days since it left. Null-safe: a transfer cannot be
              -- IN_TRANSIT without a dispatched_at, but the report should not
              -- blow up if one ever is.
              GREATEST(0, (CURRENT_DATE - h.dispatched_at::date))::int AS days_in_transit,
              (h.expected_date IS NOT NULL AND h.expected_date < CURRENT_DATE) AS overdue
         FROM stock_transfer_header h
         LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
         LEFT JOIN warehouses fw ON fw.id = h.from_warehouse_id AND fw.company_id = h.company_id
         LEFT JOIN warehouses tw ON tw.id = h.to_warehouse_id AND tw.company_id = h.company_id
        WHERE h.company_id = $1
          AND h.status = 'IN_TRANSIT'
          AND ($2::int IS NULL OR h.to_warehouse_id = $2)
        ORDER BY h.expected_date ASC NULLS LAST, h.dispatched_at ASC
        LIMIT 200`,
      [session.companyId, warehouseId]
    )

    await db.query("COMMIT")
    return ok({
      rows: rows.rows,
      overdue_count: rows.rows.filter((r) => r.overdue).length,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load inbound transfers"
    return fail("TRANSFER_INBOUND_FAILED", message, 400)
  } finally {
    db.release()
  }
}
