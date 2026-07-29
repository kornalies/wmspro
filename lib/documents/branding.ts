/**
 * Tenant letterhead for printed documents.
 *
 * The hand-rolled PDF route this engine replaces read logo and colour from
 * tenant_settings.ui_branding, and clients notice when their logo disappears
 * off a delivery note, so that behaviour is preserved rather than reinvented.
 */

import type { DocumentBranding } from "@/lib/documents/types"

export type DocumentDBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

const DEFAULT_PRIMARY = "#0f3f7d"

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

export async function loadBranding(
  db: DocumentDBClient,
  companyId: number
): Promise<DocumentBranding> {
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
    companyName: String(row.company_name || "GWU WMS"),
    companyCode: String(row.company_code || ""),
    logoUrl: String(branding.logoUrl || ""),
    primaryColor: normalizeHex(branding.primaryColor, DEFAULT_PRIMARY),
  }
}