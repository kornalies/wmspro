/**
 * Cycle counting: planning, and turning an approved variance into a stock fact.
 *
 * The count model is quantity-based (bin + sku + counted_qty) because that is
 * what a counter on a warehouse floor produces, but WMS stock is serial-based.
 * Reconciling the two is the whole job of this module, and it is asymmetric:
 *
 *   SHORTAGE (counted < expected)  -> the missing units are written off. Which
 *     serials went missing is unknowable from a quantity count, so the oldest
 *     serials in that bin are taken first. That matches how the rest of the
 *     system consumes stock (FIFO) and keeps the write-off deterministic and
 *     replayable rather than arbitrary.
 *
 *   OVERAGE  (counted > expected)  -> NOTHING is written to stock. WMS cannot
 *     invent a serial number, and a fabricated one would be indistinguishable
 *     from a received one forever after. The approval is recorded, the variance
 *     is closed, and the extra units have to arrive through a receipt like any
 *     other stock. This is a deliberate refusal, not an omission.
 *
 * A shortage is applied by raising and immediately approving an inventory
 * adjustment (source_module CYCLE_COUNT), not by cancelling serials here. Two
 * reasons. The register that answers "why did my stock figure move" could not
 * see count variance at all, which is the single largest source of such moves.
 * And this module used to INSERT its own stock_movements row on top of the one
 * fn_track_serial_movements already wrote for the same status change, so every
 * count-driven write-off appeared in the ledger twice — the trigger is the
 * ledger's only writer, and lib/inventory-adjustment.ts stamps the row it wrote
 * rather than adding another.
 */

import { approveAdjustment, createAdjustment } from "@/lib/inventory-adjustment"

export type CycleCountDBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export class CycleCountError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
    this.name = "CycleCountError"
  }
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * On-hand quantity for a bin/sku, derived from serials rather than stored.
 *
 * There is no quantity column to trust — the serial rows ARE the stock — so a
 * blind count's expected figure is computed at plan time and a non-blind task
 * shows it to the counter.
 */
