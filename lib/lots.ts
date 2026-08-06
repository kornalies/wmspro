/**
 * Lot master, genealogy and recall impact.
 *
 * A lot here is (client, item, batch_number). Everything about it except its
 * hold status is DERIVED from stock_serial_numbers rather than stored: the
 * serials are the record of what was received, where it sits and where it went,
 * and a second copy of that would drift from them. Drift in a lot master only
 * shows up during a recall, which is the one moment it must not.
 *
 * The three questions this answers are different questions, and the recall one
 * is the reason the other two exist:
 *
 *   Lot master  — what lots do I have, in what state.
 *   Genealogy   — for one lot or one serial: where did it come from, where did
 *                 it go.
 *   Recall      — for one lot: what is still in my building (I can quarantine
 *                 it) versus what has already shipped and to whom (I have to
 *                 call them). Those two halves need different actions, so they
 *                 are returned separately rather than as one list.
 */

import type { QueryResult, QueryResultRow } from "pg"

type Db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ) => Promise<QueryResult<R>>
}

export type BatchStatus = "ACTIVE" | "ON_HOLD" | "RECALLED"

export const BATCH_STATUSES: BatchStatus[] = ["ACTIVE", "ON_HOLD", "RECALLED"]

export function normalizeBatchStatus(value: unknown): BatchStatus | null {
  const raw = String(value ?? "").trim().toUpperCase()
  return (BATCH_STATUSES as string[]).includes(raw) ? (raw as BatchStatus) : null
}

/**
 * Stock states that count as "still recoverable by us".
 *
 * DISPATCHED stock has left and is the recall's outbound half; CANCELLED stock
 * was written off and is neither. IN_TRANSIT stock is on a truck between our own
 * warehouses (migration 070) — still ours, still stoppable, so it belongs here
 * rather than in the shipped half.
 *
 * Keeping this in one constant stops the on-hand figure in the lot list
 * disagreeing with the on-hand figure in the recall report.
 */
const ON_HAND_STATUSES = "('IN_STOCK', 'RESERVED', 'IN_TRANSIT')"

/**
 * A lot master row. The index signature is honest: the query returns more
 * columns than any one caller reads, and naming only the ones with behaviour
 * attached keeps the shape from going stale every time a column is added.
 */
export type LotRow = {
  [column: string]: unknown
  client_id: number
  item_id: number
  batch_number: string
  on_hand_units: number
  dispatched_units: number
  batch_status: BatchStatus
  disposition: string
}

export type LotFilters = {
  clientId?: number | null
  itemId?: number | null
  batch?: string | null
  status?: BatchStatus | null
  warehouseId?: number | null
  /** Only lots expiring within this many days (or already expired). */
  expiringInDays?: number | null
  limit?: number
}

/**
 * The lot master list.
 *
 * Quantities are split by disposition in one pass rather than returned as a
 * single total: "500 units of LOT-7" is useless during a recall if 300 of them
 * shipped last week.
 */
