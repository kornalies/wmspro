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

    // Expiry banding is computed in SQL rather than in the browser so that
    // "expires within 30 days" means the same thing on every screen and in any
    // future export. A batch on hold is the one a client most needs to know
    // about -- it is physically present and cannot be allocated (see
    // stock_batch_status), so counting it as available would be a lie.
    const result = await query(
      `SELECT
        ssn.item_id,
        i.item_code,
        i.item_name,
        i.uom,
        COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK')::int AS in_stock_units,
        COUNT(*) FILTER (WHERE ssn.status = 'DISPATCHED')::int AS dispatched_units,
        COUNT(*) FILTER (
          WHERE ssn.status = 'IN_STOCK' AND sbs.status = 'HOLD'
        )::int AS held_units,
        COUNT(*) FILTER (
          WHERE ssn.status = 'IN_STOCK'
            AND ssn.expiry_date IS NOT NULL
            AND ssn.expiry_date < CURRENT_DATE
        )::int AS expired_units,
        COUNT(*) FILTER (
          WHERE ssn.status = 'IN_STOCK'
            AND ssn.expiry_date IS NOT NULL
            AND ssn.expiry_date >= CURRENT_DATE
            AND ssn.expiry_date < CURRENT_DATE + INTERVAL '30 days'
        )::int AS expiring_30d_units,
        COUNT(DISTINCT ssn.batch_number) FILTER (
          WHERE ssn.status = 'IN_STOCK' AND ssn.batch_number IS NOT NULL
        )::int AS batch_count,
        MIN(ssn.expiry_date) FILTER (WHERE ssn.status = 'IN_STOCK') AS earliest_expiry,
        MIN(ssn.received_date) FILTER (WHERE ssn.status = 'IN_STOCK') AS oldest_received
       FROM stock_serial_numbers ssn
       JOIN items i ON i.id = ssn.item_id
       LEFT JOIN stock_batch_status sbs
         ON sbs.client_id = ssn.client_id
        AND sbs.item_id = ssn.item_id
        AND sbs.batch_number = ssn.batch_number
        AND sbs.status = 'HOLD'
       WHERE ssn.client_id = $1
       GROUP BY ssn.item_id, i.item_code, i.item_name, i.uom
       ORDER BY i.item_name ASC
       LIMIT 500`,
      [clientIdCheck.clientId]
    )

    // available = on hand minus what a hold has taken out of play. Derived here
    // rather than in the UI so the two numbers can never disagree.
    return ok(
      result.rows.map((row: Record<string, unknown>) => ({
        ...row,
        available_units: Math.max(Number(row.in_stock_units ?? 0) - Number(row.held_units ?? 0), 0),
      }))
    )
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch inventory"
    return fail("SERVER_ERROR", message, 500)
  }
}