export async function expectedQtyForBin(
  db: CycleCountDBClient,
  args: { companyId: number; warehouseId: number; binLocation: string; itemCode: string }
): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM stock_serial_numbers s
     JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
     WHERE s.company_id = $1
       AND s.warehouse_id = $2
       AND s.bin_location = $3
       AND i.item_code = $4
       AND s.status IN ('IN_STOCK', 'RESERVED')`,
    [args.companyId, args.warehouseId, args.binLocation, args.itemCode]
  )
  return num(result.rows[0]?.n)
}

export async function nextPlanNumber(db: CycleCountDBClient): Promise<string> {
  const result = await db.query(`SELECT nextval('public.cycle_count_plan_number_seq') AS seq`)
  const seq = String(result.rows[0]?.seq ?? "0")
  return `CC-${new Date().getUTCFullYear()}-${seq.padStart(6, "0")}`
}

export type PlannedTask = {
  binLocation: string
  itemCode: string
  expectedQty: number
  clientId: number
}

/**
 * Choose what to count.
 *
 * ZONE   — every occupied bin whose location sits under a zone code.
 * ABC    — the SKUs with the most movement first, which is the standard
 *          inventory-accuracy approach: count what turns over, not what sits.
 * MANUAL — an explicit bin list supplied by the planner.
 *
 * Only occupied bin/sku pairs are returned. Counting a bin the system already
 * believes is empty proves nothing about accuracy and wastes a counter's walk.
 */
export async function selectTasksForPlan(
  db: CycleCountDBClient,
  args: {
    companyId: number
    warehouseId: number
    clientId?: number | null
    strategy: "ZONE" | "ABC" | "MANUAL"
    zoneCode?: string | null
    binLocations?: string[]
    limit: number
  }
): Promise<PlannedTask[]> {
  const params: unknown[] = [args.companyId, args.warehouseId]
  let filter = ""

  if (args.strategy === "ZONE") {
    if (!args.zoneCode) {
      throw new CycleCountError("VALIDATION_ERROR", "zone_code is required for a ZONE plan", 400)
    }
    params.push(`${args.zoneCode}/%`)
    filter = `AND s.bin_location LIKE $${params.length}`
  } else if (args.strategy === "MANUAL") {
    if (!args.binLocations?.length) {
      throw new CycleCountError("VALIDATION_ERROR", "bin_locations is required for a MANUAL plan", 400)
    }
    params.push(args.binLocations)
    filter = `AND s.bin_location = ANY($${params.length}::text[])`
  }

  if (args.clientId) {
    params.push(args.clientId)
    filter += ` AND s.client_id = $${params.length}`
  }

  // ABC ranks by outbound movement over the trailing quarter; the other
  // strategies walk the bins in location order so a counter's route is sane.
  const ordering =
    args.strategy === "ABC"
      ? `ORDER BY COALESCE(mv.moves, 0) DESC, s.bin_location ASC`
      : `ORDER BY s.bin_location ASC, i.item_code ASC`

  params.push(args.limit)

  const result = await db.query(
    `SELECT s.bin_location,
            i.item_code,
            MIN(s.client_id)::int AS client_id,
            COUNT(*)::int AS expected_qty
     FROM stock_serial_numbers s
     JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
     LEFT JOIN (
       SELECT item_id, COUNT(*)::int AS moves
       FROM stock_movements
       WHERE company_id = $1
         AND movement_date >= CURRENT_DATE - INTERVAL '90 days'
       GROUP BY item_id
     ) mv ON mv.item_id = s.item_id
     WHERE s.company_id = $1
       AND s.warehouse_id = $2
       AND s.bin_location IS NOT NULL
       AND s.status IN ('IN_STOCK', 'RESERVED')
       ${filter}
     GROUP BY s.bin_location, i.item_code, mv.moves
     ${ordering}
     LIMIT $${params.length}`,
    params
  )

  return result.rows.map((row) => ({
    binLocation: String(row.bin_location),
    itemCode: String(row.item_code),
    expectedQty: num(row.expected_qty),
    clientId: num(row.client_id),
  }))
}

export type VarianceOutcome = {
  decision: "APPROVED" | "REJECTED"
  discrepancy: number
  adjustedSerialCount: number
  /** Set when an approval could not be fully applied, for the caller to surface. */
  note?: string
}

/**
 * Apply an approved variance to stock.
 *
 * Caller owns the transaction. Returns what was actually applied, which is not
 * always what was asked for — see the module comment on overages.
 */
export async function applyVariance(
  db: CycleCountDBClient,
  args: {
    companyId: number
    submissionId: string
    decision: "APPROVED" | "REJECTED"
    userId: number
    remarks?: string | null
  }
): Promise<VarianceOutcome> {
  const subRes = await db.query(
    `SELECT id, company_id, warehouse_id, client_id, bin_id, sku,
            expected_qty, counted_qty, discrepancy, approval_status, requires_approval
     FROM mobile_cycle_count_submissions
     WHERE company_id = $1 AND id = $2::uuid
     FOR UPDATE`,
    [args.companyId, args.submissionId]
  )
  if (!subRes.rows.length) {
    throw new CycleCountError("NOT_FOUND", "Cycle count submission not found", 404)
  }
  const sub = subRes.rows[0]

  const currentStatus = String(sub.approval_status ?? "")
  if (currentStatus !== "PENDING") {
    throw new CycleCountError(
      "WORKFLOW_BLOCKED",
      `Submission is ${currentStatus || "in an unknown state"} and is no longer awaiting a decision.`
    )
  }

  // discrepancy is written by the mobile client. Recomputing it here means a bad
  // or stale client value cannot drive a stock write-off.
  const expected = num(sub.expected_qty)
  const counted = num(sub.counted_qty)
  const discrepancy = counted - expected

  let adjustedSerialCount = 0
  let note: string | undefined

  if (args.decision === "APPROVED" && discrepancy < 0) {
    const shortfall = Math.abs(discrepancy)
    // Oldest first: deterministic, and consistent with how stock is consumed.
    // Units already quarantined by an open adjustment are skipped — somebody has
    // a write-off in flight for them and taking them here would count the same
    // loss twice.
    const serials = await db.query(
      `SELECT s.id, s.serial_number, s.item_id, s.client_id, s.warehouse_id, s.zone_id
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       WHERE s.company_id = $1
         AND s.warehouse_id = $2
         AND s.bin_location = $3
         AND i.item_code = $4
         AND s.status IN ('IN_STOCK', 'RESERVED')
         AND s.adjustment_line_id IS NULL
       ORDER BY s.received_date ASC NULLS LAST, s.id ASC
       LIMIT $5
       FOR UPDATE`,
      [args.companyId, num(sub.warehouse_id), String(sub.bin_id), String(sub.sku), shortfall]
    )

    if (serials.rows.length) {
      // The shapes differ only in generics — both are a live pg client — and
      // widening one of the two public DB types to satisfy the other would be a
      // bigger change than the cast it saves.
      const adjDb = db as unknown as Parameters<typeof createAdjustment>[0]
      const ref = `CC-${String(sub.id).slice(0, 8)}`

      const { adjustment } = await createAdjustment(adjDb, args.companyId, {
        clientId: num(serials.rows[0].client_id) || num(sub.client_id),
        warehouseId: num(sub.warehouse_id),
        reasonCode: "COUNT_VARIANCE",
        reason: `Cycle count shortage in ${String(sub.bin_id)}: expected ${expected}, counted ${counted}`,
        referenceNo: ref,
        sourceModule: "CYCLE_COUNT",
        sourceRef: String(sub.id),
        lines: [
          {
            item_id: num(serials.rows[0].item_id),
            direction: "DECREASE" as const,
            serials: serials.rows.map((s) => String(s.serial_number)),
            remarks: `bin=${String(sub.bin_id)} sku=${String(sub.sku)}`,
          },
        ],
        userId: args.userId,
      })

      // Approved in the same breath, deliberately. The supervisor deciding this
      // submission IS the approval — routing count variance into a second queue
      // would stall counts behind paperwork and change a workflow nobody asked to
      // change. What the adjustment adds is the record: until now a count-driven
      // write-off existed only as a movement row, so the register that answers
      // "why did my stock figure move" could not see the single largest source of
      // such moves. acknowledgeClaims is true because the stock is physically
      // missing — refusing to write it off would not bring it back for the
      // delivery order holding it.
      const approved = await approveAdjustment(adjDb, args.companyId, Number(adjustment.id), {
        userId: args.userId,
        acknowledgeClaims: true,
      })
      adjustedSerialCount = approved.decreased
      if (approved.releasedClaims.length) {
        note = `${approved.releasedClaims.length} of the missing units were promised to ${[
          ...new Set(approved.releasedClaims.map((c) => c.claimed_by)),
        ].join(", ")}; those orders are now short. Adjustment ${adjustment.adjustment_number}.`
      }
    }

    if (adjustedSerialCount < shortfall) {
      // The bin held fewer serials than the count said were missing, so stock had
      // already moved on. Applying what exists is right; silently reporting a
      // clean write-off would not be.
      note = `Wrote off ${adjustedSerialCount} of ${shortfall} missing units — the bin no longer holds enough matching serials. Recount before closing the plan.`
    }
  }

  if (args.decision === "APPROVED" && discrepancy > 0) {
    note = `Overage of ${discrepancy} recorded but NOT added to stock: WMS cannot create a serial number that was never received. Raise a receipt for the extra units.`
  }

  await db.query(
    `UPDATE mobile_cycle_count_submissions
     SET approval_status = $1,
         approved_by = $2,
         approved_at = CURRENT_TIMESTAMP,
         approval_remarks = $3,
         adjusted_serial_count = $4,
         discrepancy = $5
     WHERE company_id = $6 AND id = $7::uuid`,
    [
      args.decision,
      args.userId,
      args.remarks ?? null,
      adjustedSerialCount,
      discrepancy,
      args.companyId,
      args.submissionId,
    ]
  )

  // Close the originating task so a decided count stops appearing as outstanding
  // work on the handheld. task_id is text holding a uuid, hence the cast.
  await db.query(
    `UPDATE mobile_cycle_count_tasks
     SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
     WHERE company_id = $1
       AND id::text = (
         SELECT task_id FROM mobile_cycle_count_submissions
         WHERE company_id = $1 AND id = $2::uuid
       )`,
    [args.companyId, args.submissionId]
  )

  return { decision: args.decision, discrepancy, adjustedSerialCount, note }
}