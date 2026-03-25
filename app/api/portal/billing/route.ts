import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission } from "@/lib/policy/guards"

import { hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.billing.view"))) {
      return fail("FORBIDDEN", "No portal billing permission", 403)
    }
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "billing")
    if (policy.permissions.includes("billing.view")) {
      requirePolicyPermission(policy, "billing.view")
    } else {
      requirePolicyPermission(policy, "finance.view")
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const invoices = await query(
      `SELECT
        ih.id,
        ih.invoice_number,
        ih.invoice_date,
        ih.due_date,
        ih.status,
        ih.client_action_status,
        ih.client_action_at,
        COALESCE(ih.currency_code, 'INR') AS currency_code,
        COALESCE(ih.taxable_amount, 0)::numeric AS net_amount,
        COALESCE(ih.total_tax_amount, 0)::numeric AS tax_amount,
        COALESCE(ih.grand_total, 0)::numeric AS total_amount,
        COALESCE(ih.paid_amount, 0)::numeric AS paid_amount,
        COALESCE(ih.balance_amount, 0)::numeric AS balance_amount,
        COALESCE(d.open_disputes, 0)::int AS open_disputes
       FROM invoice_header ih
       LEFT JOIN (
         SELECT invoice_id, COUNT(*) FILTER (WHERE status IN ('OPEN', 'UNDER_REVIEW')) AS open_disputes
         FROM portal_invoice_disputes
         WHERE company_id = $2
         GROUP BY invoice_id
       ) d ON d.invoice_id = ih.id
       WHERE ih.client_id = $1
        ORDER BY ih.invoice_date DESC, ih.id DESC
        LIMIT 200`,
      [clientIdCheck.clientId, session.companyId]
    )

    return ok(invoices.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch billing"
    return fail("SERVER_ERROR", message, 500)
  }
}
