/**
 * The document engine's single contract.
 *
 * Before this existed the codebase had three ways to produce a printable
 * document: browser-print pages (GRN, DO list), a hand-rolled PDF byte writer
 * that emitted raw PDF operators (since retired), and client-side jsPDF
 * (lib/export-utils, still used for tabular report exports). Adding the six
 * outbound documents on top of that would have meant a fourth. Every document
 * now compiles to this one shape and is rendered by one component.
 *
 * The model is deliberately presentation-agnostic: it carries no JSX and no CSS,
 * only the data and its intended grouping. That is what lets the HTML renderer
 * ship now and a PDF renderer be added later against the same builders.
 *
 * Shapes here follow the GWU Enterprise Document Design Standard (EDDS), which
 * maps to the Document Management BRD v1.0 functional requirements. FR numbers
 * are cited on the fields they satisfy so a future reader can trace them back.
 */

export type DocumentType =
  | "pick-list"
  | "packing-list"
  | "goods-issue-note"
  | "goods-receipt-note"
  | "delivery-note"
  | "consignment-note"
  | "gate-pass"
  | "cycle-count-sheet"
  | "dispatch-manifest"
  | "commercial-invoice"
  | "job-card"
  | "dispatch-note"
  | "packing-slip"
  | "stock-transfer-note"
  | "inventory-adjustment-report"

export const DOCUMENT_TYPES: DocumentType[] = [
  "pick-list",
  "packing-list",
  "goods-issue-note",
  "goods-receipt-note",
  "delivery-note",
  "consignment-note",
  "gate-pass",
  "cycle-count-sheet",
  "dispatch-manifest",
  "commercial-invoice",
  "job-card",
  "dispatch-note",
  "packing-slip",
  "stock-transfer-note",
  "inventory-adjustment-report",
]

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as string[]).includes(value)
}

/** Template revision, printed in the footer (FR-08) so a reader can tell two
 *  printings of the same document apart when the layout changes under them. */
export const EDDS_TEMPLATE_VERSION = "EDDS v1.0"

/**
 * Letterhead for printed documents.
 *
 * Client-facing documents carry the tenant's own letterhead; internal operating
 * documents carry GWU's. Which applies is decided per document type in
 * lib/documents/branding.ts, so by the time a model reaches the renderer this is
 * already resolved and the renderer never asks whose brand it is drawing.
 */
export type DocumentBranding = {
  companyName: string
  companyCode: string
  logoUrl: string
  /** Hex, e.g. "#0F4C81". Drives rule lines, tile borders and table header tint. */
  primaryColor: string
  /** Strapline under the company name, e.g. "Warehouse Management & 3PL Services". */
  tagline: string
  /** Registered address, printed as one line under the company name (FR-01). */
  address: string
  gstin: string
  cin: string
  phone: string
  website: string
  supportEmail: string
}

/** A label/value pair in the header meta grid or a party card. */
export type DocumentField = {
  label: string
  value: string
}

export type DocumentColumn = {
  key: string
  label: string
  /** Percentage width, e.g. "12%". Columns without one share the remainder. */
  width?: string
  align?: "left" | "right" | "center"
  /** Render in the mono face — reference numbers, codes, serial ranges. */
  mono?: boolean
}

export type DocumentTable = {
  kind: "table"
  title?: string
  /** Right-aligned note above the table, e.g. "Quantities in dispatch UOM". */
  caption?: string
  columns: DocumentColumn[]
  rows: Array<Record<string, string | number | null | undefined>>
  /** Rendered as a bold summary row under the body. */
  totals?: Record<string, string | number | null | undefined>
  /** Shown in place of the table body when rows is empty. */
  emptyText?: string
}

/** A label/value block, e.g. vehicle details on a consignment note. */
export type DocumentFieldGrid = {
  kind: "fields"
  title?: string
  fields: DocumentField[]
  /** Fields per row. Defaults to 2. */
  columns?: 1 | 2 | 3
}

/**
 * The Ship From / Ship To / Transport Details row (FR-04).
 *
 * Distinct from a plain field grid because each party is a titled card with its
 * own heading bar — the layout a consignee scans first when a truck arrives.
 * Two or three cards; more than three stops being readable at A4 width.
 */
export type DocumentPartyCards = {
  kind: "party-cards"
  cards: Array<{ title: string; fields: DocumentField[] }>
}

/**
 * The operational summary tile row (FR-06) — total line items, quantity, gross
 * and net weight, packages, volume. Values are pre-formatted by the builder
 * because only the builder knows the unit and precision that make sense.
 */
export type DocumentSummaryTiles = {
  kind: "summary-tiles"
  tiles: Array<{ label: string; value: string; unit?: string }>
}

export type DocumentNotes = {
  kind: "notes"
  title?: string
  text: string
}

