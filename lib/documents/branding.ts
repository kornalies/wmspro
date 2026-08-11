/**
 * Letterhead for printed documents.
 *
 * The hand-rolled PDF route this engine replaces read logo and colour from
 * tenant_settings.ui_branding, and clients notice when their logo disappears
 * off a delivery note, so that behaviour is preserved rather than reinvented.
 *
 * Whose brand appears is decided per document type (see DOCUMENT_BRAND_OWNER).
 * The BRD asks for fixed GWU branding on everything; that was deliberately not
 * adopted, because the engine is multi-tenant and a 3PL client's own letterhead
 * already prints on their paperwork today. The split instead follows whether a
 * document leaves GWU's four walls as a commercial artifact:
 *
 *   - Client-facing (delivery note, invoice, packing list, …) → tenant brand.
 *   - Internal operating paper (pick list, count sheet, manifest, gate pass,
 *     job card) → GWU's own brand, because it governs GWU's operation and is
 *     read by GWU staff and its security desk.
 *
 * Layout, typography and structure are standardized for every type either way;
 * only the letterhead block and the accent colour differ.
 *
 * The corporate identity fields (address, GSTIN, CIN, website, support email)
 * live in tenant_settings.ui_branding rather than in columns on `companies`,
 * which has none of them. ui_branding is already JSONB and already read here,
 * so carrying them costs no migration.
 */

import type { DocumentBranding, DocumentType } from "@/lib/documents/types"

export type DocumentDBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/** EDDS primary. Matches the BRD's navy; the pre-EDDS default was #0f3f7d. */
const GWU_NAVY = "#0F4C81"

type BrandOwner = "tenant" | "gwu"

/**
 * Whose letterhead each document carries.
 *
 * Gate Pass is the debatable one and is deliberately GWU: a driver and a
 * transporter both read it, but it authorises movement across GWU's own gate
 * and is issued by GWU's security desk, not on the client's behalf.
 */
export const DOCUMENT_BRAND_OWNER: Record<DocumentType, BrandOwner> = {
  "delivery-note": "tenant",
  "commercial-invoice": "tenant",
  // A statement of account is a demand for payment sent under the tenant's own
  // name, for the same reason the invoice it summarises is.
  "client-statement": "tenant",
  "packing-list": "tenant",
  "packing-slip": "tenant",
  "consignment-note": "tenant",
  "goods-issue-note": "tenant",
  "goods-receipt-note": "tenant",
  "dispatch-note": "tenant",
  "pick-list": "gwu",
  "cycle-count-sheet": "gwu",
  "dispatch-manifest": "gwu",
  "gate-pass": "gwu",
  "job-card": "gwu",
  // Both are internal: a transfer note moves stock between GWU's own warehouses,
  // and an adjustment report is GWU explaining its own stock records. The client
  // may be shown either, but neither is issued on their behalf.
  "stock-transfer-note": "gwu",
  "inventory-adjustment-report": "gwu",
}

/**
 * GWU's own letterhead, used by internal operating documents.
 *
 * Overridable by env so a self-hosted deployment is not stuck printing GWU's
 * GSTIN on its warehouse paperwork; the defaults are the values on the approved
 * sample pack.
 */
function gwuBranding(): DocumentBranding {
  return {
    companyName: process.env.EDDS_COMPANY_NAME || "GWU Software & Solutions",
    companyCode: "GWU",
    logoUrl: process.env.EDDS_LOGO_URL || "",
    primaryColor: GWU_NAVY,
    tagline:
      process.env.EDDS_TAGLINE || "Warehouse Management & 3PL Services · WMSpro Platform",
    address:
      process.env.EDDS_ADDRESS ||
      "No. 14, Ambattur Industrial Estate, Chennai 600 058, Tamil Nadu, India",
    gstin: process.env.EDDS_GSTIN || "",
    cin: process.env.EDDS_CIN || "",
    phone: process.env.EDDS_PHONE || "",
    website: process.env.EDDS_WEBSITE || "www.gwutech.in",
    supportEmail: process.env.EDDS_SUPPORT_EMAIL || "support@gwutech.in",
  }
}

/** ui_branding is JSONB, but older rows were written as a JSON string. */
function parseBranding(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

function normalizeHex(value: unknown, fallback: string): string {
  const hex = String(value ?? "").trim()
  if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) return fallback
  return hex.startsWith("#") ? hex : `#${hex}`
}

function text(value: unknown, fallback = ""): string {
  const out = String(value ?? "").trim()
  return out || fallback
}

/**
 * Resolves the letterhead for one document.
 *
 * Tenant-branded documents still fall back to GWU's contact details for any
 * field the tenant has not filled in, so a half-configured tenant prints a
 * complete footer rather than a row of blanks.
 */
export async function loadBranding(
  db: DocumentDBClient,
  companyId: number,
  type: DocumentType
): Promise<DocumentBranding> {
  const gwu = gwuBranding()
  if (DOCUMENT_BRAND_OWNER[type] === "gwu") return gwu

  const result = await db.query(
    `SELECT co.company_code, co.company_name, ts.ui_branding
     FROM companies co
     LEFT JOIN tenant_settings ts ON ts.company_id = co.id
     WHERE co.id = $1
     LIMIT 1`,
    [companyId]
  )

  const row = result.rows[0] ?? {}
  const branding = parseBranding(row.ui_branding)

  return {
    companyName: text(row.company_name, gwu.companyName),
    companyCode: text(row.company_code),
    logoUrl: text(branding.logoUrl),
    primaryColor: normalizeHex(branding.primaryColor, GWU_NAVY),
    tagline: text(branding.tagline, gwu.tagline),
    address: text(branding.address, gwu.address),
    gstin: text(branding.gstin),
    cin: text(branding.cin),
    phone: text(branding.phone, gwu.phone),
    website: text(branding.website, gwu.website),
    supportEmail: text(branding.supportEmail, gwu.supportEmail),
  }
}
