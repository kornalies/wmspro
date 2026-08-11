/**
 * Inventory adjustments: stock changing outside the inbound/outbound flow.
 *
 * Today an adjustment is a `stock_movements` row with movement_type ADJUSTMENT
 * or LOST. A movement is an EFFECT — it records that stock changed, not that
 * anyone decided it should. There is no reason code that survives, no approver,
 * and nothing to print when a client asks why their stock figure moved.
 *
 * The rule inherited from cycle counting holds here: **WMS never invents a
 * serial number**. An overage cannot be applied by conjuring units, so an
 * INCREASE must name the serials being brought in. The operator supplies the
 * identity; the system supplies the bookkeeping. A DECREASE names the serials
 * being written off, which are cancelled rather than deleted so the trail
 * survives.
 *
 * THE FLOW, AND WHAT EACH STEP IS FOR
 *
 *   DRAFT      someone reported it — the named units are QUARANTINED at once
 *              (migration 076) so nothing ships stock that is under question,
 *              but no stock is written off and no figure changes
 *   APPROVED   someone with authority agreed; this is the only step that moves
 *              stock, and it is the only step that needs a second person
 *   REJECTED   the approver disagreed — quarantine released, nothing happened
 *   CANCELLED  the raiser withdrew it — same, but their own decision
 *
 * The split between "raising quarantines" and "approval writes off" is the whole
 * design. Raising has to have a physical effect or damaged stock ships while the
 * paperwork waits; approval has to be the only thing that touches the books or
 * the approval is decoration.
 */

import type { QueryResult, QueryResultRow } from "pg"

import { binLocationExpr } from "@/lib/stock-search"

type Db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>
}

export type AdjustmentStatus = "DRAFT" | "APPROVED" | "REJECTED" | "CANCELLED"
export type AdjustmentDirection = "INCREASE" | "DECREASE"

/**
 * Legal transitions, in one place.
 *
 * Same shape as the transfer state machine in lib/stock-transfer.ts, and for the
 * same reason: "can this happen next" gets exactly one answer instead of an
 * `if (status !== 'DRAFT')` in every route.
 */
const TRANSITIONS: Record<AdjustmentStatus, AdjustmentStatus[]> = {
  // Rejected by the approver, cancelled by the raiser. Both end the adjustment
  // with nothing written off; the difference is who decided and what the
  // register should show a client asking about it later.
  DRAFT: ["APPROVED", "REJECTED", "CANCELLED"],
  // Nothing follows approval. Undoing a write-off means finding the stock again,
  // which is an INCREASE — a new adjustment with its own approver, not an edit.
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
}

export function assertTransition(from: AdjustmentStatus, to: AdjustmentStatus, number: string) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new AdjustmentError(
      "WORKFLOW_BLOCKED",
      `Adjustment ${number} is ${from} and cannot become ${to}.` +
        (from === "APPROVED"
          ? " An approved adjustment has already moved stock; reversing it is a new adjustment in the other direction."
          : "")
    )
  }
}

export const ADJUSTMENT_REASONS = [
  "DAMAGE",
  "LOSS",
  "FOUND",
  "EXPIRY",
  "COUNT_VARIANCE",
  "SYSTEM_CORRECTION",
  "OTHER",
] as const

/**
 * Statuses a unit can be written off from.
 *
 * IN_TRANSIT is included deliberately: stock that left one warehouse and never
 * arrived at the other is the single most likely thing anyone will ever write
 * off, and the Stock Transfer Note's own discrepancy note tells the reader to
 * resolve it with an adjustment. Refusing it here would make that instruction
 * impossible to follow.
 *
 * DISPATCHED and CANCELLED are not here: those units have already left the
 * building or already been written off, and adjusting them again would
 * double-count the loss.
 */
export const WRITE_OFF_STATUSES = ["IN_STOCK", "RESERVED", "IN_TRANSIT"]

