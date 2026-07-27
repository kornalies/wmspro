import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"

/**
 * Expiry exposure: what is already expired, what is blocked by a client's
 * minimum shelf life, and what is about to become either.
 *
 * Allocation silently skips expired and short-shelf-life stock, which is the
 * right behaviour but makes the stock invisible — it stops being offered and
 * nothing says why. Without this view the first sign of a problem is a DO that
 * cannot be filled despite the stock report showing inventory on hand.
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
    const horizonRaw = Number(searchParams.get("days") ?? 30)
    const horizon = Number.isFinite(horizonRaw)
      ? Math.min(Math.max(Math.trunc(horizonRaw), 1), 365)
      : 30
    const warehouseId = searchParams.get("warehouse_id")

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const rows = await db.query(
      `SELECT i.item_code,
              i.item_name,
              i.min_shelf_life_days,
              c.client_name,
              w.warehouse_name,
              s.batch_number,
              s.expiry_date,
              (s.expiry_date - CURRENT_DATE) AS days_to_expiry,
              COUNT(*)::int AS quantity,
              CASE
                WHEN s.expiry_date < CURRENT_DATE THEN 'EXPIRED'
                WHEN i.min_shelf_life_days IS NOT NULL
                     AND s.expiry_date < CURRENT_DATE + (i.min_shelf_life_days || ' days')::interval
                  THEN 'BELOW_MIN_SHELF_LIFE'
                ELSE 'EXPIRING_SOON'
              END AS exposure
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
       WHERE s.company_id = $1
         AND s.status IN ('IN_STOCK', 'RESERVED')
         AND s.expiry_date IS NOT NULL
         AND ($2::int IS NULL OR s.warehouse_id = $2)
         AND (
           s.expiry_date < CURRENT_DATE + ($3 || ' days')::interval
           OR (
             i.min_shelf_life_days IS NOT NULL
             AND s.expiry_date < CURRENT_DATE + (i.min_shelf_life_days || ' days')::interval
           )
         )
       GROUP BY i.item_code, i.item_name, i.min_shelf_life_days, c.client_name,
                w.warehouse_name, s.batch_number, s.expiry_date
       ORDER BY s.expiry_date ASC, i.item_code ASC`,
      [session.companyId, warehouseId ? Number(warehouseId) : null, horizon]
    )

    const totals = { EXPIRED: 0, BELOW_MIN_SHELF_LIFE: 0, EXPIRING_SOON: 0 }
    for (const row of rows.rows) {
      const key = String(row.exposure) as keyof typeof totals
      if (key in totals) totals[key] += Number(row.quantity ?? 0)
    }

    await db.query("COMMIT")
    return ok({
      horizon_days: horizon,
      totals,
      // EXPIRED and BELOW_MIN_SHELF_LIFE are not allocatable; EXPIRING_SOON
      // still is, and is the only one there is still time to act on.
      blocked_from_allocation: totals.EXPIRED + totals.BELOW_MIN_SHELF_LIFE,
      rows: rows.rows,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load expiry exposure"
    return fail("EXPIRY_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}