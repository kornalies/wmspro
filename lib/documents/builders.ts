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
import type {
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
  scope: { warehouseId: number; clientId: number }
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

/** Only badge a status a reader needs warning about; normal states stay quiet. */
function badgeFor(status: unknown): string | undefined {
  const normalized = String(status ?? "").toUpperCase()
  return normalized === "CANCELLED" || normalized === "VOID" ? normalized : undefined
}

function signatures(...roles: string[]): DocumentSection {
  return { kind: "signatures", blocks: roles.map((role) => ({ role })) }
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

function partyFields(doRow: Row) {
  return [
    { label: "Client", value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() },
    { label: "GSTIN", value: str(doRow.gst_number) },
    {
      label: "Ship From",
      value: [str(doRow.warehouse_name, ""), str(doRow.warehouse_city, ""), str(doRow.warehouse_state, "")]
        .filter(Boolean)
        .join(", ") || "-",
    },
    {
      label: "Ship To",
      value: [str(doRow.client_address, ""), str(doRow.client_city, ""), str(doRow.client_state, "")]
        .filter(Boolean)
        .join(", ") || "-",
    },
  ]
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

  const branding = await loadBranding(db, companyId)
  const totalRequired = tasks.rows.reduce((sum, r) => sum + num(r.required_quantity), 0)

  return {
    scope: { warehouseId: num(wave.warehouse_id), clientId: num(wave.client_id) },
    model: {
      type: "pick-list",
      title: "Pick List",
      documentNumber: str(wave.wave_number),
      statusBadge: badgeFor(wave.status),
      branding,
      meta: [
        { label: "Wave", value: str(wave.wave_number) },
        { label: "Strategy", value: str(wave.strategy) },
        { label: "Status", value: str(wave.status) },
        { label: "Released", value: fmtDateTime(wave.released_at) },
        { label: "Client", value: `${str(wave.client_code, "")} ${str(wave.client_name)}`.trim() },
        { label: "Warehouse", value: str(wave.warehouse_name) },
        { label: "Orders", value: String(num(wave.total_orders)) },
        { label: "Tasks", value: String(num(wave.total_tasks)) },
      ],
      sections: [
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
          totals: { item_name: "Total", required: totalRequired },
        },
        signatures("Picked By", "Checked By", "Supervisor"),
      ],
      footerNote: "Pick in sequence. Report shortages to the supervisor before closing the wave.",
    },
  }
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
  const branding = await loadBranding(db, companyId)

  const unitIds = new Set(contents.map((r) => num(r.id)))
  const totalQty = contents.reduce((sum, r) => sum + num(r.serial_count), 0)
  const totalWeight = [...unitIds].reduce((sum, id) => {
    const first = contents.find((r) => num(r.id) === id)
    return sum + num(first?.gross_weight_kg)
  }, 0)

  return {
    scope: { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    model: {
      type: "packing-list",
      title: "Packing List",
      documentNumber: str(doRow.do_number),
      statusBadge: badgeFor(doRow.status),
      branding,
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "DO Status", value: str(doRow.status) },
        { label: "Request Date", value: fmtDate(doRow.request_date) },
        { label: "Expected Dispatch", value: fmtDate(doRow.expected_dispatch_date) },
        { label: "Pack Units", value: String(unitIds.size) },
        { label: "Total Pieces", value: String(totalQty) },
      ],
      sections: [
        { kind: "fields", title: "Parties", fields: partyFields(doRow), columns: 2 },
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
        signatures("Packed By", "Verified By"),
      ],
      footerNote: "Contents are declared per pack unit. Any discrepancy must be noted before loading.",
    },
  }
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

  const branding = await loadBranding(db, companyId)

  return {
    scope: { warehouseId: num(gi.warehouse_id), clientId: num(gi.client_id) },
    model: {
      type: "goods-issue-note",
      title: "Goods Issue Note",
      documentNumber: str(gi.gi_number),
      statusBadge: badgeFor(gi.status),
      branding,
      meta: [
        { label: "GI Number", value: str(gi.gi_number) },
        { label: "Issued At", value: fmtDateTime(gi.issued_at) },
        { label: "Issued By", value: str(gi.issued_by_name) },
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Pack Units", value: String(num(gi.total_pack_units)) },
        { label: "Total Quantity", value: String(num(gi.total_quantity)) },
      ],
      sections: [
        { kind: "fields", title: "Parties", fields: partyFields(doRow), columns: 2 },
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
        signatures("Issued By", "Received By (Client)"),
      ],
      footerNote:
        "Goods are issued out of the client's stock account. Physical movement is covered by the delivery note.",
    },
  }
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
            l.loading_bay, l.loaded_at, l.do_header_id, l.goods_issue_id,
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

  const branding = await loadBranding(db, companyId)
  const totalQty = units.rows.reduce((sum, r) => sum + num(r.quantity), 0)
  const totalWeight = units.rows.reduce((sum, r) => sum + num(r.gross_weight_kg), 0)

  return {
    scope: { warehouseId: num(load.warehouse_id), clientId: num(load.client_id) },
    model: {
      type: "consignment-note",
      title: "Truck Consignment Note",
      documentNumber: str(load.load_number),
      statusBadge: badgeFor(load.status),
      branding,
      meta: [
        { label: "Load Number", value: str(load.load_number) },
        { label: "Status", value: str(load.status) },
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Goods Issue", value: str(load.gi_number) },
        { label: "Loaded At", value: fmtDateTime(load.loaded_at) },
        { label: "Loaded By", value: str(load.loaded_by_name) },
      ],
      sections: [
        { kind: "fields", title: "Consignor / Consignee", fields: partyFields(doRow), columns: 2 },
        {
          kind: "fields",
          title: "Vehicle",
          columns: 3,
          fields: [
            { label: "Vehicle No.", value: str(load.vehicle_number) },
            { label: "Container No.", value: str(load.container_number) },
            { label: "Seal No.", value: str(load.seal_number) },
            { label: "Transporter", value: str(load.transport_company) },
            { label: "Driver", value: str(load.driver_name) },
            { label: "Driver Phone", value: str(load.driver_phone) },
            { label: "Loading Bay", value: str(load.loading_bay) },
            { label: "Pack Units", value: String(units.rows.length) },
            { label: "Gross Weight", value: totalWeight > 0 ? `${totalWeight.toFixed(3)} kg` : "-" },
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
        signatures("Dispatched By", "Driver", "Security Gate"),
      ],
      footerNote:
        "Received the above consignment in good order and condition. Driver's signature acknowledges the pack unit count.",
    },
  }
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
            dn.finalized_at, dn.remarks, dn.do_header_id, dn.load_id,
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

  const lines = await db.query(
    `SELECT dnl.quantity, dli.line_number, dli.uom,
            i.item_code, i.item_name, i.hsn_code
     FROM delivery_note_lines dnl
     JOIN do_line_items dli ON dli.id = dnl.do_line_item_id AND dli.company_id = dnl.company_id
     JOIN items i ON i.id = dnl.item_id AND i.company_id = dnl.company_id
     WHERE dnl.company_id = $1 AND dnl.delivery_note_id = $2
     ORDER BY dli.line_number ASC`,
    [companyId, dnId]
  )

  const branding = await loadBranding(db, companyId)
  const totalQty = lines.rows.reduce((sum, r) => sum + num(r.quantity), 0)

  return {
    scope: { warehouseId: num(dn.warehouse_id), clientId: num(dn.client_id) },
    model: {
      type: "delivery-note",
      title: "Delivery Note",
      documentNumber: str(dn.delivery_note_number),
      statusBadge: badgeFor(dn.status),
      branding,
      meta: [
        { label: "DN Number", value: str(dn.delivery_note_number) },
        { label: "Status", value: str(dn.status) },
        { label: "Finalized At", value: fmtDateTime(dn.finalized_at) },
        { label: "Finalized By", value: str(dn.finalized_by_name) },
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Load", value: str(dn.load_number) },
        { label: "Vehicle", value: str(dn.vehicle_number) },
        { label: "Transporter", value: str(dn.transport_company) },
      ],
      sections: [
        { kind: "fields", title: "Parties", fields: partyFields(doRow), columns: 2 },
        {
          kind: "table",
          title: "Delivered Items",
          emptyText: "No lines on this delivery note.",
          columns: [
            { key: "line", label: "#", width: "6%", align: "right" },
            { key: "item_code", label: "Item Code", width: "18%" },
            { key: "item_name", label: "Description", width: "38%" },
            { key: "hsn", label: "HSN", width: "12%" },
            { key: "qty", label: "Quantity", width: "14%", align: "right" },
            { key: "uom", label: "UOM", width: "12%" },
          ],
          rows: lines.rows.map((row) => ({
            line: num(row.line_number),
            item_code: str(row.item_code),
            item_name: str(row.item_name),
            hsn: str(row.hsn_code),
            qty: num(row.quantity),
            uom: str(row.uom),
          })),
          totals: { item_name: "Total", qty: totalQty },
        },
        ...(str(dn.remarks, "") ? [{ kind: "notes" as const, title: "Remarks", text: str(dn.remarks) }] : []),
        signatures("Dispatched By", "Driver", "Received By (Client)"),
      ],
      footerNote:
        "Goods once delivered are checked and accepted by the consignee. Claims must be raised within 24 hours of delivery.",
    },
  }
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
  const branding = await loadBranding(db, companyId)

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

  return {
    scope: { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    model: {
      type: "job-card",
      title: "Job Card",
      documentNumber: str(doRow.do_number),
      statusBadge: badgeFor(doRow.status),
      branding,
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Status", value: str(doRow.status) },
        { label: "Client", value: `${str(doRow.client_code, "")} ${str(doRow.client_name)}`.trim() },
        { label: "Warehouse", value: str(doRow.warehouse_name) },
        { label: "Request Date", value: fmtDate(doRow.request_date) },
        { label: "Dispatch Date", value: fmtDate(doRow.dispatch_date) },
      ],
      sections: [
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
        signatures("Operator", "Supervisor", "Client Representative"),
      ],
      footerNote: "Billable handling time is taken from this card. Confirm start/end times before signing.",
    },
  }
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
  const branding = await loadBranding(db, companyId)
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

  return {
    scope: { warehouseId: num(doRow.warehouse_id), clientId: num(doRow.client_id) },
    model: {
      type,
      title: isPackingSlip ? "Packing Slip" : "Dispatch Note",
      documentNumber: str(doRow.do_number),
      statusBadge: badgeFor(doRow.status),
      branding,
      meta: [
        { label: "DO Number", value: str(doRow.do_number) },
        { label: "Status", value: str(doRow.status) },
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
        { kind: "fields", title: "Parties", fields: partyFields(doRow), columns: 2 },
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
        isPackingSlip
          ? signatures("Packed By", "Checked By")
          : signatures("Dispatched By", "Driver", "Received By"),
      ],
    },
  }
}

// ---------------------------------------------------------------------------

const BUILDERS: Record<
  DocumentType,
  (db: DocumentDBClient, companyId: number, id: number) => Promise<DocumentResult>
> = {
  "pick-list": buildPickList,
  "packing-list": buildPackingList,
  "goods-issue-note": buildGoodsIssueNote,
  "delivery-note": buildDeliveryNote,
  "consignment-note": buildConsignmentNote,
  "job-card": buildJobCard,
  "dispatch-note": (db, companyId, id) => buildDoLineDocument(db, companyId, id, "dispatch-note"),
  "packing-slip": (db, companyId, id) => buildDoLineDocument(db, companyId, id, "packing-slip"),
}

/** What the `[id]` segment refers to, per document type. */
export const DOCUMENT_SUBJECT: Record<DocumentType, "wave" | "do" | "goods-issue" | "load" | "delivery-note"> = {
  "pick-list": "wave",
  "packing-list": "do",
  "goods-issue-note": "goods-issue",
  "delivery-note": "delivery-note",
  "consignment-note": "load",
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
  return BUILDERS[type](db, companyId, id)
}