export class AdjustmentError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * What an adjustment is allowed to reach, as one SQL fragment.
 *
 * The counterpart to `availableStockWhere()` in lib/stock-transfer.ts, and
 * deliberately NOT the same predicate — do not "fix" this by routing it through
 * `allocatableStockPredicate`. A transfer must be refused expired stock, stock
 * inside its minimum shelf life, and stock on a held or recalled batch. An
 * adjustment exists precisely to reach that stock: EXPIRY writes off expired
 * units, DAMAGE writes off a recalled batch. Applying the allocation exclusions
 * here would make the reason codes unusable for the cases they were written for.
 *
 * What it does exclude is stock already quarantined by another open adjustment
 * (migration 076), so two people reporting the same pallet cannot both write it
 * off.
 */
export function adjustableStockWhere(alias = "s"): string {
  return `${alias}.status IN (${WRITE_OFF_STATUSES.map((s) => `'${s}'`).join(", ")})
      AND ${alias}.adjustment_line_id IS NULL`
}

/**
 * Who else has a claim on a unit, named rather than counted.
 *
 * Returned as SQL rather than resolved in JS so the picker, the create-time
 * warning and the approval check all describe a conflict the same way. A unit
 * can be reserved to a delivery order or held for a transfer while being
 * reported damaged — see migration 076 for why that is allowed to exist — and
 * everyone who looks at it has to be told which order they are about to break.
 */
export function claimedByExpr(alias = "s"): string {
  return `COALESCE(
    (SELECT 'Delivery order ' || dh.do_number
       FROM do_line_items dli
       JOIN do_header dh ON dh.id = dli.do_header_id AND dh.company_id = dli.company_id
      WHERE dli.id = ${alias}.do_line_item_id AND dli.company_id = ${alias}.company_id),
    (SELECT 'Stock transfer ' || sth.transfer_number
       FROM stock_transfer_lines stl
       JOIN stock_transfer_header sth ON sth.id = stl.transfer_id AND sth.company_id = stl.company_id
      WHERE stl.id = ${alias}.transfer_line_id AND stl.company_id = ${alias}.company_id)
  )`
}

export type AdjustableItem = {
  item_id: number
  item_code: string
  item_name: string
  uom: string | null
  adjustable: number
}

/**
 * The items this client actually holds at this warehouse, with counts.
 *
 * The raise form used to offer the entire item master and a free-text serial
 * box, so an operator typed serial numbers from memory against a warehouse that
 * might hold none of them and found out one 400 at a time. Offering only what is
 * there removes the mistake instead of reporting it.
 */
export async function listAdjustableItems(
  db: Db,
  companyId: number,
  args: { clientId: number; warehouseId: number }
): Promise<AdjustableItem[]> {
  const res = await db.query(
    `SELECT s.item_id, i.item_code, i.item_name, i.uom, COUNT(*)::int AS adjustable
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
      WHERE s.company_id = $1
        AND s.warehouse_id = $2
        AND s.client_id = $3
        AND ${adjustableStockWhere()}
      GROUP BY s.item_id, i.item_code, i.item_name, i.uom
      ORDER BY i.item_code`,
    [companyId, args.warehouseId, args.clientId]
  )
  return res.rows.map((row) => ({
    item_id: Number(row.item_id),
    item_code: String(row.item_code),
    item_name: String(row.item_name),
    uom: row.uom == null ? null : String(row.uom),
    adjustable: Number(row.adjustable),
  }))
}

export type AdjustableSerial = {
  id: number
  serial_number: string
  status: string
  batch_number: string | null
  expiry_date: string | null
  bin_location: string
  received_date: string | null
  claimed_by: string | null
}

/**
 * The units themselves, so the operator picks rather than types.
 *
 * Filtered and limited in SQL, never in the browser. The put-away screen taught
 * this the hard way: a client-side filter over a server-side LIMIT means the row
 * you are looking for is often not in the response at all.
 */
