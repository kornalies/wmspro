/**
 * The document engine's single contract.
 *
 * Before this existed the codebase had four ways to produce a printable
 * document: browser-print pages (GRN, DO list), a hand-rolled PDF byte writer
 * (app/api/do/[id]/download), and client-side jsPDF (lib/export-utils). Adding
 * the six outbound documents on top of that would have meant a fifth. Every
 * document now compiles to this one shape and is rendered by one component.
 *
 * The model is deliberately presentation-agnostic: it carries no JSX and no CSS,
 * only the data and its intended grouping. That is what lets the HTML renderer
 * ship now and a PDF renderer be added later against the same builders.
 */

export type DocumentType =
  | "pick-list"
  | "packing-list"
  | "goods-issue-note"
  | "delivery-note"
  | "consignment-note"
  | "job-card"
  | "dispatch-note"
  | "packing-slip"

export const DOCUMENT_TYPES: DocumentType[] = [
  "pick-list",
  "packing-list",
  "goods-issue-note",
  "delivery-note",
  "consignment-note",
  "job-card",
  "dispatch-note",
  "packing-slip",
]

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as string[]).includes(value)
}

/** Tenant letterhead, read from tenant_settings.ui_branding. */
export type DocumentBranding = {
  companyName: string
  companyCode: string
  logoUrl: string
  /** Hex, e.g. "#0f3f7d". Drives rule lines and table header tint only. */
  primaryColor: string
}

/** A label/value pair in the header meta grid. */
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
}

export type DocumentTable = {
  kind: "table"
  title?: string
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

export type DocumentNotes = {
  kind: "notes"
  title?: string
  text: string
}

/** Ruled boxes for wet signatures — the reason most of these documents exist. */
export type DocumentSignatures = {
  kind: "signatures"
  title?: string
  blocks: Array<{ role: string; name?: string }>
}

export type DocumentSection =
  | DocumentTable
  | DocumentFieldGrid
  | DocumentNotes
  | DocumentSignatures

export type DocumentModel = {
  type: DocumentType
  /** Printed title, e.g. "Delivery Note". */
  title: string
  /** The document's own number, printed large next to the title. */
  documentNumber: string
  /**
   * Status watermark/badge, e.g. CANCELLED. Only set when the status is worth
   * warning a reader about — a normal GENERATED/COMPLETED doc leaves it unset
   * so the page does not shout at the operator.
   */
  statusBadge?: string
  branding: DocumentBranding
  /** The meta grid directly under the letterhead. */
  meta: DocumentField[]
  sections: DocumentSection[]
  /** Small print at the foot of every page. */
  footerNote?: string
}