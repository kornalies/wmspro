/**
 * Inter-warehouse stock transfers.
 *
 * The state machine is the feature. A transfer is not one event but four, and
 * the gaps between them are where stock goes missing:
 *
 *   DRAFT      someone asked for it
 *   APPROVED   someone with authority agreed
 *   IN_TRANSIT it physically left the source — stock must stop being allocatable
 *              there the moment it does, or the source warehouse will promise it
 *              to a delivery order it can no longer fill
 *   RECEIVED   it arrived, possibly short, and the shortfall is evidence
 *
 * Serials are named at dispatch and checked off at receipt, so a short receipt
 * says which units did not arrive rather than only how many. For batch-tracked
 * stock that distinction is the whole point.
 */

import type { QueryResult, QueryResultRow } from "pg"

import { allocatableStockPredicate, allocationOrderBy } from "@/lib/allocation"

type Db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>
}

export type TransferStatus = "DRAFT" | "APPROVED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED"

export class StockTransferError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Legal transitions, in one place.
 *
 * Written as data rather than scattered `if (status !== ...)` checks so that
 * "can this happen next" has exactly one answer, and adding a state later means
 * editing a table instead of hunting through five routes.
 */
const TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  DRAFT: ["APPROVED", "CANCELLED"],
  APPROVED: ["IN_TRANSIT", "CANCELLED"],
  // No cancelling from IN_TRANSIT: the stock is on a truck. Getting it back is a
  // return to the source warehouse, which is another transfer, not an undo.
  IN_TRANSIT: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
}

export function assertTransition(from: TransferStatus, to: TransferStatus) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new StockTransferError(
      "WORKFLOW_BLOCKED",
      `A transfer cannot go from ${from} to ${to}.` +
        (from === "IN_TRANSIT" && to === "CANCELLED"
          ? " Stock already in transit has to be received and then transferred back."
          : "")
    )
  }
}

export async function nextTransferNumber(db: Db) {
  const res = await db.query<{ n: string }>(`SELECT nextval('stock_transfer_number_seq') AS n`)
  const seq = String(res.rows[0].n).padStart(6, "0")
  return `STN-${new Date().getFullYear()}-${seq}`
}

/** Lock the header for update and return it, or fail cleanly if it is not there. */
export async function lockTransfer(db: Db, companyId: number, transferId: number) {
  const res = await db.query(
    `SELECT * FROM stock_transfer_header WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, transferId]
  )
  if (!res.rows.length) {
    throw new StockTransferError("NOT_FOUND", `Transfer ${transferId} not found`, 404)
  }
  return res.rows[0]
}

export type TransferLineInput = { item_id: number; quantity: number; uom?: string; remarks?: string }

export async function createTransfer(
  db: Db,
  companyId: number,
  args: {
    clientId: number
    fromWarehouseId: number
    toWarehouseId: number
    lines: TransferLineInput[]
    reason?: string | null
    expectedDate?: string | null
    remarks?: string | null
    userId?: number | null
  }
) {
  if (args.fromWarehouseId === args.toWarehouseId) {
    throw new StockTransferError(
      "VALIDATION_ERROR",
      "Source and destination warehouse must differ",
      400
    )
  }
  if (!args.lines.length) {
    throw new StockTransferError("VALIDATION_ERROR", "A transfer needs at least one line", 400)
  }

  const transferNumber = await nextTransferNumber(db)
  const header = await db.query(
    `INSERT INTO stock_transfer_header
       (company_id, transfer_number, client_id, from_warehouse_id, to_warehouse_id, status,
        reason, expected_date, remarks, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7::date, $8, $9, $9)
     RETURNING *`,
    [
      companyId,
      transferNumber,
      args.clientId,
      args.fromWarehouseId,
      args.toWarehouseId,
      args.reason ?? null,
      args.expectedDate ?? null,
      args.remarks ?? null,
      args.userId ?? null,
    ]
  )
  const transfer = header.rows[0]

  let lineNumber = 0
  for (const line of args.lines) {
    lineNumber += 1
    const quantity = Math.trunc(Number(line.quantity))
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new StockTransferError("VALIDATION_ERROR", `Line ${lineNumber} needs a positive quantity`, 400)
    }
    await db.query(
      `INSERT INTO stock_transfer_lines
         (company_id, transfer_id, line_number, item_id, quantity_requested, uom, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, transfer.id, lineNumber, line.item_id, quantity, line.uom || "PCS", line.remarks ?? null]
    )
  }

  return transfer
}