export async function listAdjustableSerials(
  db: Db,
  companyId: number,
  args: {
    clientId: number
    warehouseId: number
    itemId: number
    q?: string | null
    limit?: number
  }
): Promise<AdjustableSerial[]> {
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500)
  const res = await db.query(
    `SELECT s.id, s.serial_number, s.status, s.batch_number, s.expiry_date, s.received_date,
            ${binLocationExpr("s", "zl")} AS bin_location,
            ${claimedByExpr("s")} AS claimed_by
       FROM stock_serial_numbers s
       LEFT JOIN warehouse_zone_layouts zl ON zl.id = s.zone_layout_id AND zl.company_id = s.company_id
      WHERE s.company_id = $1
        AND s.warehouse_id = $2
        AND s.client_id = $3
        AND s.item_id = $4
        AND ($5::text IS NULL OR s.serial_number ILIKE '%' || $5 || '%'
             OR s.batch_number ILIKE '%' || $5 || '%')
        AND ${adjustableStockWhere()}
      ORDER BY s.received_date ASC NULLS LAST, s.id ASC
      LIMIT ${limit}`,
    [companyId, args.warehouseId, args.clientId, args.itemId, args.q?.trim() || null]
  )
  return res.rows.map((row) => ({
    id: Number(row.id),
    serial_number: String(row.serial_number),
    status: String(row.status),
    batch_number: row.batch_number == null ? null : String(row.batch_number),
    expiry_date: row.expiry_date == null ? null : String(row.expiry_date).slice(0, 10),
    bin_location: String(row.bin_location),
    received_date: row.received_date == null ? null : String(row.received_date).slice(0, 10),
    claimed_by: row.claimed_by == null ? null : String(row.claimed_by),
  }))
}

export type ReceiptLine = {
  grn_line_item_id: number
  grn_number: string
  grn_date: string | null
  line_number: number
  quantity: number
  batch_number: string | null
  expiry_date: string | null
}

/**
 * The receipts an INCREASE is allowed to attribute found stock to.
 *
 * `stock_serial_numbers.grn_line_item_id` is NOT NULL and the lot genealogy walks
 * it, so found stock has to declare which receipt it belongs to. The screen never
 * asked for it, which meant "Add found stock" always failed with a 400 about a
 * field the operator had no way to supply — this is what makes that path usable.
 *
 * Batch and expiry come from the receipt's own serials so the found units inherit
 * the identity of the consignment they are being attributed to rather than having
 * one typed in beside it.
 */
export async function listReceiptLines(
  db: Db,
  companyId: number,
  args: { clientId: number; warehouseId: number; itemId: number }
): Promise<ReceiptLine[]> {
  const res = await db.query(
    `SELECT gli.id AS grn_line_item_id, gh.grn_number, gh.grn_date, gli.line_number, gli.quantity,
            (SELECT s.batch_number FROM stock_serial_numbers s
              WHERE s.company_id = gli.company_id AND s.grn_line_item_id = gli.id
                AND s.batch_number IS NOT NULL LIMIT 1) AS batch_number,
            (SELECT s.expiry_date FROM stock_serial_numbers s
              WHERE s.company_id = gli.company_id AND s.grn_line_item_id = gli.id
                AND s.expiry_date IS NOT NULL LIMIT 1) AS expiry_date
       FROM grn_line_items gli
       JOIN grn_header gh ON gh.id = gli.grn_header_id AND gh.company_id = gli.company_id
      WHERE gli.company_id = $1
        AND gh.warehouse_id = $2
        AND gh.client_id = $3
        AND gli.item_id = $4
      ORDER BY gh.grn_date DESC NULLS LAST, gh.id DESC, gli.line_number
      LIMIT 100`,
    [companyId, args.warehouseId, args.clientId, args.itemId]
  )
  return res.rows.map((row) => ({
    grn_line_item_id: Number(row.grn_line_item_id),
    grn_number: String(row.grn_number),
    grn_date: row.grn_date == null ? null : String(row.grn_date).slice(0, 10),
    line_number: Number(row.line_number),
    quantity: Number(row.quantity),
    batch_number: row.batch_number == null ? null : String(row.batch_number),
    expiry_date: row.expiry_date == null ? null : String(row.expiry_date).slice(0, 10),
  }))
}