export async function listLots(
  db: Db,
  companyId: number,
  filters: LotFilters = {}
): Promise<LotRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000)

  const res = await db.query(
    `SELECT
       s.client_id,
       c.client_name,
       s.item_id,
       i.item_code,
       i.item_name,
       i.is_batch_tracked,
       i.is_expiry_tracked,
       i.min_shelf_life_days,
       s.batch_number,
       MIN(s.manufacturing_date) AS manufacturing_date,
       MIN(s.expiry_date) AS expiry_date,
       MIN(s.received_date) AS first_received,
       MAX(s.received_date) AS last_received,
       COUNT(*)::int AS total_units,
       COUNT(*) FILTER (WHERE s.status IN ${ON_HAND_STATUSES})::int AS on_hand_units,
       COUNT(*) FILTER (WHERE s.status = 'DISPATCHED')::int AS dispatched_units,
       COUNT(*) FILTER (WHERE s.status = 'CANCELLED')::int AS cancelled_units,
       COUNT(DISTINCT s.warehouse_id) FILTER (WHERE s.status IN ${ON_HAND_STATUSES})::int AS warehouse_count,
       COALESCE(bs.status, 'ACTIVE') AS batch_status,
       bs.reason AS batch_status_reason,
       bs.reference_no AS batch_status_reference,
       bs.raised_at AS batch_status_raised_at,
       CASE
         WHEN MIN(s.expiry_date) IS NULL THEN NULL
         ELSE (MIN(s.expiry_date) - CURRENT_DATE)
       END AS days_to_expiry
     FROM stock_serial_numbers s
     JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
     LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
     LEFT JOIN stock_batch_status bs
       ON bs.company_id = s.company_id
      AND bs.client_id = s.client_id
      AND bs.item_id = s.item_id
      AND bs.batch_number = s.batch_number
     WHERE s.company_id = $1
       AND s.batch_number IS NOT NULL
       AND ($2::int IS NULL OR s.client_id = $2)
       AND ($3::int IS NULL OR s.item_id = $3)
       AND ($4::text IS NULL OR s.batch_number ILIKE '%' || $4 || '%')
       AND ($5::int IS NULL OR s.warehouse_id = $5)
     GROUP BY s.client_id, c.client_name, s.item_id, i.item_code, i.item_name,
              i.is_batch_tracked, i.is_expiry_tracked, i.min_shelf_life_days,
              s.batch_number, bs.status, bs.reason, bs.reference_no, bs.raised_at
     HAVING ($6::text IS NULL OR COALESCE(bs.status, 'ACTIVE') = $6)
        AND ($7::int IS NULL OR MIN(s.expiry_date) <= CURRENT_DATE + ($7 || ' days')::interval)
     ORDER BY MIN(s.expiry_date) ASC NULLS LAST, s.batch_number ASC
     LIMIT $8`,
    [
      companyId,
      filters.clientId ?? null,
      filters.itemId ?? null,
      filters.batch ?? null,
      filters.warehouseId ?? null,
      filters.status ?? null,
      filters.expiringInDays ?? null,
      limit,
    ]
  )

  return res.rows.map((row) => ({
    ...row,
    client_id: Number(row.client_id),
    item_id: Number(row.item_id),
    batch_number: String(row.batch_number),
    on_hand_units: Number(row.on_hand_units ?? 0),
    dispatched_units: Number(row.dispatched_units ?? 0),
    batch_status: (normalizeBatchStatus(row.batch_status) ?? "ACTIVE") as BatchStatus,
    // Derived here rather than in SQL so the list and the recall report cannot
    // describe the same lot differently.
    disposition: describeLotDisposition(row),
  }))
}

function describeLotDisposition(row: QueryResultRow) {
  const status = String(row.batch_status ?? "ACTIVE")
  if (status === "RECALLED") return "Recalled — blocked from allocation"
  if (status === "ON_HOLD") return "On hold — blocked from allocation"
  const days = row.days_to_expiry === null ? null : Number(row.days_to_expiry)
  if (days !== null && days < 0) return "Expired — not allocatable"
  const minShelf = row.min_shelf_life_days === null ? null : Number(row.min_shelf_life_days)
  if (days !== null && minShelf !== null && days < minShelf) {
    return `Inside the ${minShelf}-day minimum shelf life — not allocatable`
  }
  if (Number(row.on_hand_units ?? 0) === 0) return "Fully dispatched"
  return "Allocatable"
}

export type LotKey = { clientId: number; itemId: number; batch: string }

/**
 * Genealogy for one lot: everything upstream and everything downstream.
 *
 * Upstream is the GRN (and through it the supplier and gate-in); downstream is
 * the DO. Both are aggregated per document rather than per serial, because a
 * 500-unit lot received on one GRN should read as one inbound row, not 500.
 */
