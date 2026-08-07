/**
 * One builder per document type. A builder owns its own SQL and returns a
 * finished DocumentModel plus the warehouse/client it belongs to, so the route
 * can apply the same policy scoping the rest of the app uses without knowing
 * anything about the document itself.
 *
 * The `id` in /documents/[type]/[id] means different things per type, because
 * these documents genuinely hang off different records: a pick list belongs to
 * a wave, a consignment note to a load, a delivery note to itself. Each builder
 * documents what it expects.
 */

import { loadBranding, type DocumentDBClient } from "@/lib/documents/branding"
import { buildDocumentQr } from "@/lib/documents/verify"
import { statusTone } from "@/lib/documents/types"
import type {
  DocumentColumn,
  DocumentField,
  DocumentModel,
  DocumentSection,
  DocumentType,
} from "@/lib/documents/types"

export class DocumentNotFoundError extends Error {
  constructor(message = "Document not found") {
    super(message)
    this.name = "DocumentNotFoundError"
  }
}

export type DocumentResult = {
  model: DocumentModel
  /**
   * The warehouse and client the document belongs to, which the route enforces
   * scope against. `null` means the document is not constrained on that
   * dimension — an invoice is company- and client-scoped but belongs to no
   * single warehouse. It must be null and not 0: requireScope only short-circuits
   * on null, so a 0 would be compared against the allowed list and denied for
   * every warehouse-scoped user.
   */
  scope: { warehouseId: number | null; clientId: number | null }
}

type Row = Record<string, unknown>

function str(value: unknown, fallback = "-"): string {
  const out = value === null || value === undefined ? "" : String(value)
  return out.trim() === "" ? fallback : out
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function fmtDate(value: unknown): string {
  if (!value) return "-"
  const raw = value instanceof Date ? value.toISOString() : String(value)
  return raw.slice(0, 10)
}

function fmtDateTime(value: unknown): string {
  if (!value) return "-"
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

function signatures(...roles: string[]): DocumentSection {
  return { kind: "signatures", blocks: roles.map((role) => ({ role })) }
}

/**
 * Condenses a list of serials into a printable range (FR-05).
 *
 * A GRN line can carry hundreds of serials; the pre-EDDS print page joined them
 * with commas, which reflowed into a wall of text and pushed the table onto
 * extra pages. Contiguous numeric runs collapse to "4471–4530". Non-numeric or
 * non-contiguous serials fall back to listing the first few with a count, so the
 * reader still gets something checkable rather than a truncated string.
 */
function serialRange(raw: unknown): string {
  let values: string[] = []
  if (Array.isArray(raw)) values = raw.map((v) => String(v))
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) values = parsed.map((v) => String(v))
    } catch {
      return "-"
    }
  }
  values = values.map((v) => v.trim()).filter(Boolean)
  if (!values.length) return "-"
  if (values.length === 1) return values[0]

  // A shared non-numeric prefix (SN-000123) is common; compare on the numeric
  // tail so those still collapse into a range.
  const parsed = values.map((v) => {
    const match = v.match(/^(.*?)(\d+)$/)
    return match ? { prefix: match[1], n: Number(match[2]), raw: v } : null
  })
  if (parsed.every((p) => p !== null)) {
    const items = parsed as Array<{ prefix: string; n: number; raw: string }>
    const prefix = items[0].prefix
    if (items.every((p) => p.prefix === prefix)) {
      const sorted = items.slice().sort((a, b) => a.n - b.n)
      const contiguous = sorted.every((p, i) => i === 0 || p.n === sorted[i - 1].n + 1)
      if (contiguous) return `${sorted[0].raw}–${sorted[sorted.length - 1].raw}`
    }
  }

  return `${values.slice(0, 3).join(", ")} +${values.length - 3} more`
}

/**
 * Standard terms printed above the signature row. Shared verbatim across every
 * document type so a counterparty reads the same conditions on the delivery
 * note and the consignment note, which is the point of a document standard.
 */
const STANDARD_TERMS: string[] = [
  "All goods are carried subject to the standard warehousing and dispatch terms of the issuing company.",
  "Goods must be examined for quantity and visible damage before the receipt is signed.",
  "Shortages, damages, or discrepancies must be reported in writing within 24 hours of delivery.",
  "Batch, lot, and serial references printed above are system-generated and must not be altered.",
]

function terms(): DocumentSection {
  return { kind: "terms", title: "Terms & Conditions", items: STANDARD_TERMS }
}

/** A summary tile, skipped entirely when the underlying value is unknown. */
function tile(label: string, value: string | number | null | undefined, unit?: string) {
  if (value === null || value === undefined || value === "" || value === "-") return []
  return [{ label, value: String(value), unit }]
}

/**
 * The Ship From / Ship To / Transport Details row (FR-04).
 *
 * Replaces the flat four-field "Parties" grid this engine shipped with. A
 * consignee scanning a document on a loading bay looks for three things in three
 * places; a single grid made them read all of it.
 */
function partyCards(doRow: Row, transport?: DocumentField[]): DocumentSection {
  const cards = [
    {
      title: "Ship From",
      fields: [
        { label: "Warehouse", value: str(doRow.warehouse_name) },
        {
          label: "Address",
          value:
            [
              str(doRow.warehouse_address, ""),
              str(doRow.warehouse_city, ""),
              str(doRow.warehouse_state, ""),
            ]
              .filter(Boolean)
              .join(", ") || "-",
        },
        { label: "Warehouse Code", value: str(doRow.warehouse_code) },
      ],
    },
    {
      title: "Ship To",
      fields: [
        {
          label: "Customer",
          value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() || "-",
        },
        {
          label: "Address",
          value:
            [str(doRow.client_address, ""), str(doRow.client_city, ""), str(doRow.client_state, "")]
              .filter(Boolean)
              .join(", ") || "-",
        },
        { label: "GSTIN", value: str(doRow.gst_number) },
        {
          label: "Contact",
          value:
            [str(doRow.client_contact, ""), str(doRow.client_phone, "")]
              .filter(Boolean)
              .join(" · ") || "-",
        },
      ],
    },
  ]

  if (transport && transport.length) {
    cards.push({ title: "Transport Details", fields: transport })
  }
  return { kind: "party-cards", cards }
}

/**
 * Everything a document needs but no builder should have to remember: the
 * letterhead (which depends on the type), the verification QR, and the print
 * timestamp. Builders return the parts that are genuinely theirs.
 */
type DraftModel = Omit<DocumentModel, "branding" | "printedAt" | "qr">

async function finalize(
  db: DocumentDBClient,
  companyId: number,
  subjectId: number,
  scope: DocumentResult["scope"],
  draft: DraftModel
): Promise<DocumentResult> {
  const [branding, qr] = await Promise.all([
    loadBranding(db, companyId, draft.type),
    // A document that cannot be signed still has to print — a missing QR is a
    // degraded document, an exception here would be no document at all.
    buildDocumentQr({ type: draft.type, id: subjectId, companyId }).catch(() => undefined),
  ])

  return {
    scope,
    model: { ...draft, branding, qr, printedAt: new Date().toISOString() },
  }
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** DO header + client + warehouse, the spine of most outbound documents. */
async function loadDoContext(db: DocumentDBClient, companyId: number, doId: number) {
  const result = await db.query(
    `SELECT dh.id, dh.do_number, dh.status, dh.request_date, dh.expected_dispatch_date,
            dh.dispatch_date, dh.requested_by, dh.remarks, dh.supplier_name, dh.invoice_no,
            dh.invoice_date, dh.handling_type, dh.machine_type, dh.machine_from_time,
            dh.machine_to_time, dh.no_of_cases, dh.no_of_pallets, dh.weight_kg,
            dh.outward_remarks, dh.material_description, dh.model_no,
            dh.total_items, dh.total_quantity_requested, dh.total_quantity_dispatched,
            dh.warehouse_id, dh.client_id,
            c.client_code, c.client_name, c.gst_number,
            c.registered_address AS client_address, c.city AS client_city, c.state AS client_state,
            c.contact_person AS client_contact, c.contact_phone AS client_phone,
            w.warehouse_code, w.warehouse_name, w.address AS warehouse_address,
            w.city AS warehouse_city, w.state AS warehouse_state
     FROM do_header dh
     JOIN clients c ON c.id = dh.client_id AND c.company_id = dh.company_id
     JOIN warehouses w ON w.id = dh.warehouse_id AND w.company_id = dh.company_id
     WHERE dh.company_id = $1 AND dh.id = $2
     LIMIT 1`,
    [companyId, doId]
  )
  if (!result.rows.length) throw new DocumentNotFoundError("Delivery Order not found")
  return result.rows[0]
}

/** Pack units for a DO with their contents, used by packing list and consignment note. */
async function loadPackUnitContents(db: DocumentDBClient, companyId: number, doId: number) {
  const result = await db.query(
    `SELECT u.id, u.pack_code, u.pack_type, u.status, u.total_quantity,
            u.gross_weight_kg, u.volume_cbm,
            i.item_code, i.item_name,
            COUNT(s.id)::int AS serial_count
     FROM do_pack_units u
     LEFT JOIN do_pack_unit_serials s ON s.pack_unit_id = u.id AND s.company_id = u.company_id
     LEFT JOIN items i ON i.id = s.item_id AND i.company_id = u.company_id
     WHERE u.company_id = $1
       AND u.do_header_id = $2
       AND u.status <> 'CANCELLED'
     GROUP BY u.id, u.pack_code, u.pack_type, u.status, u.total_quantity,
              u.gross_weight_kg, u.volume_cbm, i.item_code, i.item_name
     ORDER BY u.id ASC, i.item_code ASC`,
    [companyId, doId]
  )
  return result.rows
}

// ---------------------------------------------------------------------------
// Pick list — keyed on a WAVE id
// ---------------------------------------------------------------------------

async function buildPickList(
  db: DocumentDBClient,
  companyId: number,
  waveId: number
): Promise<DocumentResult> {
  const waveRes = await db.query(
    `SELECT wh.id, wh.wave_number, wh.strategy, wh.status, wh.total_orders, wh.total_tasks,
            wh.released_at, wh.created_at, wh.warehouse_id, wh.client_id,
            c.client_code, c.client_name,
            w.warehouse_code, w.warehouse_name
     FROM do_wave_header wh
     JOIN clients c ON c.id = wh.client_id AND c.company_id = wh.company_id
     JOIN warehouses w ON w.id = wh.warehouse_id AND w.company_id = wh.company_id
     WHERE wh.company_id = $1 AND wh.id = $2
     LIMIT 1`,
    [companyId, waveId]
  )
  if (!waveRes.rows.length) throw new DocumentNotFoundError("Wave not found")
  const wave = waveRes.rows[0]

  const tasks = await db.query(
    `SELECT t.id, t.status, t.required_quantity, t.picked_quantity, t.task_type,
            i.item_code, i.item_name, i.uom,
            dh.do_number,
            u.full_name AS assigned_name,
            wo.pick_sequence
     FROM do_pick_tasks t
     JOIN items i ON i.id = t.item_id AND i.company_id = t.company_id
     JOIN do_header dh ON dh.id = t.do_header_id AND dh.company_id = t.company_id
     LEFT JOIN do_wave_orders wo
       ON wo.wave_id = t.wave_id AND wo.do_header_id = t.do_header_id AND wo.company_id = t.company_id
     LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.company_id = $1 AND t.wave_id = $2
     ORDER BY wo.pick_sequence NULLS LAST, t.id ASC`,
    [companyId, waveId]
  )

  const totalRequired = tasks.rows.reduce((sum, r) => sum + num(r.required_quantity), 0)
  const totalPicked = tasks.rows.reduce((sum, r) => sum + num(r.picked_quantity), 0)

  return finalize(
    db,
    companyId,
    waveId,
    { warehouseId: num(wave.warehouse_id), clientId: num(wave.client_id) },
    {
      type: "pick-list",
      title: "Pick List",
      documentNumber: str(wave.wave_number),
      documentDate: fmtDate(wave.released_at ?? wave.created_at),
      warehouseLabel: str(wave.warehouse_code),
      status: statusTone(wave.status),
      meta: [
        { label: "Wave", value: str(wave.wave_number) },
        { label: "Strategy", value: str(wave.strategy) },
        { label: "Released", value: fmtDateTime(wave.released_at) },
        { label: "Client", value: `${str(wave.client_code, "")} ${str(wave.client_name)}`.trim() },
        { label: "Warehouse", value: str(wave.warehouse_name) },
      ],
      sections: [
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Pick Lines", tasks.rows.length),
            ...tile("Orders", num(wave.total_orders)),
            ...tile("Tasks", num(wave.total_tasks)),
            ...tile("Total Pick Qty", totalRequired),
            ...tile("Picked", totalPicked),
            ...tile("Outstanding", Math.max(0, totalRequired - totalPicked)),
          ],
        },
        {
          kind: "table",
          title: "Pick Tasks",
          emptyText: "No pick tasks on this wave.",
          columns: [
            { key: "seq", label: "Seq", width: "6%", align: "right" },
            { key: "do_number", label: "DO", width: "16%" },
            { key: "item_code", label: "Item Code", width: "14%" },
            { key: "item_name", label: "Description", width: "26%" },
            { key: "required", label: "Req Qty", width: "9%", align: "right" },
            { key: "picked", label: "Picked", width: "9%", align: "right" },
            { key: "uom", label: "UOM", width: "7%" },
            { key: "picker", label: "Picker", width: "13%" },
          ],
          rows: tasks.rows.map((row, index) => ({
            seq: row.pick_sequence === null || row.pick_sequence === undefined
              ? index + 1
              : num(row.pick_sequence),
            do_number: str(row.do_number),
            item_code: str(row.item_code),
            item_name: str(row.item_name),
            required: num(row.required_quantity),
            picked: num(row.picked_quantity),
            uom: str(row.uom),
            picker: str(row.assigned_name),
          })),
          totals: { item_name: "Total", required: totalRequired, picked: totalPicked },
        },
        terms(),
        signatures("Prepared By", "Picked By", "Checked By", "Authorized By"),
      ],
      footerNote: "Pick in sequence. Report shortages to the supervisor before closing the wave.",
    }
  )
}