export async function nextAdjustmentNumber(db: Db) {
  const res = await db.query<{ n: string }>(`SELECT nextval('inventory_adjustment_number_seq') AS n`)
  return `IAR-${new Date().getFullYear()}-${String(res.rows[0].n).padStart(6, "0")}`
}

export type AdjustmentLineInput = {
  item_id: number
  direction: AdjustmentDirection
  serials: string[]
  /** Required for INCREASE — see the column comment in migration 070. */
  grn_line_item_id?: number | null
  batch_number?: string | null
  expiry_date?: string | null
  bin_location?: string | null
  remarks?: string | null
}

export type AdjustmentWarning = {
  serial_number: string
  claimed_by: string
  message: string
}

/**
 * Raise an adjustment. Nothing is written off; the named units are quarantined.
 *
 * Create warns, approve blocks — the same policy the transfer flow settled on.
 * A unit somebody else has claimed does not stop the adjustment being raised
 * (damage happens to sold stock too), it comes back as a warning that the
 * approver has to acknowledge before anything moves.
 */
export async function createAdjustment(
  db: Db,
  companyId: number,
  args: {
    clientId: number
    warehouseId: number
    reasonCode: string
    reason?: string | null
    referenceNo?: string | null
    lines: AdjustmentLineInput[]
    userId?: number | null
    sourceModule?: string
    sourceRef?: string | null
  }
): Promise<{ adjustment: QueryResultRow; warnings: AdjustmentWarning[] }> {
  const warnings: AdjustmentWarning[] = []

  if (!(ADJUSTMENT_REASONS as readonly string[]).includes(args.reasonCode)) {
    throw new AdjustmentError(
      "VALIDATION_ERROR",
      `reason_code must be one of ${ADJUSTMENT_REASONS.join(", ")}`,
      400
    )
  }
  if (!args.lines.length) {
    throw new AdjustmentError("VALIDATION_ERROR", "An adjustment needs at least one line", 400)
  }

  const number = await nextAdjustmentNumber(db)
  const header = await db.query(
    `INSERT INTO inventory_adjustment_header
       (company_id, adjustment_number, client_id, warehouse_id, status, reason_code, reason,
        reference_no, source_module, source_ref, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [
      companyId,
      number,
      args.clientId,
      args.warehouseId,
      args.reasonCode,
      args.reason ?? null,
      args.referenceNo ?? null,
      args.sourceModule || "MANUAL",
      args.sourceRef ?? null,
      args.userId ?? null,
    ]
  )
  const adjustment = header.rows[0]

  let lineNumber = 0
  for (const line of args.lines) {
    lineNumber += 1
    const serials = (line.serials || []).map((s) => String(s).trim()).filter(Boolean)
    if (!serials.length) {
      throw new AdjustmentError(
        "VALIDATION_ERROR",
        `Line ${lineNumber} must name the serial numbers being adjusted — quantities alone are not enough to move stock`,
        400
      )
    }
    if (line.direction !== "INCREASE" && line.direction !== "DECREASE") {
      throw new AdjustmentError("VALIDATION_ERROR", `Line ${lineNumber} needs a direction`, 400)
    }
    if (line.direction === "INCREASE" && !Number(line.grn_line_item_id)) {
      throw new AdjustmentError(
        "VALIDATION_ERROR",
        `Line ${lineNumber} must name the receipt line this stock arrived on (grn_line_item_id). ` +
          `Every unit traces back to a GRN, and found stock is no exception — without it the lot ` +
          `genealogy would have a hole where this unit came from.`,
        400
      )
    }

    const lineRow = await db.query(
      `INSERT INTO inventory_adjustment_lines
         (company_id, adjustment_id, line_number, item_id, direction, quantity,
          grn_line_item_id, batch_number, expiry_date, bin_location, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11)
       RETURNING id`,
      [
        companyId,
        adjustment.id,
        lineNumber,
        line.item_id,
        line.direction,
        serials.length,
        line.grn_line_item_id ?? null,
        line.batch_number ?? null,
        line.expiry_date ?? null,
        line.bin_location ?? null,
        line.remarks ?? null,
      ]
    )

    for (const serial of serials) {
      // Resolved now for DECREASE so a bad serial is caught while the adjustment
      // is still a draft, rather than at approval when someone is waiting.
      const existing = await db.query(
        `SELECT id, status, do_line_item_id, transfer_line_id, adjustment_line_id,
                ${claimedByExpr("stock_serial_numbers")} AS claimed_by
           FROM stock_serial_numbers
          WHERE company_id = $1 AND serial_number = $2
          FOR UPDATE`,
        [companyId, serial]
      )
      const found = existing.rows[0]

      if (line.direction === "DECREASE") {
        if (!found) {
          throw new AdjustmentError("VALIDATION_ERROR", `Serial ${serial} is not in stock`, 400)
        }
        if (!WRITE_OFF_STATUSES.includes(String(found.status))) {
          throw new AdjustmentError(
            "VALIDATION_ERROR",
            `Serial ${serial} is ${found.status} and cannot be written off`,
            400
          )
        }
        if (found.adjustment_line_id != null) {
          throw new AdjustmentError(
            "VALIDATION_ERROR",
            `Serial ${serial} is already named on an open adjustment. Settle that one first — ` +
              `two people writing off the same unit would count the loss twice.`,
            400
          )
        }

        // The quarantine (migration 076). Raising the adjustment takes the unit
        // out of every pool that CHOOSES stock, immediately, before anyone has
        // approved anything: a pallet reported damaged must stop being pickable
        // the moment it is reported, not when the paperwork clears.
        //
        // Guarded on `adjustment_line_id IS NULL` rather than trusted from the
        // SELECT above so two operators reporting the same unit in the same
        // instant cannot both claim it. The row is already locked FOR UPDATE, so
        // the loser waits and then sees the claim.
        const claimed = await db.query(
          `UPDATE stock_serial_numbers
              SET adjustment_line_id = $3, updated_at = CURRENT_TIMESTAMP
            WHERE company_id = $1 AND id = $2 AND adjustment_line_id IS NULL
            RETURNING id`,
          [companyId, found.id, lineRow.rows[0].id]
        )
        if (!claimed.rows.length) {
          throw new AdjustmentError(
            "VALIDATION_ERROR",
            `Serial ${serial} was claimed by another adjustment a moment ago`,
            409
          )
        }

        // Not an error: a unit can be sold and damaged at the same time, and
        // refusing to record the damage would be the wrong way round. But the
        // approver has to be shown what they are about to break, so the conflict
        // travels with the adjustment from the moment it is raised.
        if (found.claimed_by) {
          warnings.push({
            serial_number: serial,
            claimed_by: String(found.claimed_by),
            message: `${serial} is held by ${String(found.claimed_by)} — approving this write-off will release it`,
          })
        }
      } else if (found) {
        throw new AdjustmentError(
          "VALIDATION_ERROR",
          `Serial ${serial} already exists — an increase cannot re-create stock the system already has`,
          400
        )
      }

      await db.query(
        `INSERT INTO inventory_adjustment_serials
           (company_id, adjustment_id, adjustment_line_id, serial_id, serial_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, adjustment.id, lineRow.rows[0].id, found?.id ?? null, serial]
      )
    }
  }

  return { adjustment, warnings }
}