/** Terms printed above the signature row; numbered and set in two columns. */
export type DocumentTerms = {
  kind: "terms"
  title?: string
  items: string[]
}

/**
 * Ruled boxes for wet signatures — the reason most of these documents exist.
 * Each block prints Name / Designation / Date sub-labels (FR-07).
 */
export type DocumentSignatures = {
  kind: "signatures"
  title?: string
  blocks: Array<{ role: string; name?: string }>
}

export type DocumentSection =
  | DocumentTable
  | DocumentFieldGrid
  | DocumentPartyCards
  | DocumentSummaryTiles
  | DocumentNotes
  | DocumentTerms
  | DocumentSignatures

/**
 * The six statuses the BRD requires colour-coding for (FR-02).
 *
 * Builders map their own vocabulary onto these — a DO's GENERATED and a wave's
 * RELEASED both read as "approved" to someone holding the paper, and the tone
 * is what drives the colour. `statusTone` in this file does the mapping.
 */
export type DocumentStatusTone =
  | "pending"
  | "approved"
  | "completed"
  | "in-transit"
  | "cancelled"
  | "draft"

export type DocumentStatus = {
  /** Printed on the badge, e.g. "IN TRANSIT". */
  label: string
  tone: DocumentStatusTone
}

/** Statuses that mean the paper in someone's hand must not be acted on. These
 *  also print a diagonal watermark across the sheet. */
const WATERMARK_TONES: DocumentStatusTone[] = ["cancelled", "draft"]

export function shouldWatermark(status: DocumentStatus | undefined): boolean {
  return !!status && WATERMARK_TONES.includes(status.tone)
}

/**
 * Maps a raw DB status onto a display status. Unknown values fall through to
 * "pending" rather than throwing, because a document that fails to render is
 * worse on a loading bay than one with a conservative badge.
 */
export function statusTone(raw: unknown): DocumentStatus {
  const label = String(raw ?? "").trim().toUpperCase().replace(/_/g, " ")
  if (!label) return { label: "PENDING", tone: "pending" }

  const map: Array<[RegExp, DocumentStatusTone]> = [
    [/^(CANCELLED|CANCELED|VOID|REVERSED|REJECTED)$/, "cancelled"],
    [/^(DRAFT|NEW|PLANNED)$/, "draft"],
    [/^(IN TRANSIT|DISPATCHED|SHIPPED|LOADED|OUT FOR DELIVERY)$/, "in-transit"],
    [/^(COMPLETED|COMPLETE|DELIVERED|CLOSED|FINALIZED|PAID|PICKED|PACKED)$/, "completed"],
    [/^(APPROVED|RELEASED|GENERATED|CONFIRMED|ACTIVE|OPEN|ISSUED)$/, "approved"],
    [/^(PENDING|IN PROGRESS|PARTIAL|AWAITING|SUBMITTED|UNPAID)$/, "pending"],
  ]
  for (const [pattern, tone] of map) {
    if (pattern.test(label)) return { label, tone }
  }
  return { label, tone: "pending" }
}

/** QR payload for digital verification (FR-09). The token is opaque and signed;
 *  see lib/documents/verify.ts for what it resolves to. */
export type DocumentQr = {
  /** PNG data: URI. Inlined rather than linked because proxy.ts sets
   *  img-src 'self' data: blob:, and because a printed page has no network. */
  dataUri: string
  /** The URL encoded in the QR, printed small beneath it for manual entry. */
  url: string
}

export type DocumentModel = {
  type: DocumentType
  /** Printed title, e.g. "Delivery Note". */
  title: string
  /** The document's own number, printed large next to the title. */
  documentNumber: string
  /** The document's own date, printed under the number (FR-01). */
  documentDate: string
  /** Warehouse the document belongs to, printed in the header (FR-01). */
  warehouseLabel: string
  /** Colour-coded badge (FR-02). Always present — every document has a state. */
  status: DocumentStatus
  branding: DocumentBranding
  /** The meta grid directly under the letterhead (FR-03). */
  meta: DocumentField[]
  sections: DocumentSection[]
  /** Digital verification (FR-09). Absent when token signing is unconfigured. */
  qr?: DocumentQr
  /**
   * Page orientation (FR-10). Portrait unless the document's table is genuinely
   * too wide for it — a commercial invoice with HSN, qty, rate, taxable value,
   * CGST, SGST and amount, or a manifest with a stop per row, both crowd at A4
   * portrait. Landscape is a per-document-type decision made in the builder, not
   * something the reader chooses, so the same document always prints the same.
   */
  orientation?: "portrait" | "landscape"
  /** ISO timestamp the model was built, printed in the footer (FR-08). */
  printedAt: string
  /** Small print at the foot of every page. */
  footerNote?: string
}
