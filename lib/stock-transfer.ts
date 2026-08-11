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

import { allocatableStockPredicate, allocationOrderBy, freeStockPredicate } from "@/lib/allocation"

type Db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>
}

export type TransferStatus =
  | "DRAFT"
  | "APPROVED"
  | "PICKED"
  | "IN_TRANSIT"
  | "RECEIVED"
  | "CANCELLED"

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
  APPROVED: ["PICKED", "CANCELLED"],
  // Picked stock is staged at the dock but still in the building, so cancelling
  // is still an option — it puts the units back rather than chasing a truck.
  PICKED: ["IN_TRANSIT", "CANCELLED"],
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

/**
 * What counts as available to a transfer, as one SQL fragment.
 *
 * Every place that answers "can this transfer go?" must ask the same question:
 * the form that offers items, the approval that authorises it, and the dispatch
 * that picks the units. When they disagree the screen promises stock the picker
 * cannot find, which is precisely how a transfer got raised against a warehouse
 * holding none of the item.
 *
 * `do_line_item_id IS NULL` excludes stock a delivery order has already pinned,
 * and the allocatable predicate excludes expired, short-shelf-life and held or
 * recalled batches — a transfer must not be offered stock it would be refused.
 */
export function availableStockWhere(alias = "s", itemAlias = "i"): string {
  return `${freeStockPredicate(alias)}
      AND ${allocatableStockPredicate(alias, itemAlias)}`
}

/**
 * What a transfer LINE can draw on: free stock, plus the units it already holds.
 *
 * Distinct from `availableStockWhere`, which answers "what is unclaimed" for the
 * raise form. Once a transfer is approved its stock is no longer free, so asking
 * the free-stock question about an approved line reports it as entirely
 * uncovered — the register said exactly that until this existed.
 *
 * A unit this line already holds still drops out if an adjustment has since
 * quarantined it (migration 076): a pallet reported damaged after the transfer
 * was approved must not be loaded onto the truck. Same rule as the batch recall
 * exclusion below — a hold survives competition, not a decision.
 *
 * `lineExpr` is SQL so this works with a bind parameter or a joined column.
 */
export function availableToLineWhere(lineExpr: string, alias = "s", itemAlias = "i"): string {
  return `${alias}.status = 'IN_STOCK'
      AND ${alias}.adjustment_line_id IS NULL
      AND (${alias}.transfer_line_id = ${lineExpr} OR ${freeStockPredicate(alias)})
      AND ${allocatableStockPredicate(alias, itemAlias)}`
}

export type ItemAvailability = {
  item_id: number
  item_code: string
  item_name: string
  uom: string | null
  available: number
}

/**
 * The items this client actually has at this warehouse, with counts.
 *
 * The raise form used to offer the entire item master, so an operator could pick
 * an item the client has never stored at the source. Offering only what is there
 * removes the mistake rather than reporting it later.
 */
export async function listTransferAvailability(
  db: Db,
  companyId: number,
  args: { clientId: number; warehouseId: number }
): Promise<ItemAvailability[]> {
  const res = await db.query(
    `SELECT s.item_id, i.item_code, i.item_name, i.uom, COUNT(*)::int AS available
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
      WHERE s.company_id = $1
        AND s.warehouse_id = $2
        AND s.client_id = $3
        AND ${availableStockWhere()}
      GROUP BY s.item_id, i.item_code, i.item_name, i.uom
      ORDER BY i.item_code`,
    [companyId, args.warehouseId, args.clientId]
  )
  return res.rows.map((row) => ({
    item_id: Number(row.item_id),
    item_code: String(row.item_code),
    item_name: String(row.item_name),
    uom: row.uom == null ? null : String(row.uom),
    available: Number(row.available),
  }))
}

export type TransferShortage = {
  item_id: number
  item_code: string
  wanted: number
  available: number
}

/**
 * Per-line shortfall for a transfer that has not dispatched yet.
 *
 * Read-only and lock-free: this answers "would dispatch succeed right now",
 * which is what approval needs to know and what the register needs to show. It
 * is NOT a reservation — stock counted here can still be taken by a delivery
 * order before the truck loads. Closing that window needs a real hold on the
 * serials, which is the next phase of this work.
 */