/**
 * Release every quarantine an adjustment holds.
 *
 * Called on rejection and on withdrawal — the two ways an adjustment ends
 * without moving stock. Approval does not use this: it clears the claim on the
 * same UPDATE that writes the unit off, so there is never a moment where a
 * cancelled unit sits unquarantined and pickable.
 */
async function releaseQuarantine(db: Db, companyId: number, adjustmentId: number) {
  const res = await db.query(
    `UPDATE stock_serial_numbers s
        SET adjustment_line_id = NULL, updated_at = CURRENT_TIMESTAMP
      FROM inventory_adjustment_lines l
      WHERE l.company_id = $1 AND l.adjustment_id = $2
        AND s.company_id = $1 AND s.adjustment_line_id = l.id
      RETURNING s.id`,
    [companyId, adjustmentId]
  )
  return res.rowCount ?? 0
}

async function lockAdjustment(db: Db, companyId: number, adjustmentId: number) {
  const res = await db.query(
    `SELECT * FROM inventory_adjustment_header WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, adjustmentId]
  )
  if (!res.rows.length) {
    throw new AdjustmentError("NOT_FOUND", `Adjustment ${adjustmentId} not found`, 404)
  }
  return res.rows[0]
}

/**
 * Approval is the only thing that touches stock.
 *
 * A draft adjustment is a request, and it must be possible to raise one without
 * changing inventory — otherwise the approval step is decoration and every
 * mistyped serial is a stock movement. Raising quarantines the units so nobody
 * can ship them meanwhile (migration 076), but the books do not move until here.
 *
 * `acknowledgeClaims` is the other half of that. A unit reserved to a delivery
 * order or held for a transfer CAN be written off — damage does not care who
 * sold it — but doing so silently de-allocates that order, and the DO then finds
 * out at pack time with a shortage nobody can explain. So approval refuses until
 * the approver has been shown the list and confirmed it, and reports back every
 * claim it released.
 */
export async function approveAdjustment(
  db: Db,
  companyId: number,
  adjustmentId: number,
  opts: { userId?: number | null; acknowledgeClaims?: boolean } = {}
) {
  const userId = opts.userId
  const current = await lockAdjustment(db, companyId, adjustmentId)
  assertTransition(
    String(current.status) as AdjustmentStatus,
    "APPROVED",
    String(current.adjustment_number)
  )

  const claims = await listOpenClaims(db, companyId, adjustmentId)
  if (claims.length && !opts.acknowledgeClaims) {
    throw new AdjustmentError(
      "CLAIMED_STOCK",
      `This write-off would release stock promised elsewhere: ${claims
        .map((c) => `${c.serial_number} (${c.claimed_by})`)
        .join("; ")}. Approve again confirming you accept that those orders lose the stock.`
    )
  }

  const lines = await db.query(
    `SELECT * FROM inventory_adjustment_lines
      WHERE company_id = $1 AND adjustment_id = $2 ORDER BY line_number`,
    [companyId, adjustmentId]
  )

  let decreased = 0
  let increased = 0

  for (const line of lines.rows) {
    const serials = await db.query(
      `SELECT * FROM inventory_adjustment_serials
        WHERE company_id = $1 AND adjustment_line_id = $2 ORDER BY id`,
      [companyId, line.id]
    )

    for (const row of serials.rows) {
      if (line.direction === "DECREASE") {
        // Re-check under the lock: the serial may have shipped since the draft
        // was raised, and writing off stock that already left would double-count
        // the loss.
        const serial = await db.query(
          `SELECT id, status, warehouse_id, item_id, client_id FROM stock_serial_numbers
            WHERE company_id = $1 AND id = $2 FOR UPDATE`,
          [companyId, row.serial_id]
        )
        const found = serial.rows[0]
        if (!found || !WRITE_OFF_STATUSES.includes(String(found.status))) {
          throw new AdjustmentError(
            "STOCK_MOVED",
            `Serial ${row.serial_number} is no longer available to write off (${found?.status ?? "missing"})`
          )
        }
        const sinceId = await maxMovementId(db, companyId)
        await db.query(
          // Every claim goes at once, including this adjustment's own quarantine:
          // the unit is written off, so there is no state in which it is both
          // cancelled and still under question.
          `UPDATE stock_serial_numbers
              SET status = 'CANCELLED', do_line_item_id = NULL, transfer_line_id = NULL,
                  adjustment_line_id = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE company_id = $1 AND id = $2`,
          [companyId, found.id]
        )
        await stampMovement(db, {
          companyId,
          serialId: Number(found.id),
          sinceId,
          movementType: reasonToMovementType(String(current.reason_code)),
          reference: String(current.adjustment_number),
          reason: `${current.reason_code}: ${current.reason ?? "inventory adjustment"}`,
          userId,
        })
        decreased += 1
      } else {
        const sinceId = await maxMovementId(db, companyId)
        const created = await db.query(
          `INSERT INTO stock_serial_numbers
             (company_id, serial_number, item_id, client_id, warehouse_id, status,
              received_date, grn_line_item_id, batch_number, expiry_date, bin_location)
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6, $7, $8::date, $9)
           RETURNING id, warehouse_id, status`,
          [
            companyId,
            row.serial_number,
            line.item_id,
            current.client_id,
            current.warehouse_id,
            line.grn_line_item_id,
            line.batch_number,
            line.expiry_date,
            line.bin_location,
          ]
        )
        await db.query(
          `UPDATE inventory_adjustment_serials SET serial_id = $3 WHERE company_id = $1 AND id = $2`,
          [companyId, row.id, created.rows[0].id]
        )
        // The trigger logs the insert as RECEIVE — true of a normal receipt, but
        // this unit arrived through an adjustment, and a stock report that counts
        // it as goods received would overstate inbound volume (and, downstream,
        // inbound handling charges).
        await stampMovement(db, {
          companyId,
          serialId: Number(created.rows[0].id),
          sinceId,
          movementType: "FOUND",
          reference: String(current.adjustment_number),
          reason: `${current.reason_code}: ${current.reason ?? "inventory adjustment"}`,
          userId,
        })
        increased += 1
      }
    }
  }

  const res = await db.query(
    `UPDATE inventory_adjustment_header
        SET status = 'APPROVED', approved_by = $3, approved_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, adjustmentId, userId ?? null]
  )
  return { adjustment: res.rows[0], decreased, increased, releasedClaims: claims }
}

