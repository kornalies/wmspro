/**
 * Typed reads over companies.settings (JSONB), the per-tenant toggle bag added
 * in migration 057. Every flag must degrade to the pre-existing behaviour when
 * the key is absent, so an untouched tenant behaves exactly as before.
 */

type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export const OUTBOUND_BILLING_TRIGGERS = ["DISPATCH", "GOODS_ISSUE"] as const
export type OutboundBillingTrigger = (typeof OUTBOUND_BILLING_TRIGGERS)[number]

/**
 * When outbound handling revenue is recognised.
 *
 * DISPATCH (default) is what every tenant did before Track A: the dispatch route
 * stages OUTBOUND_HANDLING. GOODS_ISSUE moves recognition earlier, to the goods
 * issue document. Defaulting to DISPATCH is deliberate -- silently re-timing
 * revenue on live contracts is not a migration, it is an incident.
 */
export async function getOutboundBillingTrigger(
  db: DBClient,
  companyId: number
): Promise<OutboundBillingTrigger> {
  const result = await db.query(
    `SELECT settings->>'outbound_billing_trigger' AS trigger
     FROM companies
     WHERE id = $1`,
    [companyId]
  )
  const raw = String(result.rows[0]?.trigger ?? "").trim().toUpperCase()
  return (OUTBOUND_BILLING_TRIGGERS as readonly string[]).includes(raw)
    ? (raw as OutboundBillingTrigger)
    : "DISPATCH"
}