// ---------------------------------------------------------------------------
// Packing list — keyed on a DO id
// ---------------------------------------------------------------------------

async function buildPackingList(
  db: DocumentDBClient,
  companyId: number,
  doId: number
): Promise<DocumentResult> {
  const doRow = await loadDoContext(db, companyId, doId)
  const contents = await loadPackUnitContents(db, companyId, doId)

  const unitIds = new Set(contents.map((r) => num(r.id)))
  const totalQty = contents.reduce((sum, r) => sum + num(r.serial_count), 0)
  const totalWeight = [...unitIds].reduce((sum, id) => {
    const first = contents.find((r) => num(r.id) === id)
    return sum + num(first?.gross_weight_kg)
  }, 0)
  const totalVolume = [...unitIds].reduce((sum, id) => {
    const first = contents.find((r) => num(r.id) === id)
    return sum + num(first?.volume_cbm)
  }, 0)

  return finalize(
    db,
    companyId,
    doId,
    { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    {
      type: "packing-list",
      title: "Packing List",
      documentNumber: str(doRow.do_number),
      documentDate: fmtDate(doRow.dispatch_date ?? doRow.request_date),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(doRow.status),
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Request Date", value: fmtDate(doRow.request_date) },
        { label: "Expected Dispatch", value: fmtDate(doRow.expected_dispatch_date) },
        { label: "Client", value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() },
        { label: "Warehouse", value: str(doRow.warehouse_name) },
      ],
      sections: [
        partyCards(doRow),
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Pack Units", unitIds.size),
            ...tile("Total Pieces", totalQty),
            ...tile("Gross Weight", totalWeight > 0 ? totalWeight.toFixed(3) : null, "kg"),
            ...tile("Total Volume", totalVolume > 0 ? totalVolume.toFixed(4) : null, "m³"),
            ...tile("Line Items", contents.length),
          ],
        },
        {
          kind: "table",
          title: "Pack Unit Contents",
          emptyText: "No pack units built for this delivery order yet.",
          columns: [
            { key: "pack_code", label: "Pack Unit", width: "18%" },
            { key: "pack_type", label: "Type", width: "10%" },
            { key: "item_code", label: "Item Code", width: "16%" },
            { key: "item_name", label: "Description", width: "28%" },
            { key: "qty", label: "Qty", width: "10%", align: "right" },
            { key: "weight", label: "Gross Kg", width: "10%", align: "right" },
            { key: "status", label: "Status", width: "8%" },
          ],
          rows: contents.map((row) => ({
            pack_code: str(row.pack_code),
            pack_type: str(row.pack_type),
            item_code: str(row.item_code),
            item_name: str(row.item_name),
            qty: num(row.serial_count),
            weight: row.gross_weight_kg === null ? "-" : num(row.gross_weight_kg).toFixed(3),
            status: str(row.status),
          })),
          totals: {
            item_name: "Total",
            qty: totalQty,
            weight: totalWeight > 0 ? totalWeight.toFixed(3) : "-",
          },
        },
        terms(),
        signatures("Packed By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote: "Contents are declared per pack unit. Any discrepancy must be noted before loading.",
    }
  )
}

// ---------------------------------------------------------------------------
// Goods issue note — keyed on a goods_issue_header id
// ---------------------------------------------------------------------------