export type OpenClaim = {
  serial_number: string
  claimed_by: string
}

/**
 * Serials on this adjustment that somebody else is still holding.
 *
 * Read fresh at approval rather than trusting the warning recorded at draft
 * time: a delivery order may have allocated the unit in between, or released it,
 * and the approver must be shown the situation as it is now.
 */
export async function listOpenClaims(
  db: Db,
  companyId: number,
  adjustmentId: number
): Promise<OpenClaim[]> {
  const res = await db.query(
    `SELECT s.serial_number, ${claimedByExpr("s")} AS claimed_by
       FROM inventory_adjustment_serials ias
       JOIN inventory_adjustment_lines l
         ON l.id = ias.adjustment_line_id AND l.company_id = ias.company_id
       JOIN stock_serial_numbers s ON s.id = ias.serial_id AND s.company_id = ias.company_id
      WHERE ias.company_id = $1
        AND ias.adjustment_id = $2
        AND l.direction = 'DECREASE'
        AND (s.do_line_item_id IS NOT NULL OR s.transfer_line_id IS NOT NULL)
      ORDER BY s.serial_number`,
    [companyId, adjustmentId]
  )
  return res.rows.map((row) => ({
    serial_number: String(row.serial_number),
    claimed_by: String(row.claimed_by ?? "another order"),
  }))
}

