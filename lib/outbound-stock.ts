/**
 * Shared outbound stock-commit rules.
 *
 * Two paths reach the same end state -- serials marked DISPATCHED and
 * do_line_items.quantity_dispatched incremented:
 *
 *   1. the legacy one-step dispatch route, which picks serials itself (FIFO)
 *   2. delivery-note finalize (Track A3), which commits the exact serials that
 *      were physically packed and loaded
 *
 * Both funnel through applyStockCommit so the rules cannot drift apart. This
 * mirrors how confirmGrnInTransaction is shared across the three inbound paths.
 */

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
 * FIFO selection used by the legacy dispatch route: prefer serials already
 * reserved against this line, then oldest unreserved stock.
 */
export async function commitDoLineStockFifo(
  db: DBClient,
  args: {
    companyId: number
    warehouseId: number
    clientId: number
    itemId: number
    doLineItemId: number
    quantity: number
  }
) {
  const { companyId, warehouseId, clientId, itemId, doLineItemId, quantity } = args
  if (quantity <= 0) return 0

  const stockRows = await db.query(
    `SELECT id
     FROM stock_serial_numbers
     WHERE warehouse_id = $1
       AND client_id = $2
       AND item_id = $3
       AND company_id = $4
       AND (
         (status = 'RESERVED' AND do_line_item_id = $5)
         OR (status = 'IN_STOCK' AND do_line_item_id IS NULL)
       )
     ORDER BY
       CASE WHEN status = 'RESERVED' THEN 0 ELSE 1 END,
       received_date ASC,
       id ASC
     LIMIT $6
     FOR UPDATE SKIP LOCKED`,
    [warehouseId, clientId, itemId, companyId, doLineItemId, quantity]
  )

  const serialIds = stockRows.rows.map((row) => Number(row.id)).filter(Boolean)
  if (serialIds.length < quantity) {
    throw new OutboundStockError(
      "INVENTORY_VALIDATION_FAILED",
      `Insufficient inventory for item ${itemId}. Required ${quantity}, available ${serialIds.length}.`
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