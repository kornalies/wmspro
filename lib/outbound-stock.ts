/**
 * Shared outbound stock-commit rules.
 *
 * Two paths reach the same end state -- serials marked DISPATCHED and
 * do_line_items.quantity_dispatched incremented:
 *
 *   1. the legacy one-step dispatch route, which picks serials itself using the
 *      DO's allocation rule (lib/allocation.ts)
 *   2. delivery-note finalize (Track A3), which commits the exact serials that
 *      were physically packed and loaded
 *
 * Both funnel through applyStockCommit so the rules cannot drift apart. This
 * mirrors how confirmGrnInTransaction is shared across the three inbound paths.
 */

import {
  allocatableBatchPredicate,
  allocatableStockPredicate,
  allocationOrderBy,
  normalizeAllocationRule,
  reservableStockPredicate,
  type AllocationRule,
} from "@/lib/allocation"

type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export class OutboundStockError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "OutboundStockError"
  }
}

async function applyStockCommit(
  db: DBClient,
  args: {
    companyId: number
    doLineItemId: number
    serialIds: number[]
  }
) {
  const { companyId, doLineItemId, serialIds } = args
  if (serialIds.length === 0) return 0

  await db.query(
    `UPDATE do_line_items
     SET quantity_dispatched = quantity_dispatched + $1
     WHERE id = $2
       AND company_id = $3`,
    [serialIds.length, doLineItemId, companyId]
  )

  await db.query(
    `UPDATE stock_serial_numbers
     SET status = 'DISPATCHED',
         do_line_item_id = $1,
         dispatched_date = CURRENT_DATE
     WHERE company_id = $2
       AND id = ANY($3::int[])`,
    [doLineItemId, companyId, serialIds]
  )

  return serialIds.length
}

/**
 * Automatic selection used by the legacy dispatch route: prefer serials already
 * reserved against this line, then unreserved stock in the order the DO's
 * allocation rule dictates.
 *
 * Ordering and the expired / short-shelf-life exclusions come from
 * lib/allocation.ts so this path cannot disagree with the advisory endpoint or
 * the packable pool about what a rule means. Before Track D this ordered by
 * received_date unconditionally, which is why a FEFO delivery order shipped
 * FIFO.
 */
export async function commitDoLineStock(
  db: DBClient,
  args: {
    companyId: number
    warehouseId: number
    clientId: number
    itemId: number
    doLineItemId: number
    quantity: number
    allocationRule?: AllocationRule
  }
) {
  const { companyId, warehouseId, clientId, itemId, doLineItemId, quantity } = args
  if (quantity <= 0) return 0
  const rule = normalizeAllocationRule(args.allocationRule)

  const stockRows = await db.query(
    `SELECT s.id
     FROM stock_serial_numbers s
     JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
     WHERE s.warehouse_id = $1
       AND s.client_id = $2
       AND s.item_id = $3
       AND s.company_id = $4
       AND ${reservableStockPredicate("s", "$5")}
       AND ${allocatableStockPredicate("s", "i")}
     ORDER BY
       CASE WHEN s.status = 'RESERVED' THEN 0 ELSE 1 END,
       ${allocationOrderBy(rule, "s")}
     LIMIT $6
     FOR UPDATE SKIP LOCKED`,
    [warehouseId, clientId, itemId, companyId, doLineItemId, quantity]
  )

  const serialIds = stockRows.rows.map((row) => Number(row.id)).filter(Boolean)
  if (serialIds.length < quantity) {
    // Distinguish "no stock" from "stock exists but is not allocatable".
    // Reporting a bare shortage when the real cause is expiry sends a supervisor
    // hunting for inventory that is sitting right there, blocked on purpose.
    // Counted in two buckets, because they need different actions: dates are a
    // planning problem, a held batch is someone's decision that has to be lifted
    // before this stock moves at all.
    const blocked = await db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE NOT (${allocatableBatchPredicate("s")}))::int AS held
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       WHERE s.warehouse_id = $1
         AND s.client_id = $2
         AND s.item_id = $3
         AND s.company_id = $4
         AND ${reservableStockPredicate("s", "$5")}
         AND NOT (${allocatableStockPredicate("s", "i")})`,
      [warehouseId, clientId, itemId, companyId, doLineItemId]
    )
    const blockedCount = Number(blocked.rows[0]?.n ?? 0)
    const heldCount = Number(blocked.rows[0]?.held ?? 0)
    const reasons: string[] = []
    if (blockedCount - heldCount > 0) {
      reasons.push(`${blockedCount - heldCount} expired or inside the minimum shelf life`)
    }
    if (heldCount > 0) reasons.push(`${heldCount} in a held or recalled batch`)
    throw new OutboundStockError(
      "INVENTORY_VALIDATION_FAILED",
      blockedCount > 0
        ? `Insufficient allocatable inventory for item ${itemId}. Required ${quantity}, available ${serialIds.length}. ${blockedCount} unit(s) are excluded: ${reasons.join("; ")}.`
        : `Insufficient inventory for item ${itemId}. Required ${quantity}, available ${serialIds.length}.`
    )
  }

  return applyStockCommit(db, { companyId, doLineItemId, serialIds })
}

/**
 * Commit an explicit serial set -- the pallet that was actually packed and
 * loaded. Re-locks and re-validates each serial so a concurrent dispatch of the
 * same stock cannot double-commit it.
 */
export async function commitPackedSerials(
  db: DBClient,
  args: {
    companyId: number
    doLineItemId: number
    serialIds: number[]
  }
) {
  const { companyId, doLineItemId, serialIds } = args
  if (serialIds.length === 0) return 0

  const locked = await db.query(
    `SELECT id, status
     FROM stock_serial_numbers
     WHERE company_id = $1
       AND id = ANY($2::int[])
     FOR UPDATE`,
    [companyId, serialIds]
  )

  if (locked.rows.length !== serialIds.length) {
    throw new OutboundStockError(
      "INVENTORY_VALIDATION_FAILED",
      `Packed stock no longer resolvable: expected ${serialIds.length} serials, found ${locked.rows.length}.`
    )
  }

  const alreadyGone = locked.rows.filter(
    (row) => String(row.status) !== "IN_STOCK" && String(row.status) !== "RESERVED"
  )
  if (alreadyGone.length > 0) {
    throw new OutboundStockError(
      "INVENTORY_VALIDATION_FAILED",
      `${alreadyGone.length} packed serial(s) are no longer in stock (status already ${String(
        alreadyGone[0].status
      )}). The pallet may have been dispatched by another route.`
    )
  }

  return applyStockCommit(db, { companyId, doLineItemId, serialIds })
}