/**
 * The approver disagreed. Nothing moved, and the quarantine has to come off.
 *
 * Releasing it is not housekeeping — a rejected adjustment that kept its hold
 * would leave stock permanently unshippable with no screen explaining why.
 */
export async function rejectAdjustment(
  db: Db,
  companyId: number,
  adjustmentId: number,
  args: { reason?: string | null; userId?: number | null }
) {
  const current = await lockAdjustment(db, companyId, adjustmentId)
  assertTransition(
    String(current.status) as AdjustmentStatus,
    "REJECTED",
    String(current.adjustment_number)
  )
  const released = await releaseQuarantine(db, companyId, adjustmentId)
  const res = await db.query(
    `UPDATE inventory_adjustment_header
        SET status = 'REJECTED', rejected_by = $3, rejected_at = CURRENT_TIMESTAMP,
            rejection_reason = $4, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, adjustmentId, args.userId ?? null, args.reason ?? null]
  )
  return { adjustment: res.rows[0], released }
}

/**
 * The raiser withdrew it.
 *
 * Distinct from rejection, and worth the extra status: "I made a mistake" and
 * "your supervisor said no" are different answers to a client asking what
 * happened to that adjustment, and the register is the place that answer comes
 * from. Withdrawing needs no approval authority — you are taking back your own
 * request — but it releases the same quarantine.
 */
export async function cancelAdjustment(
  db: Db,
  companyId: number,
  adjustmentId: number,
  args: { reason?: string | null; userId?: number | null }
) {
  const current = await lockAdjustment(db, companyId, adjustmentId)
  assertTransition(
    String(current.status) as AdjustmentStatus,
    "CANCELLED",
    String(current.adjustment_number)
  )
  const released = await releaseQuarantine(db, companyId, adjustmentId)
  const res = await db.query(
    `UPDATE inventory_adjustment_header
        SET status = 'CANCELLED', rejection_reason = COALESCE($4, rejection_reason),
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, adjustmentId, args.userId ?? null, args.reason ?? null]
  )
  return { adjustment: res.rows[0], released }
}