export async function transferShortages(
  db: Db,
  companyId: number,
  transferId: number,
  header?: { client_id: number; from_warehouse_id: number }
): Promise<TransferShortage[]> {
  const owner =
    header ??
    (
      await db.query(
        `SELECT client_id, from_warehouse_id FROM stock_transfer_header
          WHERE company_id = $1 AND id = $2`,
        [companyId, transferId]
      )
    ).rows[0]
  if (!owner) return []

  const res = await db.query(
    // "Available to this line" is free stock PLUS whatever the line already
    // holds. Counting only free stock would report an approved transfer — which
    // by definition holds everything it needs — as entirely uncovered.
    `SELECT l.item_id, i.item_code, l.quantity_requested AS wanted,
            (SELECT COUNT(*) FROM stock_serial_numbers s
               JOIN items i2 ON i2.id = s.item_id AND i2.company_id = s.company_id
              WHERE s.company_id = l.company_id
                AND s.warehouse_id = $3
                AND s.client_id = $4
                AND s.item_id = l.item_id
                AND ${availableToLineWhere("l.id", "s", "i2")}
            )::int AS available
       FROM stock_transfer_lines l
       JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = $1 AND l.transfer_id = $2
      ORDER BY l.line_number`,
    [companyId, transferId, owner.from_warehouse_id, owner.client_id]
  )

  return res.rows
    .map((row) => ({
      item_id: Number(row.item_id),
      item_code: String(row.item_code),
      wanted: Number(row.wanted),
      available: Number(row.available),
    }))
    .filter((row) => row.available < row.wanted)
}

/** The shortage message, worded the same wherever it is raised. */
export function describeShortages(shortages: TransferShortage[]): string {
  return shortages
    .map((s) => `${s.item_code}: wanted ${s.wanted}, available ${s.available}`)
    .join("; ")
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

/**
 * Approval, which is where the stock is actually claimed.
 *
 * Raising a transfer stays permissive — a draft is a request, and a planner may
 * legitimately raise one against stock still inbound. Approval is where someone
 * takes responsibility, so it both refuses what the source cannot cover and
 * takes a real hold on the units, under the same FOR UPDATE SKIP LOCKED that
 * dispatch uses. Two approvals racing for the last unit cannot both win.
 *
 * The hold is `transfer_line_id`, not a status change — see migration 072 for
 * why. The unit stays IN_STOCK because it has not moved: it is still on hand,
 * still billable, still countable, just no longer free.
 */
export async function approveTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  userId?: number | null,
  options: { requireSeparateApprover?: boolean } = {}
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "APPROVED")

  // Opt-in segregation of duties. RBAC already stops an OPERATOR approving at
  // all; this covers the tenant who wants two pairs of eyes even among users who
  // all hold the permission.
  if (
    options.requireSeparateApprover &&
    userId != null &&
    Number(current.created_by) === Number(userId)
  ) {
    throw new StockTransferError(
      "SEPARATE_APPROVER_REQUIRED",
      "This transfer must be approved by someone other than the person who raised it",
      403
    )
  }

  const lines = await db.query(
    `SELECT l.*, i.item_code
       FROM stock_transfer_lines l
       JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = $1 AND l.transfer_id = $2
      ORDER BY l.line_number`,
    [companyId, transferId]
  )

  const shortages: TransferShortage[] = []
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
          AND ${availableStockWhere()}
        ORDER BY ${allocationOrderBy("FEFO", "s")}
        LIMIT $5
        FOR UPDATE OF s SKIP LOCKED`,
      [companyId, current.from_warehouse_id, current.client_id, line.item_id, wanted]
    )

    const serialIds = picked.rows.map((r) => Number(r.id))
    if (serialIds.length < wanted) {
      shortages.push({
        item_id: Number(line.item_id),
        item_code: String(line.item_code),
        wanted,
        available: serialIds.length,
      })
      continue
    }

    await db.query(
      `UPDATE stock_serial_numbers
          SET transfer_line_id = $3, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, serialIds, line.id]
    )
  }

  // All or nothing, and the caller's transaction is rolled back by the route, so
  // a partial set of holds cannot survive a refused approval.
  if (shortages.length) {
    throw new StockTransferError(
      "INSUFFICIENT_STOCK",
      `Cannot approve — the source warehouse does not have this stock: ${describeShortages(shortages)}`
    )
  }

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
 * The pick: find the units and stage them.
 *
 * This is the step that used to not exist. Nothing moves here — the serials stay
 * IN_STOCK and stay held — but they are now named, and named by whoever walked
 * the aisle rather than by a query nobody checked.
 *
 * `serialIds` is how a scanner reports what it actually found. Omitting it picks
 * the units the transfer already holds, which is the same selection approval
 * made and the sane default for a site that does not scan. Either way the pick
 * must be complete: a short pick raises the shortage rather than quietly staging
 * less than the paperwork claims.
 *
 * The allocatable predicate is re-applied to held units too, deliberately. A
 * batch recalled between approval and picking must not ship, and a hold is not a
 * licence: it survives competition for the stock, not a decision about it.
 */