export async function traceLot(db: Db, companyId: number, key: LotKey) {
  const params = [companyId, key.clientId, key.itemId, key.batch]

  const inbound = await db.query(
    `SELECT g.id AS grn_id,
            g.grn_number,
            g.grn_date,
            g.supplier_name,
            g.invoice_number,
            g.gate_in_number,
            w.warehouse_name,
            COUNT(s.id)::int AS units,
            MIN(s.received_date) AS received_date
       FROM stock_serial_numbers s
       JOIN grn_line_items gl ON gl.id = s.grn_line_item_id AND gl.company_id = s.company_id
       JOIN grn_header g ON g.id = gl.grn_header_id AND g.company_id = s.company_id
       LEFT JOIN warehouses w ON w.id = g.warehouse_id AND w.company_id = g.company_id
      WHERE s.company_id = $1 AND s.client_id = $2 AND s.item_id = $3 AND s.batch_number = $4
      GROUP BY g.id, g.grn_number, g.grn_date, g.supplier_name, g.invoice_number,
               g.gate_in_number, w.warehouse_name
      ORDER BY g.grn_date ASC, g.id ASC`,
    params
  )

  const outbound = await db.query(
    `SELECT d.id AS do_id,
            d.do_number,
            d.status,
            d.dispatch_date,
            d.expected_dispatch_date,
            d.requested_by,
            d.invoice_no,
            w.warehouse_name,
            COUNT(s.id)::int AS units,
            COUNT(*) FILTER (WHERE s.status = 'DISPATCHED')::int AS dispatched_units
       FROM stock_serial_numbers s
       JOIN do_line_items dl ON dl.id = s.do_line_item_id AND dl.company_id = s.company_id
       JOIN do_header d ON d.id = dl.do_header_id AND d.company_id = s.company_id
       LEFT JOIN warehouses w ON w.id = d.warehouse_id AND w.company_id = d.company_id
      WHERE s.company_id = $1 AND s.client_id = $2 AND s.item_id = $3 AND s.batch_number = $4
      GROUP BY d.id, d.do_number, d.status, d.dispatch_date, d.expected_dispatch_date,
               d.requested_by, d.invoice_no, w.warehouse_name
      ORDER BY d.dispatch_date DESC NULLS LAST, d.id DESC`,
    params
  )

  const locations = await db.query(
    `SELECT w.warehouse_name,
            s.bin_location,
            s.physical_location,
            s.status,
            COUNT(*)::int AS units
       FROM stock_serial_numbers s
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
      WHERE s.company_id = $1 AND s.client_id = $2 AND s.item_id = $3 AND s.batch_number = $4
        AND s.status IN ${ON_HAND_STATUSES}
      GROUP BY w.warehouse_name, s.bin_location, s.physical_location, s.status
      ORDER BY w.warehouse_name ASC, s.bin_location ASC`,
    params
  )

  return { inbound: inbound.rows, outbound: outbound.rows, locations: locations.rows }
}

/**
 * Genealogy for a single serial: its lot, its GRN, its DO, and every movement
 * recorded against it.
 *
 * This is the view an auditor asks for -- "show me the history of this exact
 * unit" -- and it is the only one that reads stock_movements, because per-serial
 * is the only granularity at which that table is worth showing.
 */
export async function traceSerial(db: Db, companyId: number, serial: string) {
  const head = await db.query(
    `SELECT s.id,
            s.serial_number,
            s.status,
            s.batch_number,
            s.manufacturing_date,
            s.expiry_date,
            s.received_date,
            s.dispatched_date,
            s.bin_location,
            s.client_id,
            s.item_id,
            i.item_code,
            i.item_name,
            c.client_name,
            w.warehouse_name,
            g.grn_number,
            g.grn_date,
            g.supplier_name,
            d.do_number,
            d.dispatch_date,
            COALESCE(bs.status, 'ACTIVE') AS batch_status
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
       LEFT JOIN grn_line_items gl ON gl.id = s.grn_line_item_id AND gl.company_id = s.company_id
       LEFT JOIN grn_header g ON g.id = gl.grn_header_id AND g.company_id = s.company_id
       LEFT JOIN do_line_items dl ON dl.id = s.do_line_item_id AND dl.company_id = s.company_id
       LEFT JOIN do_header d ON d.id = dl.do_header_id AND d.company_id = s.company_id
       LEFT JOIN stock_batch_status bs
         ON bs.company_id = s.company_id
        AND bs.client_id = s.client_id
        AND bs.item_id = s.item_id
        AND bs.batch_number = s.batch_number
      WHERE s.company_id = $1 AND s.serial_number = $2
      LIMIT 1`,
    [companyId, serial]
  )

  if (!head.rows.length) return null

  const movements = await db.query(
    `SELECT m.movement_number,
            m.movement_date,
            m.movement_type,
            m.from_status,
            m.to_status,
            m.reference_number,
            m.reason,
            m.is_reversed,
            fw.warehouse_name AS from_warehouse,
            tw.warehouse_name AS to_warehouse
       FROM stock_movements m
       LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id AND fw.company_id = m.company_id
       LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id AND tw.company_id = m.company_id
      WHERE m.company_id = $1 AND m.serial_number_id = $2
      ORDER BY m.movement_date ASC, m.id ASC`,
    [companyId, head.rows[0].id]
  )

  return { serial: head.rows[0], movements: movements.rows }
}