async function buildGoodsIssueNote(
  db: DocumentDBClient,
  companyId: number,
  giId: number
): Promise<DocumentResult> {
  const giRes = await db.query(
    `SELECT gi.id, gi.gi_number, gi.status, gi.total_pack_units, gi.total_quantity,
            gi.issued_at, gi.remarks, gi.cancelled_at, gi.do_header_id,
            gi.warehouse_id, gi.client_id,
            u.full_name AS issued_by_name
     FROM goods_issue_header gi
     LEFT JOIN users u ON u.id = gi.issued_by
     WHERE gi.company_id = $1 AND gi.id = $2
     LIMIT 1`,
    [companyId, giId]
  )
  if (!giRes.rows.length) throw new DocumentNotFoundError("Goods Issue not found")
  const gi = giRes.rows[0]

  const doRow = await loadDoContext(db, companyId, num(gi.do_header_id))

  const units = await db.query(
    `SELECT p.pack_code, p.pack_type, p.gross_weight_kg, gip.quantity
     FROM goods_issue_pack_units gip
     JOIN do_pack_units p ON p.id = gip.pack_unit_id AND p.company_id = gip.company_id
     WHERE gip.company_id = $1 AND gip.goods_issue_id = $2
     ORDER BY p.id ASC`,
    [companyId, giId]
  )

  const giWeight = units.rows.reduce((sum, r) => sum + num(r.gross_weight_kg), 0)

  return finalize(
    db,
    companyId,
    giId,
    { warehouseId: num(gi.warehouse_id), clientId: num(gi.client_id) },
    {
      type: "goods-issue-note",
      title: "Goods Issue Note",
      documentNumber: str(gi.gi_number),
      documentDate: fmtDate(gi.issued_at),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(gi.status),
      meta: [
        { label: "GI Number", value: str(gi.gi_number) },
        { label: "Issued At", value: fmtDateTime(gi.issued_at) },
        { label: "Issued By", value: str(gi.issued_by_name) },
        { label: "DO Reference", value: str(doRow.do_number) },
        { label: "Client", value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() },
      ],
      sections: [
        partyCards(doRow),
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Line Items", units.rows.length),
            ...tile("Pack Units", num(gi.total_pack_units)),
            ...tile("Issued Qty", num(gi.total_quantity)),
            ...tile("Gross Weight", giWeight > 0 ? giWeight.toFixed(3) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Issued Pack Units",
          emptyText: "No pack units on this goods issue.",
          columns: [
            { key: "pack_code", label: "Pack Unit", width: "30%" },
            { key: "pack_type", label: "Type", width: "20%" },
            { key: "qty", label: "Quantity", width: "25%", align: "right" },
            { key: "weight", label: "Gross Kg", width: "25%", align: "right" },
          ],
          rows: units.rows.map((row) => ({
            pack_code: str(row.pack_code),
            pack_type: str(row.pack_type),
            qty: num(row.quantity),
            weight: row.gross_weight_kg === null ? "-" : num(row.gross_weight_kg).toFixed(3),
          })),
          totals: {
            pack_type: "Total",
            qty: units.rows.reduce((sum, r) => sum + num(r.quantity), 0),
          },
        },
        ...(str(gi.remarks, "") ? [{ kind: "notes" as const, title: "Remarks", text: str(gi.remarks) }] : []),
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote:
        "Goods are issued out of the client's stock account. Physical movement is covered by the delivery note.",
    }
  )
}

// ---------------------------------------------------------------------------
// Goods receipt note — keyed on a grn_header id
//
// Migrated from app/(dashboard)/grn/print/[id]/page.tsx, which predated the
// engine and carried its own layout and print CSS. The old page rendered a
// two-column label/value slab; the same fields are here, redistributed into the
// standard meta band, party cards and summary tiles.
//
// This is the only inbound document in the engine, so it does not use
// partyCards() — its parties are supplier and receiving warehouse, not shipper
// and consignee, and the transport details come off the gate-in record.
// ---------------------------------------------------------------------------

async function buildGoodsReceiptNote(
  db: DocumentDBClient,
  companyId: number,
  grnId: number
): Promise<DocumentResult> {
  const grnRes = await db.query(
    `SELECT g.id, g.grn_number, g.status, g.grn_date, g.created_at,
            g.invoice_number, g.invoice_date, g.invoice_value,
            g.supplier_name, g.supplier_gst, g.gate_in_number,
            g.model_number, g.material_description, g.receipt_date,
            g.manufacturing_date, g.basic_price, g.invoice_quantity,
            g.received_quantity, g.quantity_difference, g.damage_quantity,
            g.case_count, g.pallet_count, g.weight_kg, g.handling_type,
            g.total_items, g.total_quantity, g.warehouse_id, g.client_id,
            c.client_code, c.client_name, c.gst_number,
            w.warehouse_code, w.warehouse_name, w.address AS warehouse_address,
            w.city AS warehouse_city, w.state AS warehouse_state,
            w.contact_person AS warehouse_contact, w.contact_phone AS warehouse_phone,
            gi.truck_number, gi.driver_name, gi.driver_phone, gi.transport_company,
            gi.lr_number, gi.e_way_bill_number, gi.gate_in_datetime, gi.vehicle_type,
            u.full_name AS confirmed_by_name
     FROM grn_header g
     JOIN clients c ON c.id = g.client_id AND c.company_id = g.company_id
     JOIN warehouses w ON w.id = g.warehouse_id AND w.company_id = g.company_id
     LEFT JOIN gate_in gi ON gi.id = g.gate_in_id AND gi.company_id = g.company_id
     LEFT JOIN users u ON u.id = g.confirmed_by
     WHERE g.company_id = $1 AND g.id = $2
     LIMIT 1`,
    [companyId, grnId]
  )
  if (!grnRes.rows.length) throw new DocumentNotFoundError("Goods Receipt Note not found")
  const grn = grnRes.rows[0]

  const lines = await db.query(
    `SELECT gl.line_number, gl.quantity, gl.uom, gl.remarks, gl.serial_numbers_json,
            i.item_code, i.item_name, i.hsn_code
     FROM grn_line_items gl
     JOIN items i ON i.id = gl.item_id AND i.company_id = gl.company_id
     WHERE gl.company_id = $1 AND gl.grn_header_id = $2
     ORDER BY gl.line_number ASC`,
    [companyId, grnId]
  )

  const totalQty = lines.rows.reduce((sum, r) => sum + num(r.quantity), 0)

  return finalize(
    db,
    companyId,
    grnId,
    { warehouseId: num(grn.warehouse_id), clientId: num(grn.client_id) },
    {
      type: "goods-receipt-note",
      title: "Goods Receipt Note",
      documentNumber: str(grn.grn_number),
      documentDate: fmtDate(grn.grn_date ?? grn.created_at),
      warehouseLabel: str(grn.warehouse_code),
      status: statusTone(grn.status),
      meta: [
        { label: "GRN Number", value: str(grn.grn_number) },
        { label: "GRN Date", value: fmtDate(grn.grn_date) },
        { label: "Gate In No.", value: str(grn.gate_in_number) },
        { label: "Invoice No.", value: str(grn.invoice_number) },
        { label: "Invoice Date", value: fmtDate(grn.invoice_date) },
      ],
      sections: [
        {
          kind: "party-cards",
          cards: [
            {
              title: "Supplier",
              fields: [
                { label: "Supplier", value: str(grn.supplier_name) },
                { label: "GSTIN", value: str(grn.supplier_gst) },
                { label: "Invoice / Date", value: `${str(grn.invoice_number, "")} ${fmtDate(grn.invoice_date)}`.trim() },
              ],
            },
            {
              title: "Receiving Warehouse",
              fields: [
                { label: "Warehouse", value: str(grn.warehouse_name) },
                {
                  label: "Address",
                  value:
                    [
                      str(grn.warehouse_address, ""),
                      str(grn.warehouse_city, ""),
                      str(grn.warehouse_state, ""),
                    ]
                      .filter(Boolean)
                      .join(", ") || "-",
                },
                {
                  label: "Client Account",
                  value: `${str(grn.client_code, "")} ${str(grn.client_name)}`.trim() || "-",
                },
                {
                  label: "Contact",
                  value:
                    [str(grn.warehouse_contact, ""), str(grn.warehouse_phone, "")]
                      .filter(Boolean)
                      .join(" · ") || "-",
                },
              ],
            },
            {
              title: "Inbound Reference",
              fields: [
                { label: "Vehicle No.", value: str(grn.truck_number) },
                {
                  label: "Driver",
                  value:
                    [str(grn.driver_name, ""), str(grn.driver_phone, "")]
                      .filter(Boolean)
                      .join(" · ") || "-",
                },
                { label: "Transporter", value: str(grn.transport_company) },
                { label: "LR No.", value: str(grn.lr_number) },
                { label: "Gate In", value: fmtDateTime(grn.gate_in_datetime) },
              ],
            },
          ],
        },
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Total Line Items", num(grn.total_items) || lines.rows.length),
            ...tile("Received Qty", grn.received_quantity == null ? totalQty : num(grn.received_quantity)),
            ...tile("Invoice Qty", grn.invoice_quantity == null ? null : num(grn.invoice_quantity)),
            ...tile("Difference", grn.quantity_difference == null ? null : num(grn.quantity_difference)),
            ...tile("Damage Qty", grn.damage_quantity == null ? null : num(grn.damage_quantity)),
            // A zero here means "not weighed", unlike Difference/Damage above
            // where zero is the meaningful answer, so suppress the tile.
            ...tile("Gross Weight", num(grn.weight_kg) > 0 ? num(grn.weight_kg) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Received Items",
          caption: "Serial references are system-generated at receipt",
          emptyText: "No line items on this goods receipt.",
          columns: [
            { key: "line", label: "#", width: "5%", align: "right" },
            { key: "item_code", label: "SKU", width: "15%", mono: true },
            { key: "item_name", label: "Product Description", width: "26%" },
            { key: "hsn", label: "HSN", width: "10%", mono: true },
            { key: "qty", label: "Qty", width: "9%", align: "right" },
            { key: "uom", label: "UOM", width: "7%" },
            { key: "serials", label: "Serial Range", width: "16%", mono: true },
            { key: "remarks", label: "Remarks", width: "12%" },
          ],
          rows: lines.rows.map((row) => ({
            line: num(row.line_number),
            item_code: str(row.item_code),
            item_name: str(row.item_name),
            hsn: str(row.hsn_code),
            qty: num(row.quantity),
            uom: str(row.uom),
            serials: serialRange(row.serial_numbers_json),
            remarks: str(row.remarks),
          })),
          totals: { item_name: "Total", qty: totalQty },
        },
        ...(str(grn.material_description, "")
          ? [
              {
                kind: "notes" as const,
                title: "Material Description",
                text: str(grn.material_description),
              },
            ]
          : []),
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote:
        "Received subject to inspection. Shortages and visible damage must be recorded above before the receipt is signed.",
    }
  )
}

// ---------------------------------------------------------------------------
// Truck consignment note — keyed on an outbound_loads id
// ---------------------------------------------------------------------------

async function buildConsignmentNote(
  db: DocumentDBClient,
  companyId: number,
  loadId: number
): Promise<DocumentResult> {
  const loadRes = await db.query(
    `SELECT l.id, l.load_number, l.status, l.vehicle_number, l.container_number,
            l.seal_number, l.driver_name, l.driver_phone, l.transport_company,
            l.loading_bay, l.loaded_at, l.created_at, l.do_header_id, l.goods_issue_id,
            l.warehouse_id, l.client_id,
            gi.gi_number,
            u.full_name AS loaded_by_name
     FROM outbound_loads l
     LEFT JOIN goods_issue_header gi ON gi.id = l.goods_issue_id AND gi.company_id = l.company_id
     LEFT JOIN users u ON u.id = l.loaded_by
     WHERE l.company_id = $1 AND l.id = $2
     LIMIT 1`,
    [companyId, loadId]
  )
  if (!loadRes.rows.length) throw new DocumentNotFoundError("Load not found")
  const load = loadRes.rows[0]

  const doRow = await loadDoContext(db, companyId, num(load.do_header_id))

  const units = await db.query(
    `SELECT p.pack_code, p.pack_type, p.gross_weight_kg, p.volume_cbm, lpu.quantity
     FROM outbound_load_pack_units lpu
     JOIN do_pack_units p ON p.id = lpu.pack_unit_id AND p.company_id = lpu.company_id
     WHERE lpu.company_id = $1 AND lpu.load_id = $2
     ORDER BY p.id ASC`,
    [companyId, loadId]
  )

  const totalQty = units.rows.reduce((sum, r) => sum + num(r.quantity), 0)
  const totalWeight = units.rows.reduce((sum, r) => sum + num(r.gross_weight_kg), 0)
  const totalVolume = units.rows.reduce((sum, r) => sum + num(r.volume_cbm), 0)

  return finalize(
    db,
    companyId,
    loadId,
    { warehouseId: num(load.warehouse_id), clientId: num(load.client_id) },
    {
      type: "consignment-note",
      title: "Truck Consignment Note",
      documentNumber: str(load.load_number),
      // A load prints before it is loaded, so the header date falls back to when
      // the load was raised rather than leaving the reader a blank.
      documentDate: fmtDate(load.loaded_at ?? load.created_at),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(load.status),
      meta: [
        { label: "Load Number", value: str(load.load_number) },
        { label: "DO Reference", value: str(doRow.do_number) },
        { label: "Goods Issue", value: str(load.gi_number) },
        { label: "Loaded At", value: fmtDateTime(load.loaded_at) },
        { label: "Loaded By", value: str(load.loaded_by_name) },
      ],
      sections: [
        partyCards(doRow, [
          { label: "Vehicle No.", value: str(load.vehicle_number) },
          { label: "Driver", value: str(load.driver_name) },
          { label: "Driver Phone", value: str(load.driver_phone) },
          { label: "Transporter", value: str(load.transport_company) },
          { label: "Container No.", value: str(load.container_number) },
          { label: "Seal No.", value: str(load.seal_number) },
          { label: "Loading Bay", value: str(load.loading_bay) },
        ]),
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Pack Units", units.rows.length),
            ...tile("Total Quantity", totalQty),
            ...tile("Gross Weight", totalWeight > 0 ? totalWeight.toFixed(3) : null, "kg"),
            ...tile("Total Volume", totalVolume > 0 ? totalVolume.toFixed(4) : null, "m³"),
          ],
        },
        {
          kind: "table",
          title: "Consignment Contents",
          emptyText: "No pack units loaded.",
          columns: [
            { key: "pack_code", label: "Pack Unit", width: "26%" },
            { key: "pack_type", label: "Type", width: "16%" },
            { key: "qty", label: "Quantity", width: "18%", align: "right" },
            { key: "weight", label: "Gross Kg", width: "20%", align: "right" },
            { key: "volume", label: "CBM", width: "20%", align: "right" },
          ],
          rows: units.rows.map((row) => ({
            pack_code: str(row.pack_code),
            pack_type: str(row.pack_type),
            qty: num(row.quantity),
            weight: row.gross_weight_kg === null ? "-" : num(row.gross_weight_kg).toFixed(3),
            volume: row.volume_cbm === null ? "-" : num(row.volume_cbm).toFixed(4),
          })),
          totals: {
            pack_type: "Total",
            qty: totalQty,
            weight: totalWeight > 0 ? totalWeight.toFixed(3) : "-",
          },
        },
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote:
        "Received the above consignment in good order and condition. Driver's signature acknowledges the pack unit count.",
    }
  )
}

// ---------------------------------------------------------------------------
// Delivery note — keyed on a delivery_note_header id
// ---------------------------------------------------------------------------

async function buildDeliveryNote(
  db: DocumentDBClient,
  companyId: number,
  dnId: number
): Promise<DocumentResult> {
  const dnRes = await db.query(
    `SELECT dn.id, dn.delivery_note_number, dn.status, dn.total_pack_units, dn.total_quantity,
            dn.finalized_at, dn.created_at, dn.remarks, dn.do_header_id, dn.load_id,
            dn.warehouse_id, dn.client_id,
            l.load_number, l.vehicle_number, l.driver_name, l.transport_company,
            u.full_name AS finalized_by_name
     FROM delivery_note_header dn
     LEFT JOIN outbound_loads l ON l.id = dn.load_id AND l.company_id = dn.company_id
     LEFT JOIN users u ON u.id = dn.finalized_by
     WHERE dn.company_id = $1 AND dn.id = $2
     LIMIT 1`,
    [companyId, dnId]
  )
  if (!dnRes.rows.length) throw new DocumentNotFoundError("Delivery Note not found")
  const dn = dnRes.rows[0]

  const doRow = await loadDoContext(db, companyId, num(dn.do_header_id))

  // Batch, serial and expiry come off the serials actually attached to the DO
  // line rather than the item master, because that is what physically shipped —
  // a consignee checking a batch against the carton needs the shipped batch, not
  // the item's default. Aggregated in a lateral so one line stays one row.
  const lines = await db.query(
    `SELECT dnl.quantity, dli.line_number, dli.uom,
            i.item_code, i.item_name, i.hsn_code, i.weight_kg,
            s.batches, s.serials, s.expiry
     FROM delivery_note_lines dnl
     JOIN do_line_items dli ON dli.id = dnl.do_line_item_id AND dli.company_id = dnl.company_id
     JOIN items i ON i.id = dnl.item_id AND i.company_id = dnl.company_id
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT ssn.batch_number) FILTER (WHERE ssn.batch_number IS NOT NULL) AS batches,
              array_agg(ssn.serial_number ORDER BY ssn.serial_number) AS serials,
              MIN(ssn.expiry_date) AS expiry
       FROM stock_serial_numbers ssn
       WHERE ssn.company_id = dnl.company_id
         AND ssn.do_line_item_id = dnl.do_line_item_id
     ) s ON TRUE
     WHERE dnl.company_id = $1 AND dnl.delivery_note_id = $2
     ORDER BY dli.line_number ASC`,
    [companyId, dnId]
  )

  const totalQty = lines.rows.reduce((sum, r) => sum + num(r.quantity), 0)
  const totalLineWeight = lines.rows.reduce(
    (sum, r) => sum + num(r.weight_kg) * num(r.quantity),
    0
  )

  return finalize(
    db,
    companyId,
    dnId,
    { warehouseId: num(dn.warehouse_id), clientId: num(dn.client_id) },
    {
      type: "delivery-note",
      title: "Delivery Note",
      documentNumber: str(dn.delivery_note_number),
      // Draft delivery notes print too; fall back to when the note was raised.
      documentDate: fmtDate(dn.finalized_at ?? dn.created_at),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(dn.status),
      meta: [
        { label: "DN Number", value: str(dn.delivery_note_number) },
        { label: "DO Reference", value: str(doRow.do_number) },
        { label: "Load", value: str(dn.load_number) },
        { label: "Finalized At", value: fmtDateTime(dn.finalized_at) },
        { label: "Finalized By", value: str(dn.finalized_by_name) },
      ],
      sections: [
        partyCards(doRow, [
          { label: "Vehicle No.", value: str(dn.vehicle_number) },
          { label: "Driver", value: str(dn.driver_name) },
          { label: "Transporter", value: str(dn.transport_company) },
          { label: "Load Number", value: str(dn.load_number) },
        ]),
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Total Line Items", lines.rows.length),
            ...tile("Total Quantity", totalQty),
            ...tile("Pack Units", num(dn.total_pack_units)),
            ...tile("Net Weight", totalLineWeight > 0 ? totalLineWeight.toFixed(2) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Product Information",
          caption: "Quantities in dispatch UOM · weights in kg",
          emptyText: "No lines on this delivery note.",
          columns: [
            { key: "line", label: "#", width: "4%", align: "right" },
            { key: "item_code", label: "SKU", width: "14%", mono: true },
            { key: "item_name", label: "Product Description", width: "24%" },
            { key: "batch", label: "Batch", width: "11%", mono: true },
            { key: "serials", label: "Serial Range", width: "16%", mono: true },
            { key: "qty", label: "Qty", width: "8%", align: "right" },
            { key: "uom", label: "UOM", width: "7%" },
            { key: "weight", label: "Weight", width: "9%", align: "right" },
            { key: "hsn", label: "HSN", width: "7%", mono: true },
          ],
          rows: lines.rows.map((row) => {
            const lineWeight = num(row.weight_kg) * num(row.quantity)
            return {
              line: num(row.line_number),
              item_code: str(row.item_code),
              item_name: str(row.item_name),
              batch: Array.isArray(row.batches) ? row.batches.join(", ") || "-" : "-",
              serials: serialRange(row.serials),
              qty: num(row.quantity),
              uom: str(row.uom),
              weight: lineWeight > 0 ? lineWeight.toFixed(2) : "-",
              hsn: str(row.hsn_code),
            }
          }),
          totals: {
            item_name: `Total — ${lines.rows.length} line items`,
            qty: totalQty,
            weight: totalLineWeight > 0 ? totalLineWeight.toFixed(2) : "",
          },
        },
        ...(str(dn.remarks, "") ? [{ kind: "notes" as const, title: "Remarks", text: str(dn.remarks) }] : []),
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote:
        "Goods once delivered are checked and accepted by the consignee. Claims must be raised within 24 hours of delivery.",
    }
  )
}

// ---------------------------------------------------------------------------
// Job card — keyed on a DO id
// ---------------------------------------------------------------------------

async function buildJobCard(
  db: DocumentDBClient,
  companyId: number,
  doId: number
): Promise<DocumentResult> {
  const doRow = await loadDoContext(db, companyId, doId)

  const labour = await db.query(
    `SELECT wt.task_type, wt.start_time, wt.end_time, wt.duration_minutes,
            wt.quantity_processed, wt.items_count, wt.status,
            u.full_name AS worker_name
     FROM workforce_tasks wt
     LEFT JOIN users u ON u.id = wt.user_id
     WHERE wt.company_id = $1
       AND wt.task_reference_type = 'DO'
       AND wt.task_reference_id = $2
     ORDER BY wt.start_time ASC NULLS LAST, wt.id ASC`,
    [companyId, doId]
  )

  const totalMinutes = labour.rows.reduce((sum, r) => sum + num(r.duration_minutes), 0)
  const totalHandled = labour.rows.reduce((sum, r) => sum + num(r.quantity_processed), 0)

  return finalize(
    db,
    companyId,
    doId,
    { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    {
      type: "job-card",
      title: "Job Card",
      documentNumber: str(doRow.do_number),
      documentDate: fmtDate(doRow.dispatch_date ?? doRow.request_date),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(doRow.status),
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Client", value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() },
        { label: "Warehouse", value: str(doRow.warehouse_name) },
        { label: "Request Date", value: fmtDate(doRow.request_date) },
        { label: "Dispatch Date", value: fmtDate(doRow.dispatch_date) },
      ],
      sections: [
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Activities", labour.rows.length),
            ...tile("Total Minutes", totalMinutes),
            ...tile("Qty Handled", totalHandled),
            ...tile("Cases", num(doRow.no_of_cases)),
            ...tile("Pallets", num(doRow.no_of_pallets)),
            ...tile("Weight", num(doRow.weight_kg) > 0 ? num(doRow.weight_kg) : null, "kg"),
          ],
        },
        {
          kind: "fields",
          title: "Handling",
          columns: 3,
          fields: [
            { label: "Handling Type", value: str(doRow.handling_type) },
            { label: "Machine Type", value: str(doRow.machine_type) },
            { label: "Machine From", value: str(doRow.machine_from_time) },
            { label: "Machine To", value: str(doRow.machine_to_time) },
            { label: "Cases", value: String(num(doRow.no_of_cases)) },
            { label: "Pallets", value: String(num(doRow.no_of_pallets)) },
            { label: "Weight (kg)", value: doRow.weight_kg === null ? "-" : String(num(doRow.weight_kg)) },
            { label: "Total Items", value: String(num(doRow.total_items)) },
            { label: "Qty Requested", value: String(num(doRow.total_quantity_requested)) },
          ],
        },
        {
          kind: "table",
          title: "Labour & Equipment",
          emptyText: "No workforce tasks recorded against this delivery order.",
          columns: [
            { key: "task_type", label: "Activity", width: "20%" },
            { key: "worker", label: "Worker", width: "22%" },
            { key: "start", label: "Start", width: "16%" },
            { key: "end", label: "End", width: "16%" },
            { key: "minutes", label: "Minutes", width: "13%", align: "right" },
            { key: "qty", label: "Qty", width: "13%", align: "right" },
          ],
          rows: labour.rows.map((row) => ({
            task_type: str(row.task_type),
            worker: str(row.worker_name),
            start: fmtDateTime(row.start_time),
            end: fmtDateTime(row.end_time),
            minutes: num(row.duration_minutes),
            qty: num(row.quantity_processed),
          })),
          totals: { start: "Total", minutes: totalMinutes },
        },
        ...(str(doRow.outward_remarks, "")
          ? [{ kind: "notes" as const, title: "Outward Remarks", text: str(doRow.outward_remarks) }]
          : []),
        terms(),
        signatures("Prepared By", "Operator", "Supervisor", "Authorized By"),
      ],
      footerNote: "Billable handling time is taken from this card. Confirm start/end times before signing.",
    }
  )
}

