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

/**
 * Whether a stock transfer must be approved by someone other than its raiser.
 *
 * Off by default, and that default is a judgement rather than laziness: a
 * single-operator warehouse would be unable to move stock at all if this were
 * forced on, and RBAC already carries the structural half of the control —
 * OPERATOR does not hold `stock.transfer.approve` (migration 075). This flag is
 * for tenants who want the separation enforced even among users who all hold the
 * permission.
 */
export async function getTransferSeparateApprover(
  db: DBClient,
  companyId: number
): Promise<boolean> {
  const result = await db.query(
    `SELECT settings->>'transfer_separate_approver' AS flag FROM companies WHERE id = $1`,
    [companyId]
  )
  return String(result.rows[0]?.flag ?? "").trim().toLowerCase() === "true"
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