/**
 * Recall impact for one lot.
 *
 * Deliberately split into what can still be stopped and what cannot. The
 * outbound half carries enough to actually make the calls -- DO number, dispatch
 * date, who requested it -- because a recall report that only counts units
 * leaves the operator to go and look all of that up under time pressure.
 */
export async function recallImpact(db: Db, companyId: number, key: LotKey) {
  const trace = await traceLot(db, companyId, key)

  const totals = await db.query(
    `SELECT COUNT(*)::int AS total_units,
            COUNT(*) FILTER (WHERE s.status IN ${ON_HAND_STATUSES})::int AS on_hand_units,
            COUNT(*) FILTER (WHERE s.status = 'DISPATCHED')::int AS dispatched_units,
            COUNT(*) FILTER (WHERE s.status = 'CANCELLED')::int AS cancelled_units,
            MIN(s.expiry_date) AS expiry_date,
            MIN(s.manufacturing_date) AS manufacturing_date
       FROM stock_serial_numbers s
      WHERE s.company_id = $1 AND s.client_id = $2 AND s.item_id = $3 AND s.batch_number = $4`,
    [companyId, key.clientId, key.itemId, key.batch]
  )

  const status = await db.query(
    `SELECT status, reason, reference_no, raised_at, released_at
       FROM stock_batch_status
      WHERE company_id = $1 AND client_id = $2 AND item_id = $3 AND batch_number = $4`,
    [companyId, key.clientId, key.itemId, key.batch]
  )

  const summary = totals.rows[0] ?? {}
  return {
    lot: key,
    batch_status: status.rows[0]?.status ?? "ACTIVE",
    batch_status_detail: status.rows[0] ?? null,
    totals: summary,
    // Recoverable: still in the building, so a hold actually stops it.
    on_hand: trace.locations,
    // Not recoverable by us -- these need a phone call.
    shipped: trace.outbound.filter((row) => Number(row.dispatched_units ?? 0) > 0),
    received_on: trace.inbound,
  }
}

/**
 * Place or lift a hold on a lot.
 *
 * Upsert rather than insert: a lot's status is a single current fact, and a
 * second row for the same lot would let allocation see ACTIVE and RECALLED at
 * once and pick whichever the planner joined first.
 */
export async function setBatchStatus(
  db: Db,
  companyId: number,
  key: LotKey,
  args: { status: BatchStatus; reason?: string | null; referenceNo?: string | null; userId?: number | null }
) {
  const releasing = args.status === "ACTIVE"
  const res = await db.query(
    `INSERT INTO stock_batch_status
       (company_id, client_id, item_id, batch_number, status, reason, reference_no,
        raised_by, raised_at, released_by, released_at)
     -- Every use of $8 is cast: without it Postgres sees the same parameter in an
     -- integer column and inside a CASE arm beside NULL, and refuses to deduce a
     -- type ("inconsistent types deduced for parameter $8").
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::int, CURRENT_TIMESTAMP,
             CASE WHEN $9::boolean THEN $8::int ELSE NULL END,
             CASE WHEN $9::boolean THEN CURRENT_TIMESTAMP ELSE NULL END)
     ON CONFLICT (company_id, client_id, item_id, batch_number) DO UPDATE
       SET status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           reference_no = EXCLUDED.reference_no,
           -- raised_* only move when a hold is being applied, so lifting a hold
           -- does not erase who imposed it.
           raised_by = CASE WHEN $9::boolean THEN stock_batch_status.raised_by ELSE EXCLUDED.raised_by END,
           raised_at = CASE WHEN $9::boolean THEN stock_batch_status.raised_at ELSE EXCLUDED.raised_at END,
           released_by = CASE WHEN $9::boolean THEN EXCLUDED.raised_by ELSE NULL END,
           released_at = CASE WHEN $9::boolean THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      companyId,
      key.clientId,
      key.itemId,
      key.batch,
      args.status,
      args.reason ?? null,
      args.referenceNo ?? null,
      args.userId ?? null,
      releasing,
    ]
  )
  return res.rows[0]
}