// ---------------------------------------------------------------------------
// Dispatch note / packing slip — the two profiles inherited from the retired
// hand-rolled PDF route, keyed on a DO id.
// ---------------------------------------------------------------------------

async function buildDoLineDocument(
  db: DocumentDBClient,
  companyId: number,
  doId: number,
  type: "dispatch-note" | "packing-slip"
): Promise<DocumentResult> {
  const doRow = await loadDoContext(db, companyId, doId)
  const isPackingSlip = type === "packing-slip"

  const lines = await db.query(
    `SELECT dli.line_number, dli.quantity_requested, dli.quantity_dispatched, dli.uom,
            i.item_code, i.item_name, i.hsn_code
     FROM do_line_items dli
     JOIN items i ON i.id = dli.item_id AND i.company_id = dli.company_id
     WHERE dli.company_id = $1 AND dli.do_header_id = $2
     ORDER BY dli.line_number ASC`,
    [companyId, doId]
  )

  const totalRequested = lines.rows.reduce((sum, r) => sum + num(r.quantity_requested), 0)
  const totalDispatched = lines.rows.reduce((sum, r) => sum + num(r.quantity_dispatched), 0)

  const columns = isPackingSlip
    ? [
        { key: "line", label: "#", width: "6%", align: "right" as const },
        { key: "item_code", label: "Item Code", width: "18%" },
        { key: "item_name", label: "Description", width: "44%" },
        { key: "requested", label: "Qty", width: "16%", align: "right" as const },
        { key: "uom", label: "UOM", width: "16%" },
      ]
    : [
        { key: "line", label: "#", width: "5%", align: "right" as const },
        { key: "item_code", label: "Item Code", width: "16%" },
        { key: "item_name", label: "Description", width: "31%" },
        { key: "hsn", label: "HSN", width: "12%" },
        { key: "requested", label: "Requested", width: "12%", align: "right" as const },
        { key: "dispatched", label: "Dispatched", width: "12%", align: "right" as const },
        { key: "uom", label: "UOM", width: "12%" },
      ]

  return finalize(
    db,
    companyId,
    doId,
    { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    {
      type,
      title: isPackingSlip ? "Packing Slip" : "Dispatch Note",
      documentNumber: str(doRow.do_number),
      documentDate: fmtDate(doRow.dispatch_date ?? doRow.request_date),
      warehouseLabel: str(doRow.warehouse_code),
      status: statusTone(doRow.status),
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Request Date", value: fmtDate(doRow.request_date) },
        { label: "Dispatch Date", value: fmtDate(doRow.dispatch_date) },
        ...(isPackingSlip
          ? []
          : [
              { label: "Supplier", value: str(doRow.supplier_name) },
              { label: "Invoice No.", value: str(doRow.invoice_no) },
            ]),
      ],
      sections: [
        partyCards(doRow),
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Total Line Items", lines.rows.length),
            ...tile("Qty Requested", totalRequested),
            ...(isPackingSlip ? [] : tile("Qty Dispatched", totalDispatched)),
            ...tile("Cases", num(doRow.no_of_cases)),
            ...tile("Pallets", num(doRow.no_of_pallets)),
            ...tile("Weight", num(doRow.weight_kg) > 0 ? num(doRow.weight_kg) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Line Items",
          emptyText: "No line items on this delivery order.",
          columns,
          rows: lines.rows.map((row) => ({
            line: num(row.line_number),
            item_code: str(row.item_code),
            item_name: str(row.item_name),
            hsn: str(row.hsn_code),
            requested: num(row.quantity_requested),
            dispatched: num(row.quantity_dispatched),
            uom: str(row.uom),
          })),
          totals: isPackingSlip
            ? { item_name: "Total", requested: totalRequested }
            : { item_name: "Total", requested: totalRequested, dispatched: totalDispatched },
        },
        ...(str(doRow.remarks, "")
          ? [{ kind: "notes" as const, title: "Remarks", text: str(doRow.remarks) }]
          : []),
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
    }
  )
}

// ---------------------------------------------------------------------------
// Gate pass — keyed on a gate_out id
//
// FIDELITY NOTE: the approved sample also shows seal number, weighbridge slip,
// gate-in/out times, returnable assets and a security officer. `gate_out` holds
// none of those columns, so this prints what the system actually knows rather
// than inventing fields. Closing that gap is a schema change, not a template
// change.
// ---------------------------------------------------------------------------

async function buildGatePass(
  db: DocumentDBClient,
  companyId: number,
  gateOutId: number
): Promise<DocumentResult> {
  const res = await db.query(
    `SELECT go.id, go.gate_out_number, go.gate_out_datetime, go.created_at,
            go.truck_number, go.driver_name, go.driver_phone, go.transport_company,
            go.lr_number, go.e_way_bill_number, go.remarks,
            go.warehouse_id, go.client_id, go.do_header_id,
            u.full_name AS issued_by_name
     FROM gate_out go
     LEFT JOIN users u ON u.id = go.created_by
     WHERE go.company_id = $1 AND go.id = $2
     LIMIT 1`,
    [companyId, gateOutId]
  )
  if (!res.rows.length) throw new DocumentNotFoundError("Gate Pass not found")
  const gate = res.rows[0]

  const doRow = await loadDoContext(db, companyId, num(gate.do_header_id))

  // Pack units are what physically leaves the gate, so the security desk counts
  // these rather than line items.
  const units = await db.query(
    `SELECT p.pack_code, p.pack_type, p.total_quantity, p.gross_weight_kg, p.status
     FROM do_pack_units p
     WHERE p.company_id = $1 AND p.do_header_id = $2 AND p.status <> 'CANCELLED'
     ORDER BY p.id ASC`,
    [companyId, num(gate.do_header_id)]
  )

  const totalQty = units.rows.reduce((sum, r) => sum + num(r.total_quantity), 0)
  const totalWeight = units.rows.reduce((sum, r) => sum + num(r.gross_weight_kg), 0)

  return finalize(
    db,
    companyId,
    gateOutId,
    { warehouseId: num(gate.warehouse_id), clientId: num(gate.client_id) },
    {
      type: "gate-pass",
      title: "Gate Pass",
      documentNumber: str(gate.gate_out_number),
      documentDate: fmtDate(gate.gate_out_datetime ?? gate.created_at),
      warehouseLabel: str(doRow.warehouse_code),
      // gate_out records an event rather than a lifecycle: the row existing is
      // the pass having been issued.
      status: statusTone("ISSUED"),
      meta: [
        { label: "Gate Pass No.", value: str(gate.gate_out_number) },
        { label: "Pass Type", value: "Outward — Dispatch" },
        { label: "Linked DO", value: str(doRow.do_number) },
        { label: "Gate Out", value: fmtDateTime(gate.gate_out_datetime) },
        { label: "Issued By", value: str(gate.issued_by_name) },
      ],
      sections: [
        {
          kind: "party-cards",
          cards: [
            {
              title: "Vehicle & Driver",
              fields: [
                { label: "Vehicle No.", value: str(gate.truck_number) },
                { label: "Driver", value: str(gate.driver_name) },
                { label: "Mobile", value: str(gate.driver_phone) },
                { label: "Transporter", value: str(gate.transport_company) },
              ],
            },
            {
              title: "Destination",
              fields: [
                {
                  label: "Customer",
                  value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() || "-",
                },
                {
                  label: "Address",
                  value:
                    [str(doRow.client_city, ""), str(doRow.client_state, "")]
                      .filter(Boolean)
                      .join(", ") || "-",
                },
                { label: "DO Reference", value: str(doRow.do_number) },
              ],
            },
            {
              title: "Documents Checked",
              fields: [
                { label: "LR No.", value: str(gate.lr_number) },
                { label: "E-Way Bill", value: str(gate.e_way_bill_number) },
                { label: "Issuing Warehouse", value: str(doRow.warehouse_name) },
              ],
            },
          ],
        },
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Total Packages", units.rows.length),
            ...tile("Total Quantity", totalQty),
            ...tile("Gross Weight", totalWeight > 0 ? totalWeight.toFixed(3) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Items Leaving the Premises",
          emptyText: "No pack units recorded against this dispatch.",
          columns: [
            { key: "pack_code", label: "Package ID", width: "28%", mono: true },
            { key: "pack_type", label: "Packing Type", width: "22%" },
            { key: "qty", label: "Qty", width: "16%", align: "right" },
            { key: "weight", label: "Gross Kg", width: "18%", align: "right" },
            { key: "status", label: "Condition", width: "16%" },
          ],
          rows: units.rows.map((row) => ({
            pack_code: str(row.pack_code),
            pack_type: str(row.pack_type),
            qty: num(row.total_quantity),
            weight: row.gross_weight_kg === null ? "-" : num(row.gross_weight_kg).toFixed(3),
            status: str(row.status),
          })),
          totals: {
            pack_type: "Total",
            qty: totalQty,
            weight: totalWeight > 0 ? totalWeight.toFixed(3) : "-",
          },
        },
        ...(str(gate.remarks, "")
          ? [{ kind: "notes" as const, title: "Remarks", text: str(gate.remarks) }]
          : []),
        terms(),
        signatures("Prepared By", "Checked By (Security)", "Authorized By", "Received By (Driver)"),
      ],
      footerNote:
        "This pass authorises the listed goods to leave the premises. Security must verify the vehicle and document references before release.",
    }
  )
}

// ---------------------------------------------------------------------------
// Cycle count sheet — keyed on a cycle_count_plans id
//
// This is the one document printed to be WRITTEN ON, so it deliberately carries
// empty ruled columns rather than system data. When the plan is a blind count,
// expected quantity is withheld — printing it would defeat the count, which is
// the entire control the document exists to provide.
// ---------------------------------------------------------------------------

async function buildCycleCountSheet(
  db: DocumentDBClient,
  companyId: number,
  planId: number
): Promise<DocumentResult> {
  const res = await db.query(
    `SELECT p.id, p.plan_number, p.status, p.strategy, p.blind_count, p.zone_code,
            p.total_tasks, p.notes, p.created_at, p.closed_at,
            p.warehouse_id, p.client_id,
            c.client_code, c.client_name,
            w.warehouse_code, w.warehouse_name,
            u.full_name AS created_by_name
     FROM cycle_count_plans p
     LEFT JOIN clients c ON c.id = p.client_id AND c.company_id = p.company_id
     JOIN warehouses w ON w.id = p.warehouse_id AND w.company_id = p.company_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.company_id = $1 AND p.id = $2
     LIMIT 1`,
    [companyId, planId]
  )
  if (!res.rows.length) throw new DocumentNotFoundError("Cycle Count plan not found")
  const plan = res.rows[0]
  const blind = Boolean(plan.blind_count)

  const tasks = await db.query(
    `SELECT t.bin_id, t.lp_id, t.sku, t.expected_qty, t.status, t.task_type,
            i.item_name, i.uom,
            u.full_name AS worker_name
     FROM mobile_cycle_count_tasks t
     LEFT JOIN items i ON i.item_code = t.sku AND i.company_id = t.company_id
     LEFT JOIN users u ON u.id = t.worker_id
     WHERE t.company_id = $1 AND t.plan_id = $2
     ORDER BY t.bin_id ASC NULLS LAST, t.sku ASC`,
    [companyId, planId]
  )

  const counters = [
    ...new Set(tasks.rows.map((r) => str(r.worker_name, "")).filter(Boolean)),
  ]

  const columns: DocumentColumn[] = [
    { key: "seq", label: "Seq", width: "5%", align: "right" },
    { key: "bin", label: "Location", width: "15%", mono: true },
    { key: "sku", label: "SKU", width: "16%", mono: true },
    { key: "item_name", label: "Product Description", width: "26%" },
    { key: "uom", label: "UOM", width: "7%" },
    // Blind counts hide the system figure; open counts print it so the counter
    // can confirm rather than re-derive.
    ...(blind
      ? []
      : [{ key: "expected", label: "System Qty", width: "9%", align: "right" as const }]),
    { key: "count1", label: "Count 1", width: blind ? "12%" : "8%" },
    { key: "count2", label: "Count 2", width: blind ? "12%" : "8%" },
    { key: "initials", label: "Initials", width: blind ? "13%" : "6%" },
  ]

  return finalize(
    db,
    companyId,
    planId,
    { warehouseId: num(plan.warehouse_id), clientId: num(plan.client_id) },
    {
      type: "cycle-count-sheet",
      title: "Cycle Count Sheet",
      documentNumber: str(plan.plan_number),
      documentDate: fmtDate(plan.created_at),
      warehouseLabel: str(plan.warehouse_code),
      status: statusTone(plan.status),
      meta: [
        { label: "Count Sheet No.", value: str(plan.plan_number) },
        { label: "Strategy", value: str(plan.strategy) },
        { label: "Zone", value: str(plan.zone_code) },
        { label: "Blind Count", value: blind ? "Yes — system qty hidden" : "No" },
        { label: "Lines to Count", value: String(num(plan.total_tasks) || tasks.rows.length) },
      ],
      sections: [
        {
          kind: "fields",
          title: "Count Scope",
          columns: 3,
          fields: [
            { label: "Warehouse", value: str(plan.warehouse_name) },
            {
              label: "Client",
              value: `${str(plan.client_code, "")} ${str(plan.client_name)}`.trim() || "All clients",
            },
            { label: "Zone / Area", value: str(plan.zone_code) },
            { label: "Planned By", value: str(plan.created_by_name) },
            { label: "Counters", value: counters.length ? counters.join(", ") : "Unassigned" },
            { label: "Closed At", value: fmtDateTime(plan.closed_at) },
          ],
        },
        {
          kind: "table",
          title: "Count Lines",
          caption: "Enter counted quantity in ink · strike through and initial any correction",
          emptyText: "No count tasks generated for this plan.",
          columns,
          rows: tasks.rows.map((row, index) => ({
            seq: index + 1,
            bin: str(row.bin_id),
            sku: str(row.sku),
            item_name: str(row.item_name),
            uom: str(row.uom),
            // On a blind count the expected quantity is omitted from the MODEL,
            // not merely from the column list. The model is served as JSON, so a
            // hidden column would still hand the system figure to anyone who
            // opened the network tab — which is exactly the control a blind
            // count exists to enforce.
            ...(blind ? {} : { expected: num(row.expected_qty) }),
            // Deliberately blank: these are written on by hand.
            count1: "",
            count2: "",
            initials: "",
          })),
        },
        ...(str(plan.notes, "")
          ? [{ kind: "notes" as const, title: "Instructions", text: str(plan.notes) }]
          : []),
        terms(),
        signatures("Prepared By", "Counted By", "Checked By", "Authorized By"),
      ],
      footerNote: blind
        ? "Blind count — system quantities are withheld. Record what is physically present; do not adjust to expectation."
        : "Record what is physically present. Variances beyond the plan threshold trigger a recount before adjustment.",
    }
  )
}

// ---------------------------------------------------------------------------
// Stock transfer note — keyed on a stock_transfer_header id
//
// This document travels WITH the stock, so it is written for the person at the
// receiving dock: what left, what should arrive, and space to record what
// actually did. Once received it becomes the evidence of any shortfall, which is
// why sent and received are printed side by side rather than netted.
// ---------------------------------------------------------------------------

async function buildStockTransferNote(
  db: DocumentDBClient,
  companyId: number,
  transferId: number
): Promise<DocumentResult> {
  const res = await db.query(
    `SELECT h.*, c.client_code, c.client_name,
            fw.warehouse_code AS from_code, fw.warehouse_name AS from_name,
            fw.address AS from_address, fw.city AS from_city,
            tw.warehouse_code AS to_code, tw.warehouse_name AS to_name,
            tw.address AS to_address, tw.city AS to_city,
            ua.full_name AS approved_by_name,
            up.full_name AS picked_by_name,
            ud.full_name AS dispatched_by_name,
            ur.full_name AS received_by_name
       FROM stock_transfer_header h
       LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
       JOIN warehouses fw ON fw.id = h.from_warehouse_id AND fw.company_id = h.company_id
       JOIN warehouses tw ON tw.id = h.to_warehouse_id AND tw.company_id = h.company_id
       LEFT JOIN users ua ON ua.id = h.approved_by
       LEFT JOIN users up ON up.id = h.picked_by
       LEFT JOIN users ud ON ud.id = h.dispatched_by
       LEFT JOIN users ur ON ur.id = h.received_by
      WHERE h.company_id = $1 AND h.id = $2
      LIMIT 1`,
    [companyId, transferId]
  )
  if (!res.rows.length) throw new DocumentNotFoundError("Stock transfer not found")
  const transfer = res.rows[0]

  const lines = await db.query(
    `SELECT l.line_number, l.quantity_requested, l.quantity_sent, l.quantity_received,
            l.uom, l.remarks, i.item_code, i.item_name
       FROM stock_transfer_lines l
       JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = $1 AND l.transfer_id = $2
      ORDER BY l.line_number`,
    [companyId, transferId]
  )

  const dispatched = Boolean(transfer.dispatched_at)
  const received = Boolean(transfer.received_at)
  const totalSent = lines.rows.reduce((sum, r) => sum + num(r.quantity_sent), 0)
  const totalReceived = lines.rows.reduce((sum, r) => sum + num(r.quantity_received), 0)
  const shortfall = received ? totalSent - totalReceived : 0

  return finalize(
    db,
    companyId,
    transferId,
    { warehouseId: num(transfer.from_warehouse_id), clientId: num(transfer.client_id) },
    {
      type: "stock-transfer-note",
      title: "Stock Transfer Note",
      documentNumber: str(transfer.transfer_number),
      documentDate: fmtDate(transfer.transfer_date),
      warehouseLabel: str(transfer.from_code),
      status: statusTone(transfer.status),
      meta: [
        { label: "Transfer No.", value: str(transfer.transfer_number) },
        { label: "Status", value: str(transfer.status) },
        { label: "Dispatched", value: fmtDateTime(transfer.dispatched_at) },
        { label: "Received", value: fmtDateTime(transfer.received_at) },
      ],
      sections: [
        {
          kind: "party-cards",
          cards: [
            {
              title: "Dispatching Warehouse",
              fields: [
                { label: "Warehouse", value: str(transfer.from_name) },
                { label: "Address", value: str(transfer.from_address) },
                { label: "City", value: str(transfer.from_city) },
              ],
            },
            {
              title: "Receiving Warehouse",
              fields: [
                { label: "Warehouse", value: str(transfer.to_name) },
                { label: "Address", value: str(transfer.to_address) },
                { label: "City", value: str(transfer.to_city) },
              ],
            },
            {
              title: "Stock Owner",
              fields: [
                { label: "Client", value: str(transfer.client_name) },
                { label: "Code", value: str(transfer.client_code) },
              ],
            },
          ],
        },
        {
          kind: "fields",
          title: "Movement",
          columns: 3,
          fields: [
            { label: "Reason", value: str(transfer.reason) },
            { label: "Expected Date", value: fmtDate(transfer.expected_date) },
            { label: "Vehicle", value: str(transfer.vehicle_number) },
            { label: "Driver", value: str(transfer.driver_name) },
            { label: "Approved By", value: str(transfer.approved_by_name) },
            // Who found the stock is a different accountability from who
            // authorised it or who sent it, and a short receipt makes the
            // difference matter.
            { label: "Picked By", value: str(transfer.picked_by_name) },
            { label: "Dispatched By", value: str(transfer.dispatched_by_name) },
          ],
        },
        {
          kind: "table",
          title: "Transfer Lines",
          caption: received
            ? "Received quantities as recorded at the destination"
            : "Receiving warehouse: record the quantity actually received against each line",
          emptyText: "No lines on this transfer.",
          columns: [
            { key: "seq", label: "#", width: "5%", align: "right" },
            { key: "code", label: "Item Code", width: "18%", mono: true },
            { key: "name", label: "Description", width: "33%" },
            { key: "uom", label: "UOM", width: "8%" },
            { key: "requested", label: "Requested", width: "10%", align: "right" },
            { key: "sent", label: "Sent", width: "10%", align: "right" },
            // Left blank before receipt: the destination writes it in, and
            // pre-printing the sent quantity here would invite a tick rather than
            // a count.
            { key: "received", label: "Received", width: "10%", align: "right" },
            { key: "variance", label: "Short", width: "6%", align: "right" },
          ],
          rows: lines.rows.map((row, index) => ({
            seq: index + 1,
            code: str(row.item_code),
            name: str(row.item_name),
            uom: str(row.uom),
            requested: num(row.quantity_requested),
            sent: dispatched ? num(row.quantity_sent) : "",
            received: received ? num(row.quantity_received) : "",
            variance: received ? num(row.quantity_sent) - num(row.quantity_received) || "" : "",
          })),
        },
        {
          kind: "summary-tiles",
          tiles: [
            { label: "Lines", value: String(lines.rows.length) },
            { label: "Units Sent", value: dispatched ? String(totalSent) : "—" },
            { label: "Units Received", value: received ? String(totalReceived) : "—" },
            { label: "Short", value: received ? String(shortfall) : "—" },
          ],
        },
        ...(shortfall > 0
          ? [
              {
                kind: "notes" as const,
                title: "Discrepancy",
                text: `${shortfall} unit(s) despatched from ${str(
                  transfer.from_name
                )} were not received at ${str(
                  transfer.to_name
                )}. These units remain in transit in the system and must be resolved by an inventory adjustment.`,
              },
            ]
          : []),
        ...(str(transfer.remarks, "")
          ? [{ kind: "notes" as const, title: "Remarks", text: str(transfer.remarks) }]
          : []),
        terms(),
        signatures("Prepared By", "Dispatched By", "Transporter", "Received By"),
      ],
      footerNote:
        "Goods remain the property of the stock owner throughout. The receiving warehouse must record actual quantities; unrecorded shortfalls stay in transit.",
    }
  )
}

// ---------------------------------------------------------------------------
// Inventory adjustment report — keyed on an inventory_adjustment_header id
//
// The audit document for stock that changed without being received or shipped.
// It prints the serial numbers rather than only quantities, because "12 units
// written off" is not evidence and "these 12 units" is.
// ---------------------------------------------------------------------------

async function buildInventoryAdjustmentReport(
  db: DocumentDBClient,
  companyId: number,
  adjustmentId: number
): Promise<DocumentResult> {
  const res = await db.query(
    `SELECT h.*, c.client_code, c.client_name, w.warehouse_code, w.warehouse_name,
            uc.full_name AS created_by_name,
            ua.full_name AS approved_by_name,
            ur.full_name AS rejected_by_name
       FROM inventory_adjustment_header h
       LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
       JOIN warehouses w ON w.id = h.warehouse_id AND w.company_id = h.company_id
       LEFT JOIN users uc ON uc.id = h.created_by
       LEFT JOIN users ua ON ua.id = h.approved_by
       LEFT JOIN users ur ON ur.id = h.rejected_by
      WHERE h.company_id = $1 AND h.id = $2
      LIMIT 1`,
    [companyId, adjustmentId]
  )
  if (!res.rows.length) throw new DocumentNotFoundError("Inventory adjustment not found")
  const adjustment = res.rows[0]

  const lines = await db.query(
    `SELECT l.line_number, l.direction, l.quantity, l.batch_number, l.expiry_date,
            l.bin_location, l.remarks, i.item_code, i.item_name, i.uom,
            (SELECT string_agg(s.serial_number, ', ' ORDER BY s.serial_number)
               FROM inventory_adjustment_serials s WHERE s.adjustment_line_id = l.id) AS serials
       FROM inventory_adjustment_lines l
       JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = $1 AND l.adjustment_id = $2
      ORDER BY l.line_number`,
    [companyId, adjustmentId]
  )

  const decreased = lines.rows
    .filter((r) => str(r.direction) === "DECREASE")
    .reduce((sum, r) => sum + num(r.quantity), 0)
  const increased = lines.rows
    .filter((r) => str(r.direction) === "INCREASE")
    .reduce((sum, r) => sum + num(r.quantity), 0)
  const applied = str(adjustment.status) === "APPROVED"

  return finalize(
    db,
    companyId,
    adjustmentId,
    { warehouseId: num(adjustment.warehouse_id), clientId: num(adjustment.client_id) },
    {
      type: "inventory-adjustment-report",
      title: "Inventory Adjustment Report",
      documentNumber: str(adjustment.adjustment_number),
      documentDate: fmtDate(adjustment.adjustment_date),
      warehouseLabel: str(adjustment.warehouse_code),
      status: statusTone(adjustment.status),
      meta: [
        { label: "Adjustment No.", value: str(adjustment.adjustment_number) },
        { label: "Reason Code", value: str(adjustment.reason_code) },
        { label: "Origin", value: str(adjustment.source_module) },
        { label: "Reference", value: str(adjustment.reference_no) },
      ],
      sections: [
        {
          kind: "fields",
          title: "Adjustment",
          columns: 3,
          fields: [
            { label: "Warehouse", value: str(adjustment.warehouse_name) },
            {
              label: "Client",
              value: `${str(adjustment.client_code, "")} ${str(adjustment.client_name)}`.trim(),
            },
            { label: "Raised By", value: str(adjustment.created_by_name) },
            { label: "Approved By", value: str(adjustment.approved_by_name) },
            { label: "Approved At", value: fmtDateTime(adjustment.approved_at) },
            { label: "Reason", value: str(adjustment.reason) },
          ],
        },
        {
          kind: "table",
          title: "Adjustment Lines",
          // The serial column is the point of the document: a quantity alone
          // cannot be audited back to the stock it removed.
          caption: "Serial numbers are listed so each unit can be traced",
          emptyText: "No lines on this adjustment.",
          columns: [
            { key: "seq", label: "#", width: "4%", align: "right" },
            { key: "direction", label: "Direction", width: "10%" },
            { key: "code", label: "Item Code", width: "14%", mono: true },
            { key: "name", label: "Description", width: "20%" },
            { key: "batch", label: "Batch", width: "10%", mono: true },
            { key: "qty", label: "Qty", width: "6%", align: "right" },
            { key: "serials", label: "Serial Numbers", width: "36%", mono: true },
          ],
          rows: lines.rows.map((row, index) => ({
            seq: index + 1,
            direction: str(row.direction) === "DECREASE" ? "Write-off" : "Addition",
            code: str(row.item_code),
            name: str(row.item_name),
            batch: str(row.batch_number),
            qty: num(row.quantity),
            serials: str(row.serials),
          })),
        },
        {
          kind: "summary-tiles",
          tiles: [
            { label: "Units Written Off", value: String(decreased) },
            { label: "Units Added", value: String(increased) },
            { label: "Net Change", value: String(increased - decreased) },
            { label: "Stock Updated", value: applied ? "Yes" : "No — pending approval" },
          ],
        },
        ...(str(adjustment.rejection_reason, "")
          ? [
              {
                kind: "notes" as const,
                title: "Rejected",
                text: `${str(adjustment.rejection_reason)} — rejected by ${str(
                  adjustment.rejected_by_name
                )} on ${fmtDateTime(adjustment.rejected_at)}. Stock was not changed.`,
              },
            ]
          : []),
        terms(),
        signatures("Raised By", "Verified By", "Approved By", "Client Acknowledgement"),
      ],
      footerNote: applied
        ? "Stock records were updated on approval. Each serial listed above carries a corresponding stock movement."
        : "This adjustment has NOT been applied to stock. Quantities shown are proposed until approved.",
    }
  )
}

// ---------------------------------------------------------------------------
// Commercial invoice — keyed on an invoice_header id
// ---------------------------------------------------------------------------

/**
 * Indian-numbering amount in words. An invoice without it is not accepted by
 * most finance teams, and the alternative — leaving finance to write it by hand
 * on a system-generated document — defeats the point of generating it.
 */
function amountInWords(value: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen",
  ]
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

  const under100 = (n: number): string =>
    n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`
  const under1000 = (n: number): string =>
    n < 100
      ? under100(n)
      : `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${under100(n % 100)}` : ""}`

  const rupees = Math.floor(Math.abs(value))
  const paise = Math.round((Math.abs(value) - rupees) * 100)
  if (rupees === 0 && paise === 0) return "Zero only"

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const parts: string[] = []
  const groups: Array<[number, string]> = [
    [10000000, "Crore"],
    [100000, "Lakh"],
    [1000, "Thousand"],
  ]
  let rest = rupees
  for (const [divisor, name] of groups) {
    const count = Math.floor(rest / divisor)
    if (count > 0) {
      parts.push(`${under1000(count)} ${name}`)
      rest %= divisor
    }
  }
  if (rest > 0) parts.push(under1000(rest))

  const rupeeWords = parts.join(" ")
  const paiseWords = paise > 0 ? ` and ${under100(paise)} Paise` : ""
  return `${value < 0 ? "Minus " : ""}Rupees ${rupeeWords}${paiseWords} only`
}

