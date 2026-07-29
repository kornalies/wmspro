import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import { OutboundTailError, lockDO } from "@/lib/outbound-tail"
import {
  allocatableStockPredicate,
  allocationOrderBy,
  describeAllocationRule,
  normalizeAllocationRule,
  reservableStockPredicate,
} from "@/lib/allocation"

/**
 * The whole outbound tail for one DO in a single read.
 *
 * Track A shipped the tail as six write endpoints and one list endpoint, which
 * left no way to ask "where is this order up to?" — so nothing could render it.
 * The operator screens need pack units, goods issues, loads and the delivery
 * note together to decide which step is available next, and four round trips to
 * build one screen would race against each other while the tail advances.
 */

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(_: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { id } = await context.params

    // is_local = true: the tenant setting only survives inside a transaction.
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const doRow = await lockDO(db, session.companyId, id)
    requireScope(policy, "warehouse", doRow.warehouseId)
    requireScope(policy, "client", doRow.clientId)

    const packUnits = await db.query(
      `SELECT u.id, u.pack_code, u.pack_type, u.status, u.total_quantity,
              u.gross_weight_kg, u.volume_cbm, u.closed_at,
              (gi.pack_unit_id IS NOT NULL) AS is_issued,
              (lp.pack_unit_id IS NOT NULL) AS is_loaded
       FROM do_pack_units u
       LEFT JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       LEFT JOIN outbound_load_pack_units lp
         ON lp.pack_unit_id = u.id AND lp.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.do_header_id = $2
         AND u.status <> 'CANCELLED'
       ORDER BY u.id ASC`,
      [session.companyId, doRow.id]
    )

    const goodsIssues = await db.query(
      `SELECT gi.id, gi.gi_number, gi.status, gi.total_pack_units, gi.total_quantity,
              gi.issued_at, gi.remarks, u.full_name AS issued_by_name
       FROM goods_issue_header gi
       LEFT JOIN users u ON u.id = gi.issued_by
       WHERE gi.company_id = $1
         AND gi.do_header_id = $2
       ORDER BY gi.id DESC`,
      [session.companyId, doRow.id]
    )

    const loads = await db.query(
      `SELECT l.id, l.load_number, l.status, l.vehicle_number, l.container_number,
              l.seal_number, l.driver_name, l.driver_phone, l.transport_company,
              l.loading_bay, l.loaded_at, l.goods_issue_id,
              COUNT(lpu.id)::int AS pack_unit_count,
              COALESCE(SUM(lpu.quantity), 0)::int AS total_quantity
       FROM outbound_loads l
       LEFT JOIN outbound_load_pack_units lpu
         ON lpu.load_id = l.id AND lpu.company_id = l.company_id
       WHERE l.company_id = $1
         AND l.do_header_id = $2
       GROUP BY l.id
       ORDER BY l.id DESC`,
      [session.companyId, doRow.id]
    )

    const deliveryNotes = await db.query(
      `SELECT dn.id, dn.delivery_note_number, dn.status, dn.total_pack_units,
              dn.total_quantity, dn.finalized_at, dn.remarks, dn.load_id,
              u.full_name AS finalized_by_name
       FROM delivery_note_header dn
       LEFT JOIN users u ON u.id = dn.finalized_by
       WHERE dn.company_id = $1
         AND dn.do_header_id = $2
       ORDER BY dn.id DESC`,
      [session.companyId, doRow.id]
    )

    // Which picked-but-unpacked stock is still available to build a pack unit
    // from. Serials already in a pack unit are excluded by the anti-join, which
    // is the same rule uq_pack_unit_serial enforces at write time.
    //
    // Ordered by the DO's allocation rule and filtered by the same expired /
    // short-shelf-life predicate the commit path uses. The pack screen offers
    // this list in order, so an operator packing top-down on a FEFO order packs
    // FEFO; leaving it in id order would have quietly undone the rule at the one
    // step where a human actually chooses the stock.
    // Two limits, both of which were missing and each of which let the screen
    // offer stock the order has no claim on:
    //
    //   reservableStockPredicate — excludes serials RESERVED to another DO line.
    //     Matching on item alone offered one order another order's held stock.
    //
    //   outstanding — quantity_requested minus what this line has already taken.
    //     Packed serials and dispatched quantity are the same units counted two
    //     ways once a delivery note finalizes, so GREATEST (not the sum) is the
    //     honest figure; the legacy dispatch route moves quantity_dispatched
    //     without ever creating a pack unit, which is why both are consulted.
    //
    // Without the cap the pool was every unit of the item in the building, so a
    // line for 2 offered 12 and packed 5.
    const rule = normalizeAllocationRule(doRow.allocationRule)
    const packableSerials = await db.query(
      `WITH line_taken AS (
         SELECT dli.id,
                dli.line_number,
                dli.item_id,
                GREATEST(
                  dli.quantity_requested - GREATEST(
                    dli.quantity_dispatched,
                    (SELECT COUNT(*)::int
                       FROM do_pack_unit_serials pus
                      WHERE pus.company_id = dli.company_id
                        AND pus.do_line_item_id = dli.id)
                  ),
                  0
                ) AS outstanding
           FROM do_line_items dli
          WHERE dli.company_id = $1
            AND dli.do_header_id = $2
       ),
       ranked AS (
         SELECT s.id, s.serial_number, s.status, s.bin_location, s.lp_record_id,
                s.batch_number, s.expiry_date,
                (s.expiry_date - CURRENT_DATE) AS days_to_expiry,
                l.id AS do_line_item_id, l.line_number,
                i.item_code, i.item_name,
                l.outstanding,
                ROW_NUMBER() OVER (
                  PARTITION BY l.id
                  ORDER BY ${allocationOrderBy(rule, "s")}
                ) AS rn
           FROM line_taken l
           JOIN items i ON i.id = l.item_id AND i.company_id = $1
           JOIN stock_serial_numbers s
             ON s.company_id = $1
            AND s.item_id = l.item_id
            AND s.warehouse_id = $3
            AND s.client_id = $4
            AND ${reservableStockPredicate("s", "l.id")}
           LEFT JOIN do_pack_unit_serials pus
             ON pus.serial_id = s.id AND pus.company_id = s.company_id
          WHERE pus.id IS NULL
            AND l.outstanding > 0
            AND ${allocatableStockPredicate("s", "i")}
       )
       SELECT id, serial_number, status, bin_location, lp_record_id,
              batch_number, expiry_date, days_to_expiry,
              do_line_item_id, line_number, item_code, item_name
         FROM ranked
        WHERE rn <= outstanding
        ORDER BY line_number ASC, rn ASC`,
      [session.companyId, doRow.id, doRow.warehouseId, doRow.clientId]
    )

    await db.query("COMMIT")

    return ok({
      do_id: doRow.id,
      do_number: doRow.doNumber,
      do_status: doRow.status,
      warehouse_id: doRow.warehouseId,
      client_id: doRow.clientId,
      allocation_rule: rule,
      allocation_note: describeAllocationRule(rule),
      pack_units: packUnits.rows,
      goods_issues: goodsIssues.rows,
      loads: loads.rows,
      delivery_notes: deliveryNotes.rows,
      packable_serials: packableSerials.rows,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundTailError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to load outbound tail"
    return fail("TAIL_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}