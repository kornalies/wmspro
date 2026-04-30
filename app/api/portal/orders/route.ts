import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { normalizeDOStatus } from "@/lib/do-status"

import { guardPortalProductError, hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.orders.view"))) {
      return fail("FORBIDDEN", "No portal orders permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const result = await query(
      `SELECT
        id,
        do_number,
        request_date,
        dispatch_date,
        status,
        total_items,
        total_quantity_requested,
        total_quantity_dispatched
       FROM do_header
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [clientIdCheck.clientId]
    )

    return ok(
      result.rows.map((row: Record<string, unknown>) => ({
        ...row,
        status: normalizeDOStatus(row.status) || row.status,
      }))
    )
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch orders"
    return fail("SERVER_ERROR", message, 500)
  }
}