/** Indian digit grouping, e.g. 2,79,154.00 — not the Intl default for en-IN money. */
function inr(value: unknown): string {
  const n = num(value)
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function buildCommercialInvoice(
  db: DocumentDBClient,
  companyId: number,
  invoiceId: number
): Promise<DocumentResult> {
  const res = await db.query(
    `SELECT h.id, h.invoice_number, h.status, h.invoice_date, h.due_date, h.created_at,
            h.billing_period, h.period_from, h.period_to, h.currency,
            h.taxable_amount, h.cgst_amount, h.sgst_amount, h.igst_amount,
            h.total_tax_amount, h.grand_total, h.paid_amount, h.balance_amount,
            h.notes, h.client_id,
            c.client_code, c.client_name, c.company_legal_name, c.gst_number,
            c.registered_address, c.city, c.state, c.pincode,
            c.contact_person, c.contact_email, c.contact_phone
     FROM invoice_header h
     JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
     WHERE h.company_id = $1 AND h.id = $2
     LIMIT 1`,
    [companyId, invoiceId]
  )
  if (!res.rows.length) throw new DocumentNotFoundError("Invoice not found")
  const inv = res.rows[0]

  const lines = await db.query(
    `SELECT l.line_no, l.charge_type, l.description, l.uom, l.quantity, l.rate,
            l.amount, l.tax_code, l.gst_rate,
            l.cgst_amount, l.sgst_amount, l.igst_amount, l.gross_amount
     FROM invoice_lines l
     WHERE l.company_id = $1 AND l.invoice_id = $2
     ORDER BY l.line_no ASC`,
    [companyId, invoiceId]
  )

  // Intra-state supply splits into CGST+SGST; inter-state uses IGST. Showing the
  // columns that are all zero would waste a third of the table width.
  const useIgst = num(inv.igst_amount) > 0

  const taxColumns: DocumentColumn[] = useIgst
    ? [{ key: "igst", label: "IGST", width: "9%", align: "right" }]
    : [
        { key: "cgst", label: "CGST", width: "8%", align: "right" },
        { key: "sgst", label: "SGST", width: "8%", align: "right" },
      ]

  const billedTo = [
    str(inv.registered_address, ""),
    str(inv.city, ""),
    str(inv.state, ""),
    str(inv.pincode, ""),
  ]
    .filter(Boolean)
    .join(", ")

  // An invoice belongs to a client, not a warehouse, so the warehouse dimension
  // is explicitly unconstrained. The client scope still gates it.
  return finalize(
    db,
    companyId,
    invoiceId,
    { warehouseId: null, clientId: num(inv.client_id) },
    {
      type: "commercial-invoice",
      title: "Commercial Invoice",
      // Ten columns including the tax split; portrait crowds the description
      // out of readability.
      orientation: "landscape",
      documentNumber: str(inv.invoice_number),
      documentDate: fmtDate(inv.invoice_date ?? inv.created_at),
      warehouseLabel: "",
      status: statusTone(inv.status),
      meta: [
        { label: "Invoice No.", value: str(inv.invoice_number) },
        { label: "Invoice Date", value: fmtDate(inv.invoice_date) },
        { label: "Due Date", value: fmtDate(inv.due_date) },
        { label: "Billing Period", value: str(inv.billing_period) },
        { label: "Currency", value: str(inv.currency, "INR") },
      ],
      sections: [
        {
          kind: "party-cards",
          cards: [
            {
              title: "Billed To",
              fields: [
                {
                  label: "Customer",
                  value: str(inv.company_legal_name, "") || str(inv.client_name),
                },
                { label: "Address", value: billedTo || "-" },
                { label: "GSTIN", value: str(inv.gst_number) },
                { label: "Contact", value: str(inv.contact_email) },
              ],
            },
            {
              title: "Billing Period",
              fields: [
                { label: "From", value: fmtDate(inv.period_from) },
                { label: "To", value: fmtDate(inv.period_to) },
                { label: "Cycle", value: str(inv.billing_period) },
                { label: "Client Code", value: str(inv.client_code) },
              ],
            },
            {
              title: "Payment",
              fields: [
                { label: "Due Date", value: fmtDate(inv.due_date) },
                { label: "Invoice Total", value: `₹ ${inr(inv.grand_total)}` },
                { label: "Paid", value: `₹ ${inr(inv.paid_amount)}` },
                { label: "Balance", value: `₹ ${inr(inv.balance_amount)}` },
              ],
            },
          ],
        },
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Charge Lines", lines.rows.length),
            ...tile("Taxable Value", `₹ ${inr(inv.taxable_amount)}`),
            ...(useIgst
              ? tile("IGST", `₹ ${inr(inv.igst_amount)}`)
              : [
                  ...tile("CGST", `₹ ${inr(inv.cgst_amount)}`),
                  ...tile("SGST", `₹ ${inr(inv.sgst_amount)}`),
                ]),
            ...tile("Invoice Total", `₹ ${inr(inv.grand_total)}`),
            ...tile("Balance Due", `₹ ${inr(inv.balance_amount)}`),
          ],
        },
        {
          kind: "table",
          title: "Charge Details",
          caption: `All amounts in ${str(inv.currency, "INR")} · ${
            useIgst ? "inter-state supply, IGST applicable" : "intra-state supply, CGST + SGST applicable"
          }`,
          emptyText: "No charge lines on this invoice.",
          columns: [
            { key: "line", label: "#", width: "4%", align: "right" },
            { key: "tax_code", label: "HSN / SAC", width: "10%", mono: true },
            { key: "description", label: "Description", width: "30%" },
            { key: "qty", label: "Qty", width: "8%", align: "right" },
            { key: "uom", label: "UOM", width: "6%" },
            { key: "rate", label: "Rate", width: "10%", align: "right" },
            { key: "amount", label: "Taxable Value", width: "12%", align: "right" },
            ...taxColumns,
            { key: "gross", label: "Amount", width: "12%", align: "right" },
          ],
          rows: lines.rows.map((row) => ({
            line: num(row.line_no),
            tax_code: str(row.tax_code),
            description: str(row.description, "") || str(row.charge_type),
            qty: num(row.quantity),
            uom: str(row.uom),
            rate: inr(row.rate),
            amount: inr(row.amount),
            cgst: inr(row.cgst_amount),
            sgst: inr(row.sgst_amount),
            igst: inr(row.igst_amount),
            gross: inr(row.gross_amount),
          })),
          totals: {
            description: `Total — ${lines.rows.length} charge lines`,
            amount: inr(inv.taxable_amount),
            cgst: inr(inv.cgst_amount),
            sgst: inr(inv.sgst_amount),
            igst: inr(inv.igst_amount),
            gross: inr(inv.grand_total),
          },
        },
        {
          kind: "fields",
          title: "Amount in Words",
          columns: 1,
          fields: [{ label: "Invoice Total", value: amountInWords(num(inv.grand_total)) }],
        },
        ...(str(inv.notes, "")
          ? [{ kind: "notes" as const, title: "Notes", text: str(inv.notes) }]
          : []),
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Received By"),
      ],
      footerNote:
        "Payment is due by the date shown above. Please quote the invoice number on all remittances.",
    }
  )
}

