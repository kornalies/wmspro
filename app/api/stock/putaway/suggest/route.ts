import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensurePutawayMovementSchema } from "@/lib/db-bootstrap"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

function ensureStockPermission(policy: Awaited<ReturnType<typeof getEffectivePolicy>>) {
  if (
    policy.permissions.includes("stock.adjust") ||
    policy.permissions.includes("stock.putaway.manage")
  ) {
    return
  }
  requirePolicyPermission(policy, "stock.adjust")
}

// Directed put-away: rank AVAILABLE bins for a destination suggestion.
//
// Strategy (best-fit into the right zone):
//   1. Only active, AVAILABLE bins in the warehouse.
//   2. Drop bins whose remaining capacity can't hold `qty` (bins with no
//      configured capacity are treated as unlimited and always fit).
//   3. Rank by zone function (STORAGE first, then PICKING, then the rest),
//      prefer bins with a defined capacity, then tightest remaining space that
//      still fits (best-fit consolidation), then sort_order / bin_code.
export async function GET(request: NextRequest) {
  try {
    await ensurePutawayMovementSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")
    ensureStockPermission(policy)

    const { searchParams } = new URL(request.url)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    if (!warehouseId) return fail("VALIDATION_ERROR", "warehouse_id is required", 400)
    requireScope(policy, "warehouse", warehouseId)

    const qty = Math.max(1, Number(searchParams.get("qty") || 1))
    const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") || 8)))

    const result = await query(
      `SELECT
        zl.id,
        zl.zone_code,
        zl.zone_name,
        zl.zone_type,
        zl.rack_code,
        zl.bin_code,
        zl.capacity_units,
        COALESCE(occ.occupied, 0)::int AS occupied,
        CASE
          WHEN zl.capacity_units IS NULL THEN NULL
          ELSE zl.capacity_units - COALESCE(occ.occupied, 0)
        END AS free_units
      FROM warehouse_zone_layouts zl
      LEFT JOIN (
        SELECT zone_layout_id, COUNT(*) AS occupied
        FROM stock_serial_numbers
        WHERE zone_layout_id IS NOT NULL
          AND status IN ('IN_STOCK', 'RESERVED')
        GROUP BY zone_layout_id
      ) occ ON occ.zone_layout_id = zl.id
      WHERE zl.warehouse_id = $1
        AND zl.is_active = true
        AND zl.bin_status = 'AVAILABLE'
        AND (zl.capacity_units IS NULL OR zl.capacity_units - COALESCE(occ.occupied, 0) >= $2)
      ORDER BY
        CASE zl.zone_type WHEN 'STORAGE' THEN 0 WHEN 'PICKING' THEN 1 ELSE 2 END,
        (zl.capacity_units IS NULL) ASC,
        CASE WHEN zl.capacity_units IS NULL THEN NULL ELSE zl.capacity_units - COALESCE(occ.occupied, 0) END ASC NULLS LAST,
        zl.sort_order ASC,
        zl.bin_code ASC
      LIMIT $3`,
      [warehouseId, qty, limit]
    )

    return ok(
      result.rows.map((row: Record<string, unknown>) => ({
        ...row,
        bin_location: `${row.zone_code}/${row.rack_code}/${row.bin_code}`,
      }))
    )
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to suggest put-away bins"
    return fail("SERVER_ERROR", message, 500)
  }
}
