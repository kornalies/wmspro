/**
 * The redacted view of a document, served to anyone who scans its QR (FR-09).
 *
 * This is intentionally NOT `buildDocument`. The verification page is public,
 * so it must disclose only enough to answer "is this piece of paper genuine and
 * still current?" — number, type, date, status, issuing warehouse. No line
 * items, no quantities, no prices, no client identity, no stock positions.
 *
 * It is also a separate, single query per type rather than a full document
 * build: an unauthenticated endpoint should not be able to trigger the eight
 * queries a delivery note costs.
 *
 * Status is read live rather than baked into the token, so a document cancelled
 * after printing reports itself cancelled to the next person who scans it. That
 * is the property that makes the QR worth printing at all.
 */

import type { DocumentDBClient } from "@/lib/documents/branding"
import type { DocumentStatus, DocumentType } from "@/lib/documents/types"
import { statusTone } from "@/lib/documents/types"

export type DocumentSummary = {
  type: DocumentType
  title: string
  documentNumber: string
  documentDate: string
  status: DocumentStatus
  warehouse: string
}

type SummarySource = {
  title: string
  table: string
  /** Column holding the human-facing document number. */
  numberColumn: string
  /** Date shown to the scanner; first non-null wins. */
  dateColumns: string[]
  /**
   * Status column, or a literal when the table has none. `gate_out` records the
   * event rather than a lifecycle — a row existing *is* the gate pass having
   * been issued — so it reports a constant.
   */
  statusColumn?: string
  literalStatus?: string
  /** invoice_header is company-scoped, not warehouse-scoped. */
  hasWarehouse?: boolean
}

/**
 * Where each type's identity lives. Several types share a subject record (a job
 * card, dispatch note and packing slip are all views of one DO), which is why
 * the title is carried here rather than derived from the table.
 */
const SOURCES: Record<DocumentType, SummarySource> = {
  "pick-list": {
    title: "Pick List",
    table: "do_wave_header",
    numberColumn: "wave_number",
    dateColumns: ["released_at", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "packing-list": {
    title: "Packing List",
    table: "do_header",
    numberColumn: "do_number",
    dateColumns: ["dispatch_date", "request_date"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "goods-issue-note": {
    title: "Goods Issue Note",
    table: "goods_issue_header",
    numberColumn: "gi_number",
    dateColumns: ["issued_at", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "goods-receipt-note": {
    title: "Goods Receipt Note",
    table: "grn_header",
    numberColumn: "grn_number",
    dateColumns: ["grn_date", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "delivery-note": {
    title: "Delivery Note",
    table: "delivery_note_header",
    numberColumn: "delivery_note_number",
    dateColumns: ["finalized_at", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "consignment-note": {
    title: "Truck Consignment Note",
    table: "outbound_loads",
    numberColumn: "load_number",
    dateColumns: ["loaded_at", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "gate-pass": {
    title: "Gate Pass",
    table: "gate_out",
    numberColumn: "gate_out_number",
    dateColumns: ["gate_out_datetime", "created_at"],
    literalStatus: "ISSUED",
    hasWarehouse: true,
  },
  "cycle-count-sheet": {
    title: "Cycle Count Sheet",
    table: "cycle_count_plans",
    numberColumn: "plan_number",
    dateColumns: ["created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "stock-transfer-note": {
    title: "Stock Transfer Note",
    table: "stock_transfer_header",
    numberColumn: "transfer_number",
    // Dispatch date first: for a note travelling with the stock, the date that
    // matters to whoever scans it is when the goods left.
    dateColumns: ["dispatched_at", "transfer_date", "created_at"],
    statusColumn: "status",
    hasWarehouse: false,
  },
  "inventory-adjustment-report": {
    title: "Inventory Adjustment Report",
    table: "inventory_adjustment_header",
    numberColumn: "adjustment_number",
    dateColumns: ["approved_at", "adjustment_date", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "dispatch-manifest": {
    title: "Dispatch Manifest",
    table: "outbound_loads",
    numberColumn: "load_number",
    dateColumns: ["loaded_at", "created_at"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "commercial-invoice": {
    title: "Commercial Invoice",
    table: "invoice_header",
    numberColumn: "invoice_number",
    dateColumns: ["invoice_date", "created_at"],
    statusColumn: "status",
    hasWarehouse: false,
  },
  "job-card": {
    title: "Job Card",
    table: "do_header",
    numberColumn: "do_number",
    dateColumns: ["dispatch_date", "request_date"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "dispatch-note": {
    title: "Dispatch Note",
    table: "do_header",
    numberColumn: "do_number",
    dateColumns: ["dispatch_date", "request_date"],
    statusColumn: "status",
    hasWarehouse: true,
  },
  "packing-slip": {
    title: "Packing Slip",
    table: "do_header",
    numberColumn: "do_number",
    dateColumns: ["dispatch_date", "request_date"],
    statusColumn: "status",
    hasWarehouse: true,
  },
}

function fmtDate(value: unknown): string {
  if (!value) return "-"
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return "-"
  return date.toISOString().slice(0, 10)
}

/**
 * Returns null when the record does not exist or does not belong to the token's
 * company. The caller renders the same "could not be verified" page either way —
 * distinguishing "no such document" from "wrong tenant" would leak whether a
 * given id exists.
 */
export async function loadDocumentSummary(
  db: DocumentDBClient,
  type: DocumentType,
  id: number,
  companyId: number
): Promise<DocumentSummary | null> {
  const source = SOURCES[type]
  if (!source) return null

  // Identifiers come from the SOURCES table above, never from the request —
  // the only request-derived values are bound as parameters.
  const dateExpr = source.dateColumns.length
    ? `COALESCE(${source.dateColumns.map((c) => `t.${c}::text`).join(", ")})`
    : "NULL"
  const statusExpr = source.statusColumn
    ? `t.${source.statusColumn}`
    : `'${(source.literalStatus || "ISSUED").replace(/'/g, "")}'`
  const warehouseSelect = source.hasWarehouse
    ? "w.warehouse_name, w.warehouse_code"
    : "NULL AS warehouse_name, NULL AS warehouse_code"
  const warehouseJoin = source.hasWarehouse
    ? "LEFT JOIN warehouses w ON w.id = t.warehouse_id AND w.company_id = t.company_id"
    : ""

  const result = await db.query(
    `SELECT t.${source.numberColumn} AS document_number,
            ${statusExpr} AS status,
            ${dateExpr} AS document_date,
            ${warehouseSelect}
       FROM ${source.table} t
       ${warehouseJoin}
      WHERE t.company_id = $1 AND t.id = $2
      LIMIT 1`,
    [companyId, id]
  )

  const row = result.rows[0]
  if (!row) return null

  const warehouse = [row.warehouse_code, row.warehouse_name]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" · ")

  return {
    type,
    title: source.title,
    documentNumber: String(row.document_number ?? "").trim() || "-",
    documentDate: fmtDate(row.document_date),
    status: statusTone(row.status),
    warehouse: warehouse || "-",
  }
}