// ---------------------------------------------------------------------------
// Dispatch manifest — keyed on an outbound_loads id
//
// SCHEMA NOTE: there is no trip or consolidation entity — outbound_loads is one
// load per DO. A manifest is therefore DERIVED: it shows every load sharing the
// keyed load's vehicle and dispatch date, which is the closest thing to a trip
// the data supports. With today's single-drop data that yields a one-stop
// manifest, and it will show real multi-stop trips the moment operations
// consolidate. A first-class trip entity would be a schema change.
// ---------------------------------------------------------------------------

async function buildDispatchManifest(
  db: DocumentDBClient,
  companyId: number,
  loadId: number
): Promise<DocumentResult> {
  const anchorRes = await db.query(
    `SELECT l.id, l.load_number, l.status, l.vehicle_number, l.driver_name,
            l.driver_phone, l.transport_company, l.loaded_at, l.created_at,
            l.warehouse_id, l.client_id,
            w.warehouse_code, w.warehouse_name,
            u.full_name AS loaded_by_name
     FROM outbound_loads l
     JOIN warehouses w ON w.id = l.warehouse_id AND w.company_id = l.company_id
     LEFT JOIN users u ON u.id = l.loaded_by
     WHERE l.company_id = $1 AND l.id = $2
     LIMIT 1`,
    [companyId, loadId]
  )
  if (!anchorRes.rows.length) throw new DocumentNotFoundError("Load not found")
  const anchor = anchorRes.rows[0]

  // Stops: every load on the same vehicle and dispatch date. Falls back to the
  // anchor load alone when the vehicle is unknown, so the document still prints.
  const stops = await db.query(
    `SELECT l.id, l.load_number, l.status, l.loaded_at,
            dh.do_number, dh.dispatch_date,
            c.client_code, c.client_name, c.city AS client_city, c.state AS client_state,
            dn.delivery_note_number,
            COUNT(lpu.id)::int AS packages,
            COALESCE(SUM(p.gross_weight_kg), 0) AS weight
     FROM outbound_loads l
     JOIN do_header dh ON dh.id = l.do_header_id AND dh.company_id = l.company_id
     JOIN clients c ON c.id = l.client_id AND c.company_id = l.company_id
     LEFT JOIN delivery_note_header dn
       ON dn.load_id = l.id AND dn.company_id = l.company_id
     LEFT JOIN outbound_load_pack_units lpu
       ON lpu.load_id = l.id AND lpu.company_id = l.company_id
     LEFT JOIN do_pack_units p ON p.id = lpu.pack_unit_id AND p.company_id = lpu.company_id
     WHERE l.company_id = $1
       AND l.warehouse_id = $2
       AND (
         l.id = $3
         OR (
           $4::text IS NOT NULL
           AND l.vehicle_number = $4::text
           AND l.loaded_at::date IS NOT DISTINCT FROM $5::date
         )
       )
     GROUP BY l.id, l.load_number, l.status, l.loaded_at, dh.do_number,
              dh.dispatch_date, c.client_code, c.client_name, c.city, c.state,
              dn.delivery_note_number
     ORDER BY l.loaded_at ASC NULLS LAST, l.id ASC`,
    [
      companyId,
      num(anchor.warehouse_id),
      loadId,
      anchor.vehicle_number ?? null,
      anchor.loaded_at ?? null,
    ]
  )

  const totalPackages = stops.rows.reduce((sum, r) => sum + num(r.packages), 0)
  const totalWeight = stops.rows.reduce((sum, r) => sum + num(r.weight), 0)
  const deliveryNotes = stops.rows.filter((r) => str(r.delivery_note_number, "")).length

  return finalize(
    db,
    companyId,
    loadId,
    { warehouseId: num(anchor.warehouse_id), clientId: num(anchor.client_id) },
    {
      type: "dispatch-manifest",
      title: "Dispatch Manifest",
      // A manifest is read in a cab against a route; the stop table needs width.
      orientation: "landscape",
      documentNumber: str(anchor.load_number),
      documentDate: fmtDate(anchor.loaded_at ?? anchor.created_at),
      warehouseLabel: str(anchor.warehouse_code),
      status: statusTone(anchor.status),
      meta: [
        { label: "Manifest No.", value: str(anchor.load_number) },
        { label: "Dispatch Date", value: fmtDate(anchor.loaded_at) },
        { label: "Vehicle No.", value: str(anchor.vehicle_number) },
        { label: "Total Stops", value: String(stops.rows.length) },
        { label: "Dispatched By", value: str(anchor.loaded_by_name) },
      ],
      sections: [
        {
          kind: "party-cards",
          cards: [
            {
              title: "Dispatching Warehouse",
              fields: [
                { label: "Warehouse", value: str(anchor.warehouse_name) },
                { label: "Code", value: str(anchor.warehouse_code) },
                { label: "Loading Completed", value: fmtDateTime(anchor.loaded_at) },
              ],
            },
            {
              title: "Vehicle & Crew",
              fields: [
                { label: "Vehicle No.", value: str(anchor.vehicle_number) },
                { label: "Driver", value: str(anchor.driver_name) },
                { label: "Mobile", value: str(anchor.driver_phone) },
                { label: "Transporter", value: str(anchor.transport_company) },
              ],
            },
          ],
        },
        {
          kind: "summary-tiles",
          tiles: [
            ...tile("Total Stops", stops.rows.length),
            ...tile("Delivery Notes", deliveryNotes),
            ...tile("Total Packages", totalPackages),
            ...tile("Total Weight", totalWeight > 0 ? totalWeight.toFixed(2) : null, "kg"),
          ],
        },
        {
          kind: "table",
          title: "Stop Manifest",
          caption: "Driver must obtain a signed POD at every stop",
          emptyText: "No loads on this manifest.",
          columns: [
            { key: "stop", label: "Stop", width: "6%", align: "right" },
            { key: "do_number", label: "DO No.", width: "16%", mono: true },
            { key: "dn_number", label: "Delivery Note", width: "18%", mono: true },
            { key: "customer", label: "Customer / Destination", width: "32%" },
            { key: "packages", label: "Packages", width: "10%", align: "right" },
            { key: "weight", label: "Weight", width: "10%", align: "right" },
            { key: "status", label: "Status", width: "8%" },
          ],
          rows: stops.rows.map((row, index) => ({
            stop: index + 1,
            do_number: str(row.do_number),
            dn_number: str(row.delivery_note_number),
            customer:
              `${str(row.client_name)}${
                str(row.client_city, "") ? ` · ${str(row.client_city)}` : ""
              }`.trim(),
            packages: num(row.packages),
            weight: num(row.weight) > 0 ? num(row.weight).toFixed(2) : "-",
            status: str(row.status),
          })),
          totals: {
            customer: `Total — ${stops.rows.length} stops`,
            packages: totalPackages,
            weight: totalWeight > 0 ? totalWeight.toFixed(2) : "-",
          },
        },
        terms(),
        signatures("Prepared By", "Checked By", "Authorized By", "Driver Acknowledgement"),
      ],
      footerNote:
        "The driver acknowledges receipt of the consignments listed above and must obtain a signed proof of delivery at each stop.",
    }
  )
}