/**
 * Map the business reason onto the ledger's movement vocabulary.
 *
 * stock_movements already distinguishes DAMAGE, LOST and FOUND, and existing
 * reports read those. Collapsing every adjustment to ADJUSTMENT would make this
 * feature invisible to them.
 */
function reasonToMovementType(reasonCode: string) {
  switch (reasonCode) {
    case "DAMAGE":
      return "DAMAGE"
    case "LOSS":
    case "COUNT_VARIANCE":
      return "LOST"
    case "FOUND":
      return "FOUND"
    default:
      return "ADJUSTMENT"
  }
}

/**
 * Annotate the movement the database already wrote, and correct its type.
 *
 * `fn_track_serial_movements` writes a ledger row on every status change of a
 * serial, so an approval that cancels stock has already been recorded by the
 * time we get here. Inserting another would double-count the write-off. What the
 * trigger cannot know is WHY, so the app supplies the reason, the document
 * reference, and the specific movement type the reason implies — the trigger
 * only sees a status change and calls everything it does not recognise
 * ADJUSTMENT.
 */
async function stampMovement(
  db: Db,
  args: {
    companyId: number
    serialId: number
    sinceId: number
    movementType: string
    reference: string
    reason: string
    userId?: number | null
  }
) {
  await db.query(
    `UPDATE stock_movements
        SET movement_type = $4, reference_number = $5, reason = $6,
            created_by = COALESCE(created_by, $7)
      WHERE company_id = $1 AND serial_number_id = $2 AND id > $3`,
    [
      args.companyId,
      args.serialId,
      args.sinceId,
      args.movementType,
      args.reference,
      args.reason,
      args.userId ?? null,
    ]
  )
}

async function maxMovementId(db: Db, companyId: number) {
  const res = await db.query<{ id: string }>(
    `SELECT COALESCE(MAX(id), 0) AS id FROM stock_movements WHERE company_id = $1`,
    [companyId]
  )
  return Number(res.rows[0].id)
}
