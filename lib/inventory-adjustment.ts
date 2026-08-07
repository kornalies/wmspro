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
 */

import type { QueryResult, QueryResultRow } from "pg"

type Db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>
}

export type AdjustmentStatus = "DRAFT" | "APPROVED" | "REJECTED" | "CANCELLED"
export type AdjustmentDirection = "INCREASE" | "DECREASE"

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
const WRITE_OFF_STATUSES = ["IN_STOCK", "RESERVED", "IN_TRANSIT"]

export class AdjustmentError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
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
) {
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
        `SELECT id, status FROM stock_serial_numbers
          WHERE company_id = $1 AND serial_number = $2`,
        [companyId, serial]
      )
      if (line.direction === "DECREASE") {
        if (!existing.rows.length) {
          throw new AdjustmentError("VALIDATION_ERROR", `Serial ${serial} is not in stock`, 400)
        }
        if (!WRITE_OFF_STATUSES.includes(String(existing.rows[0].status))) {
          throw new AdjustmentError(
            "VALIDATION_ERROR",
            `Serial ${serial} is ${existing.rows[0].status} and cannot be written off`,
            400
          )
        }
      } else if (existing.rows.length) {
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
        [companyId, adjustment.id, lineRow.rows[0].id, existing.rows[0]?.id ?? null, serial]
      )
    }
  }

  return adjustment
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
 * mistyped serial is a stock movement.
 */
export async function approveAdjustment(
  db: Db,
  companyId: number,
  adjustmentId: number,
  userId?: number | null
) {
  const current = await lockAdjustment(db, companyId, adjustmentId)
  if (current.status !== "DRAFT") {
    throw new AdjustmentError(
      "WORKFLOW_BLOCKED",
      `Adjustment ${current.adjustment_number} is ${current.status} and cannot be approved again`
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
          `UPDATE stock_serial_numbers
              SET status = 'CANCELLED', do_line_item_id = NULL, transfer_line_id = NULL,
                  updated_at = CURRENT_TIMESTAMP
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
  return { adjustment: res.rows[0], decreased, increased }
}

export async function rejectAdjustment(
  db: Db,
  companyId: number,
  adjustmentId: number,
  args: { reason?: string | null; userId?: number | null }
) {
  const current = await lockAdjustment(db, companyId, adjustmentId)
  if (current.status !== "DRAFT") {
    throw new AdjustmentError(
      "WORKFLOW_BLOCKED",
      `Adjustment ${current.adjustment_number} is ${current.status} and cannot be rejected`
    )
  }
  const res = await db.query(
    `UPDATE inventory_adjustment_header
        SET status = 'REJECTED', rejected_by = $3, rejected_at = CURRENT_TIMESTAMP,
            rejection_reason = $4, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, adjustmentId, args.userId ?? null, args.reason ?? null]
  )
  return res.rows[0]
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
