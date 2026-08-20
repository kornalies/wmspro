import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

import {
  guardPortalProductError,
  hasPortalFeaturePermission,
  parseAndAuthorizeClientId,
} from "@/app/api/portal/_utils"

/**
 * The items a client is allowed to name on an ASN request.
 *
 * Deliberately NOT the tenant's whole item master. `items` is scoped to the
 * company, not the client (there is no items.client_id), so a 3PL's catalogue
 * holds every client's SKUs side by side -- handing that list to the portal
 * would show one client their competitor's product names and codes. Instead
 * this returns only items the client already has a relationship with: units in
 * stock, a past receipt, or a previous announcement.
 *
 * The cost is that a client cannot announce a SKU that has never been through
 * the warehouse. That is the correct failure: the tenant has to create the item
 * before it can be received anyway, and grn_line_items.item_id is NOT NULL, so
 * letting the client invent one here would only move the dead end later.
 * The portal page says so rather than showing an unexplained empty dropdown.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    // Announcing a shipment is the only thing this list feeds, so it rides on
    // the same grant rather than introducing a key an admin would have to know
    // to switch on separately.
    if (!(await hasPortalFeaturePermission(session, "portal.asn.view"))) {
      return fail("FORBIDDEN", "No portal ASN view permission", 403)
    }

    const url = new URL(request.url)
    const clientIdCheck = await parseAndAuthorizeClientId(session, url.searchParams.get("client_id"))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const search = String(url.searchParams.get("search") || "").trim()
    const params: Array<string | number> = [session.companyId, clientIdCheck.clientId]
    let searchClause = ""
    if (search) {
      params.push(`%${search}%`)
      searchClause = `AND (i.item_code ILIKE $3 OR i.item_name ILIKE $3)`
    }

    const result = await query(
      `SELECT i.id, i.item_code, i.item_name, i.uom,
              i.is_batch_tracked, i.is_expiry_tracked
       FROM items i
       WHERE i.company_id = $1
         AND i.is_active = true
         AND (
           EXISTS (
             SELECT 1 FROM stock_serial_numbers ssn
             WHERE ssn.item_id = i.id
               AND ssn.company_id = i.company_id
               AND ssn.client_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM grn_line_items gli
             JOIN grn_header gh ON gh.id = gli.grn_header_id AND gh.company_id = gli.company_id
             WHERE gli.item_id = i.id
               AND gli.company_id = i.company_id
               AND gh.client_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM client_portal_asn_lines al
             JOIN client_portal_asn_requests ar
               ON ar.id = al.asn_request_id AND ar.company_id = al.company_id
             WHERE al.item_id = i.id
               AND al.company_id = i.company_id
               AND ar.client_id = $2
           )
         )
         ${searchClause}
       ORDER BY i.item_name ASC
       LIMIT 500`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch items"
    return fail("SERVER_ERROR", message, 500)
  }
}