// ---------------------------------------------------------------------------

/**
 * Partial by design. The EDDS scope names five document types whose builders
 * land in a later phase (GRN migrates off its standalone print page; gate pass,
 * cycle count sheet, dispatch manifest and commercial invoice are new). They are
 * already in DocumentType so branding, verification and the summary lookup can
 * name them; asking for one before its builder exists is a clean 404 rather than
 * a crash.
 */
const BUILDERS: Partial<
  Record<
    DocumentType,
    (db: DocumentDBClient, companyId: number, id: number) => Promise<DocumentResult>
  >
> = {
  "pick-list": buildPickList,
  "packing-list": buildPackingList,
  "goods-issue-note": buildGoodsIssueNote,
  "goods-receipt-note": buildGoodsReceiptNote,
  "delivery-note": buildDeliveryNote,
  "consignment-note": buildConsignmentNote,
  "gate-pass": buildGatePass,
  "cycle-count-sheet": buildCycleCountSheet,
  "stock-transfer-note": buildStockTransferNote,
  "inventory-adjustment-report": buildInventoryAdjustmentReport,
  "dispatch-manifest": buildDispatchManifest,
  "commercial-invoice": buildCommercialInvoice,
  "job-card": buildJobCard,
  "dispatch-note": (db, companyId, id) => buildDoLineDocument(db, companyId, id, "dispatch-note"),
  "packing-slip": (db, companyId, id) => buildDoLineDocument(db, companyId, id, "packing-slip"),
}

