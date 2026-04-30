import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { DO_FULFILLMENT_STATUSES } from "@/lib/do-status"

import { guardPortalProductError, hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.reports.view"))) {
      return fail("FORBIDDEN", "No portal reports permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const [stock, grn, doSummary, billing, disputes, sla] = await Promise.all([
      query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'IN_STOCK')::int AS in_stock_units,
          COUNT(*) FILTER (WHERE status = 'DISPATCHED')::int AS dispatched_units
         FROM stock_serial_numbers
         WHERE client_id = $1`,
        [clientIdCheck.clientId]
      ),
      query(
        `SELECT
          COUNT(*)::int AS total_grn,
          COUNT(*) FILTER (WHERE status IN ('CONFIRMED', 'APPROVED'))::int AS confirmed_grn
         FROM grn_header
         WHERE client_id = $1`,
        [clientIdCheck.clientId]
      ),
      query(
        `SELECT
          COUNT(*)::int AS total_do,
          COUNT(*) FILTER (WHERE status = ANY($2::text[]))::int AS fulfilled_do
         FROM do_header
         WHERE client_id = $1`,
        [clientIdCheck.clientId, DO_FULFILLMENT_STATUSES]
      ),
      query(
        `SELECT
           COUNT(*)::int AS total_invoices,
           COUNT(*) FILTER (WHERE COALESCE(balance_amount, 0) > 0 AND due_date < CURRENT_DATE)::int AS overdue_invoices,
           COALESCE(SUM(COALESCE(grand_total, 0)), 0)::numeric AS total_billed,
           COALESCE(SUM(COALESCE(balance_amount, 0)), 0)::numeric AS outstanding_amount
         FROM invoice_header
         WHERE client_id = $1`,
        [clientIdCheck.clientId]
      ),
      query(
        `SELECT
           COUNT(*)::int AS total_disputes,
           COUNT(*) FILTER (WHERE status IN ('OPEN', 'UNDER_REVIEW'))::int AS open_disputes
         FROM portal_invoice_disputes
         WHERE client_id = $1`,
        [clientIdCheck.clientId]
      ),
      query(
        `WITH policy AS (
           SELECT
             COALESCE(dispatch_target_hours, 48)::numeric AS dispatch_target_hours,
             COALESCE(warning_threshold_pct, 90)::numeric AS warning_threshold_pct
           FROM portal_client_sla_policies
           WHERE client_id = $1
             AND is_active = true
           ORDER BY updated_at DESC
           LIMIT 1
         ),
         base AS (
           SELECT
             dh.id,
             dh.request_date,
             dh.dispatch_date,
             CASE
               WHEN dh.dispatch_date IS NULL THEN false
               WHEN dh.dispatch_date <= (
                 dh.request_date::timestamp + ((SELECT dispatch_target_hours FROM policy) || ' hours')::interval
               ) THEN true
               ELSE false
             END AS on_time
           FROM do_header dh
           WHERE dh.client_id = $1
             AND dh.request_date >= CURRENT_DATE - INTERVAL '90 days'
         )
         SELECT
           COALESCE((SELECT dispatch_target_hours FROM policy), 48)::float8 AS dispatch_target_hours,
           COALESCE((SELECT warning_threshold_pct FROM policy), 90)::float8 AS warning_threshold_pct,
           COUNT(*)::int AS total_orders_90d,
           COUNT(*) FILTER (WHERE on_time = true)::int AS on_time_orders_90d,
           CASE WHEN COUNT(*) = 0 THEN 100
                ELSE ROUND((COUNT(*) FILTER (WHERE on_time = true)::numeric / COUNT(*)::numeric) * 100, 2)
           END::float8 AS on_time_pct
         FROM base`,
        [clientIdCheck.clientId]
      ),
    ])

    return ok({
      stock: stock.rows[0] || {},
      grn: grn.rows[0] || {},
      orders: doSummary.rows[0] || {},
      billing: billing.rows[0] || {},
      disputes: disputes.rows[0] || {},
      sla: sla.rows[0] || {},
    })
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch report summary"
    return fail("SERVER_ERROR", message, 500)
  }
}