export async function pickTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  args: { serialIds?: number[] | null; userId?: number | null }
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "PICKED")

  const lines = await db.query(
    `SELECT l.*, i.item_code
       FROM stock_transfer_lines l
       JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = $1 AND l.transfer_id = $2
      ORDER BY l.line_number`,
    [companyId, transferId]
  )

  const scanned = args.serialIds?.length ? [...new Set(args.serialIds.map(Number))] : null
  const shortages: string[] = []
  let totalPicked = 0

  for (const line of lines.rows) {
    const wanted = Number(line.quantity_requested)
    // Scanned units are filtered against the same rule the automatic pick uses,
    // so a scanner cannot stage stock the system would refuse to choose — wrong
    // warehouse, another line's hold, a recalled batch.
    const picked = await db.query(
      `SELECT s.id
         FROM stock_serial_numbers s
         JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
        WHERE s.company_id = $1
          AND s.warehouse_id = $2
          AND s.client_id = $3
          AND s.item_id = $4
          AND ($7::int[] IS NULL OR s.id = ANY($7::int[]))
          AND ${availableToLineWhere("$6", "s", "i")}
        ORDER BY CASE WHEN s.transfer_line_id = $6 THEN 0 ELSE 1 END,
                 ${allocationOrderBy("FEFO", "s")}
        LIMIT $5
        FOR UPDATE OF s SKIP LOCKED`,
      [
        companyId,
        current.from_warehouse_id,
        current.client_id,
        line.item_id,
        wanted,
        line.id,
        scanned,
      ]
    )

    const serialIds = picked.rows.map((r) => Number(r.id))
    if (serialIds.length < wanted) {
      shortages.push(`${line.item_code}: wanted ${wanted}, found ${serialIds.length}`)
      continue
    }

    // Staging keeps the hold. The unit has not left, and until it does the claim
    // is the only thing stopping a delivery order taking it off the dock.
    await db.query(
      `UPDATE stock_serial_numbers
          SET transfer_line_id = $3, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, serialIds, line.id]
    )
    for (const serialId of serialIds) {
      await db.query(
        `INSERT INTO stock_transfer_serials
           (company_id, transfer_id, transfer_line_id, serial_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (transfer_id, serial_id) DO NOTHING`,
        [companyId, transferId, line.id, serialId]
      )
    }
    await db.query(
      `UPDATE stock_transfer_lines SET quantity_picked = $3, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND id = $2`,
      [companyId, line.id, serialIds.length]
    )
    totalPicked += serialIds.length
  }

  if (shortages.length) {
    // All or nothing, and the route rolls the transaction back — a half-staged
    // pick would leave units claimed for a transfer that never goes.
    throw new StockTransferError(
      "INSUFFICIENT_STOCK",
      scanned
        ? `The scanned units do not cover this transfer — ${shortages.join("; ")}`
        : `Not enough allocatable stock at the source warehouse — ${shortages.join("; ")}`
    )
  }

  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'PICKED', picked_by = $3, picked_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, args.userId ?? null]
  )
  return { transfer: res.rows[0], picked: totalPicked }
}

/**
 * Gate out: the stock leaves.
 *
 * Only now does anything move. The units were named at the pick, so this step
 * ships exactly what was staged rather than re-choosing — re-running the
 * selection here would let the truck carry something other than what the picker
 * put on it, which is the whole failure the pick step exists to prevent.
 *
 * Vehicle and driver are captured here because this is the first moment in the
 * flow that knows them. They have been columns since 070 and were never written.
 */
export async function dispatchTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  args: { vehicleNumber?: string | null; driverName?: string | null; userId?: number | null }
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "IN_TRANSIT")

  const staged = await db.query(
    `SELECT sts.serial_id, sts.transfer_line_id, s.status, s.serial_number
       FROM stock_transfer_serials sts
       JOIN stock_serial_numbers s ON s.id = sts.serial_id AND s.company_id = sts.company_id
      WHERE sts.company_id = $1 AND sts.transfer_id = $2
      FOR UPDATE OF s`,
    [companyId, transferId]
  )
  if (!staged.rows.length) {
    throw new StockTransferError("WORKFLOW_BLOCKED", "Nothing has been picked for this transfer")
  }

  // Between the pick and the truck a staged unit can be written off or counted
  // away. Shipping it would send a serial the system has already retired.
  const gone = staged.rows.filter((r) => String(r.status) !== "IN_STOCK")
  if (gone.length) {
    throw new StockTransferError(
      "STOCK_MOVED",
      `Picked stock is no longer available to send: ${gone
        .map((r) => `${r.serial_number} is ${r.status}`)
        .join("; ")}`
    )
  }

  const serialIds = staged.rows.map((r) => Number(r.serial_id))
  const sinceId = await maxMovementId(db, companyId)
  // The hold is consumed, not carried: from here the link between unit and
  // transfer lives in stock_transfer_serials, which is a record of what shipped
  // rather than a claim on what has not.
  await db.query(
    `UPDATE stock_serial_numbers
        SET status = 'IN_TRANSIT', transfer_line_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = ANY($2::int[])`,
    [companyId, serialIds]
  )
  await stampMovements(db, {
    companyId,
    serialIds,
    sinceId,
    reference: String(current.transfer_number),
    reason: "Stock transfer dispatched",
    userId: args.userId,
  })

  await db.query(
    `UPDATE stock_transfer_lines l
        SET quantity_sent = (
              SELECT COUNT(*) FROM stock_transfer_serials sts
               WHERE sts.company_id = l.company_id AND sts.transfer_line_id = l.id
            ),
            updated_at = CURRENT_TIMESTAMP
      WHERE l.company_id = $1 AND l.transfer_id = $2`,
    [companyId, transferId]
  )

  // Anything still held but not staged did not go on the truck. Leaving the hold
  // would strand stock that no longer has a transfer waiting for it.
  await releaseTransferHolds(db, companyId, transferId)

  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'IN_TRANSIT', dispatched_by = $3, dispatched_at = CURRENT_TIMESTAMP,
            vehicle_number = COALESCE($4, vehicle_number),
            driver_name = COALESCE($5, driver_name),
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [
      companyId,
      transferId,
      args.userId ?? null,
      args.vehicleNumber?.trim() || null,
      args.driverName?.trim() || null,
    ]
  )
  return { transfer: res.rows[0], sent: serialIds.length }
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
    // Clearing the location is right — the unit's old bin is in another
    // building — but it means arriving stock has NO location until someone puts
    // it away. That is not a gap: the put-away queue is derived from stock
    // rather than stored as tasks, so these units appear in it automatically at
    // the destination. `?unlocated=true` on /api/stock/putaway is what separates
    // them from stock that is merely being reshuffled.
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

export type TransferException = {
  serial_id: number
  serial_number: string
  item_id: number
  item_code: string
  batch_number: string | null
  transfer_id: number
  transfer_number: string
  client_id: number
  client_name: string | null
  from_warehouse_id: number
  from_warehouse_name: string | null
  to_warehouse_name: string | null
  dispatched_at: string | null
  expected_date: string | null
  days_stranded: number
  bucket: "SHORT_RECEIPT" | "OVERDUE"
}

/**
 * Units that left a warehouse and never turned up.
 *
 * This is the population nothing else surfaces. A short receipt deliberately
 * leaves the missing units IN_TRANSIT rather than restoring them — nobody has
 * seen them, so moving them anywhere would be an assertion the warehouse cannot
 * make — but `lots.ts` counts IN_TRANSIT as on hand. The consequence is that a
 * lost unit inflates inventory indefinitely while looking perfectly healthy, and
 * no screen ever asks about it.
 *
 * Two buckets, because they need different actions:
 *
 *   SHORT_RECEIPT — the transfer is closed and these units did not arrive. There
 *     is nothing left to wait for; this is a write-off waiting to be approved.
 *
 *   OVERDUE — still in flight, but past its expected date. This is a phone call
 *     to the carrier, not a write-off.
 *
 * A transfer in flight and on time is not an exception and is not listed.
 */
export async function listTransferExceptions(
  db: Db,
  companyId: number,
  args: { warehouseId?: number | null } = {}
): Promise<TransferException[]> {
  const res = await db.query(
    `SELECT s.id AS serial_id, s.serial_number, s.item_id, i.item_code, s.batch_number,
            h.id AS transfer_id, h.transfer_number, h.client_id, c.client_name,
            h.from_warehouse_id, fw.warehouse_name AS from_warehouse_name,
            tw.warehouse_name AS to_warehouse_name,
            h.dispatched_at, h.expected_date,
            GREATEST(0, (CURRENT_DATE - h.dispatched_at::date))::int AS days_stranded,
            CASE WHEN h.status = 'RECEIVED' THEN 'SHORT_RECEIPT' ELSE 'OVERDUE' END AS bucket
       FROM stock_transfer_serials sts
       JOIN stock_transfer_header h
         ON h.id = sts.transfer_id AND h.company_id = sts.company_id
       JOIN stock_serial_numbers s
         ON s.id = sts.serial_id AND s.company_id = sts.company_id
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
       LEFT JOIN warehouses fw ON fw.id = h.from_warehouse_id AND fw.company_id = h.company_id
       LEFT JOIN warehouses tw ON tw.id = h.to_warehouse_id AND tw.company_id = h.company_id
      WHERE sts.company_id = $1
        AND sts.received = false
        AND s.status = 'IN_TRANSIT'
        AND (
          h.status = 'RECEIVED'
          OR (h.status = 'IN_TRANSIT' AND h.expected_date IS NOT NULL
              AND h.expected_date < CURRENT_DATE)
        )
        AND ($2::int IS NULL OR h.from_warehouse_id = $2 OR h.to_warehouse_id = $2)
      ORDER BY days_stranded DESC, s.serial_number
      LIMIT 500`,
    [companyId, args.warehouseId ?? null]
  )
  return res.rows as TransferException[]
}

/**
 * Give back every unit this transfer is holding.
 *
 * Cancelling used to be a status stamp, which was harmless only because nothing
 * was held. Now it must return the stock, or a cancelled transfer would sit on
 * inventory forever with no screen showing why it cannot be sold.
 */
export async function releaseTransferHolds(db: Db, companyId: number, transferId: number) {
  const res = await db.query(
    `UPDATE stock_serial_numbers
        SET transfer_line_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1
        AND transfer_line_id IN (
          SELECT id FROM stock_transfer_lines
           WHERE company_id = $1 AND transfer_id = $2
        )
      RETURNING id`,
    [companyId, transferId]
  )
  return res.rows.length
}

export async function cancelTransfer(
  db: Db,
  companyId: number,
  transferId: number,
  userId?: number | null
) {
  const current = await lockTransfer(db, companyId, transferId)
  assertTransition(current.status as TransferStatus, "CANCELLED")

  // A picked transfer has units staged against it. Cancelling has to undo the
  // pick as well as the hold, or the transfer would keep a list of what is on a
  // pallet that is about to be put back on the shelf.
  await db.query(
    `DELETE FROM stock_transfer_serials WHERE company_id = $1 AND transfer_id = $2`,
    [companyId, transferId]
  )
  await db.query(
    `UPDATE stock_transfer_lines
        SET quantity_picked = 0, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND transfer_id = $2`,
    [companyId, transferId]
  )

  const released = await releaseTransferHolds(db, companyId, transferId)
  const res = await db.query(
    `UPDATE stock_transfer_header
        SET status = 'CANCELLED', cancelled_by = $3, cancelled_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, transferId, userId ?? null]
  )
  return { transfer: res.rows[0], released }
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