export async function approveTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  userId?: number | null
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "APPROVED")
  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'APPROVED', approved_by = $3, approved_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, userId ?? null]
  )
  return res.rows[0]
}

/**
 * Dispatch: pick the units, take them out of the source's allocatable pool, and
 * write the outbound half of the ledger.
 *
 * Serial selection reuses the allocation module rather than ordering by id, so a
 * transfer honours FEFO and — importantly — cannot pick stock from a held or
 * recalled batch. Shipping a recalled lot to another of your own warehouses is
 * still shipping a recalled lot.
 */
export async function dispatchTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  userId?: number | null
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "IN_TRANSIT")

  const lines = await db.query(
    `SELECT * FROM stock_transfer_lines WHERE company_id = $1 AND transfer_id = $2 ORDER BY line_number`,
    [companyId, transferId]
  )

  const shortages: string[] = []
  let totalSent = 0

  for (const line of lines.rows) {
    const wanted = Number(line.quantity_requested)
    const picked = await db.query(
      `SELECT s.id
         FROM stock_serial_numbers s
         JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
        WHERE s.company_id = $1
          AND s.warehouse_id = $2
          AND s.client_id = $3
          AND s.item_id = $4
          AND s.status = 'IN_STOCK'
          AND s.do_line_item_id IS NULL
          AND ${allocatableStockPredicate("s", "i")}
        ORDER BY ${allocationOrderBy("FEFO", "s")}
        LIMIT $5
        FOR UPDATE OF s SKIP LOCKED`,
      [companyId, current.from_warehouse_id, current.client_id, line.item_id, wanted]
    )

    const serialIds = picked.rows.map((r) => Number(r.id))
    if (serialIds.length < wanted) {
      shortages.push(`item ${line.item_id}: wanted ${wanted}, available ${serialIds.length}`)
      continue
    }

    const sinceId = await maxMovementId(db, companyId)
    await db.query(
      `UPDATE stock_serial_numbers
          SET status = 'IN_TRANSIT', updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, serialIds]
    )
    for (const serialId of serialIds) {
      await db.query(
        `INSERT INTO stock_transfer_serials
           (company_id, transfer_id, transfer_line_id, serial_id)
         VALUES ($1, $2, $3, $4)`,
        [companyId, transferId, line.id, serialId]
      )
    }
    await stampMovements(db, {
      companyId,
      serialIds,
      sinceId,
      reference: String(current.transfer_number),
      reason: "Stock transfer dispatched",
      userId,
    })

    await db.query(
      `UPDATE stock_transfer_lines SET quantity_sent = $3, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = $2`,
      [companyId, line.id, serialIds.length]
    )
    totalSent += serialIds.length
  }

  if (shortages.length) {
    // All or nothing. A half-dispatched transfer would leave the paperwork saying
    // one thing and the truck carrying another, and the caller's transaction is
    // rolled back by the route.
    throw new StockTransferError(
      "INSUFFICIENT_STOCK",
      `Not enough allocatable stock at the source warehouse — ${shortages.join("; ")}`
    )
  }

  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'IN_TRANSIT', dispatched_by = $3, dispatched_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, userId ?? null]
  )
  return { transfer: res.rows[0], sent: totalSent }
}

/**
 * Receipt, possibly short.
 *
 * Anything not ticked off stays IN_TRANSIT rather than quietly returning to the
 * source: nobody has seen those units, and moving them anywhere would be an
 * assertion the warehouse cannot make. They surface as a discrepancy the
 * document reports, and an inventory adjustment is how they are eventually
 * written off — which is exactly why the two features landed together.
 */
export async function receiveTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  args: { receivedSerialIds?: number[] | null; remarks?: string | null; userId?: number | null }
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "RECEIVED")

  const onTruck = await db.query(
    `SELECT sts.id, sts.serial_id, sts.transfer_line_id
       FROM stock_transfer_serials sts
      WHERE sts.company_id = $1 AND sts.transfer_id = $2`,
    [companyId, transferId]
  )

  // No explicit list means everything arrived, which is the common case and the
  // one worth making a single click.
  const declared = args.receivedSerialIds?.length
    ? new Set(args.receivedSerialIds.map(Number))
    : new Set(onTruck.rows.map((r) => Number(r.serial_id)))

  const unknown = [...declared].filter(
    (id) => !onTruck.rows.some((r) => Number(r.serial_id) === id)
  )
  if (unknown.length) {
    throw new StockTransferError(
      "VALIDATION_ERROR",
      `Serial(s) ${unknown.join(", ")} were not on this transfer`,
      400
    )
  }

  const receivedIds = [...declared]
  if (receivedIds.length) {
    const sinceId = await maxMovementId(db, companyId)
    await db.query(
      `UPDATE stock_serial_numbers
          SET status = 'IN_STOCK', warehouse_id = $3, zone_id = NULL, zone_layout_id = NULL,
              bin_location = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, receivedIds, current.to_warehouse_id]
    )
    await db.query(
      `UPDATE stock_transfer_serials SET received = true
        WHERE company_id = $1 AND transfer_id = $2 AND serial_id = ANY($3::int[])`,
      [companyId, transferId, receivedIds]
    )
    await stampMovements(db, {
      companyId,
      serialIds: receivedIds,
      sinceId,
      reference: String(current.transfer_number),
      reason: "Stock transfer received",
      userId: args.userId,
    })
  }

  await db.query(
    `UPDATE stock_transfer_lines l
        SET quantity_received = (
              SELECT COUNT(*) FROM stock_transfer_serials sts
               WHERE sts.transfer_line_id = l.id AND sts.received
            ),
            updated_at = CURRENT_TIMESTAMP
      WHERE l.company_id = $1 AND l.transfer_id = $2`,
    [companyId, transferId]
  )

  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'RECEIVED', received_by = $3, received_at = CURRENT_TIMESTAMP,
            remarks = COALESCE($4, remarks), updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, args.userId ?? null, args.remarks ?? null]
  )

  const shortCount = onTruck.rows.length - receivedIds.length
  return { transfer: res.rows[0], received: receivedIds.length, short: shortCount }
}