/** Document types that can actually be rendered today. */
export function isBuildableDocumentType(type: DocumentType): boolean {
  return typeof BUILDERS[type] === "function"
}

/** What the `[id]` segment refers to, per document type. */
export const DOCUMENT_SUBJECT: Record<
  DocumentType,
  | "wave"
  | "do"
  | "goods-issue"
  | "load"
  | "delivery-note"
  | "grn"
  | "gate-out"
  | "count-plan"
  | "invoice"
  | "stock-transfer"
  | "adjustment"
> = {
  "pick-list": "wave",
  "packing-list": "do",
  "goods-issue-note": "goods-issue",
  "goods-receipt-note": "grn",
  "delivery-note": "delivery-note",
  "consignment-note": "load",
  "gate-pass": "gate-out",
  "cycle-count-sheet": "count-plan",
  "stock-transfer-note": "stock-transfer",
  "inventory-adjustment-report": "adjustment",
  "dispatch-manifest": "load",
  "commercial-invoice": "invoice",
  "job-card": "do",
  "dispatch-note": "do",
  "packing-slip": "do",
}

export async function buildDocument(
  db: DocumentDBClient,
  companyId: number,
  type: DocumentType,
  id: number
): Promise<DocumentResult> {
  const builder = BUILDERS[type]
  if (!builder) {
    throw new DocumentNotFoundError(`Document type '${type}' is not available yet`)
  }
  return builder(db, companyId, id)
}