import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

import { guardPortalProductError, hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.inventory.view"))) {
      return fail("FORBIDDEN", "No portal inventory permission", 403)
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
        ssn.item_id,
        i.item_code,
        i.item_name,
        i.uom,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock_units,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched_units
       FROM stock_serial_numbers ssn
       JOIN items i ON i.id = ssn.item_id
       WHERE ssn.client_id = $1
       GROUP BY ssn.item_id, i.item_code, i.item_name, i.uom
       ORDER BY i.item_name ASC
       LIMIT 500`,
      [clientIdCheck.clientId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch inventory"
    return fail("SERVER_ERROR", message, 500)
  }
}