export async function cancelTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  userId?: number | null
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "CANCELLED")
  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'CANCELLED', cancelled_by = $3, cancelled_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, userId ?? null]
  )
  return res.rows[0]
}

/**
 * Annotate the movements the database already wrote.
 *
 * `fn_track_serial_movements` fires on every status or warehouse change of a
 * serial and writes the ledger row itself, including the movement number.
 * Inserting our own row here would double-count every transfer in Stock
 * Movements — and the first attempt at this did exactly that until the
 * not-null on movement_number caught it.
 *
 * So the app stamps rather than writes: the trigger owns what happened, this
 * adds why and under which document. `sinceId` bounds it to rows created by the
 * statement we just ran, so a serial with a long history is not retro-labelled.
 */
export async function maxMovementId(db: Db, companyId: number) {
  const res = await db.query<{ id: string }>(
    `SELECT COALESCE(MAX(id), 0) AS id FROM stock_movements WHERE company_id = $1`,
    [companyId]
  )
  return Number(res.rows[0].id)
}

async function stampMovements(
  db: Db,
  args: {
    companyId: number
    serialIds: number[]
    sinceId: number
    reference: string
    reason: string
    userId?: number | null
  }
) {
  if (!args.serialIds.length) return
  await db.query(
    `UPDATE stock_movements
        SET reference_number = $4, reason = $5, created_by = COALESCE(created_by, $6)
      WHERE company_id = $1
        AND serial_number_id = ANY($2::int[])
        AND id > $3`,
    [args.companyId, args.serialIds, args.sinceId, args.reference, args.reason, args.userId ?? null]
  )
}
