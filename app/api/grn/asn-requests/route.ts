import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, paginated } from "@/lib/api-response"
import { query } from "@/lib/db"
import { buildOrderBy, type SortColumnMap } from "@/lib/api-sort"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { ASN_OPEN_STATUSES, ASN_STATUSES, canReviewAsn } from "@/lib/asn"

/**
 * The warehouse-side queue of client shipment announcements.
 *
 * This is the screen whose absence made the portal's ASN feature pointless: a
 * client could submit a request, and nothing in the operator's product ever
 * showed it to them. Gated on grn.manage rather than a new permission -- the
 * only thing you can do from here is start a receipt, which is exactly what
 * that permission already means.
 */
const ASN_SORT_COLUMNS: SortColumnMap = {
  request_number: "r.request_number",
  client_name: "c.client_name",
  expected_date: "r.expected_date",
  status: "r.status",
  created_at: "r.created_at",
  line_count: "line_count",
  expected_quantity: "expected_quantity",
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    // An explicit 403 rather than requirePermission(), which throws a bare
    // Error and lands in the catch below as a 500. A portal client hitting this
    // route is denied either way, but "server error" tells them -- and us --
    // the wrong thing about why.
    if (!canReviewAsn(session)) {
      return fail("FORBIDDEN", "Insufficient permissions", 403)
    }

    const { searchParams } = new URL(request.url)
    const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1)
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100)
    const offset = (page - 1) * limit

    const conditions: string[] = ["r.company_id = $1"]
    const params: Array<string | number | string[]> = [session.companyId]
    let paramIndex = 2

    // Default view is the actionable one. "All" is reachable, but an operator
    // opening this screen wants the trucks nobody has dealt with yet, not a
    // year of settled history.
    const statusParam = String(searchParams.get("status") || "").toUpperCase()
    if (statusParam && statusParam !== "ALL") {
      if (!ASN_STATUSES.includes(statusParam as (typeof ASN_STATUSES)[number])) {
        return fail("VALIDATION_ERROR", `Unknown status ${statusParam}`, 400)
      }
      conditions.push(`r.status = $${paramIndex}`)
      params.push(statusParam)
      paramIndex++
    } else if (!statusParam) {
      conditions.push(`r.status = ANY($${paramIndex}::text[])`)
      params.push(ASN_OPEN_STATUSES)
      paramIndex++
    }

    const clientId = searchParams.get("client_id")
    if (clientId) {
      conditions.push(`r.client_id = $${paramIndex}`)
      params.push(parseInt(clientId, 10))
      paramIndex++
    }

    const search = searchParams.get("search")
    if (search) {
      conditions.push(`(r.request_number ILIKE $${paramIndex} OR c.client_name ILIKE $${paramIndex})`)
      params.push(`%${search}%`)
      paramIndex++
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`
    const orderByClause = buildOrderBy(
      searchParams.get("sort_by"),
      searchParams.get("sort_dir"),
      ASN_SORT_COLUMNS,
      { key: "created_at", direction: "DESC" },
      "r.id"
    )

    const countResult = await query(
      `SELECT COUNT(*)
       FROM client_portal_asn_requests r
       JOIN clients c ON c.id = r.client_id AND c.company_id = r.company_id
       ${whereClause}`,
      params
    )
    const total = parseInt(countResult.rows[0].count, 10)

    const dataResult = await query(
      `SELECT r.id, r.request_number, r.client_id, r.expected_date, r.remarks, r.status,
              r.reviewed_at, r.review_remarks, r.created_at,
              c.client_name, c.client_code,
              requester.full_name AS requested_by_name,
              reviewer.full_name AS reviewed_by_name,
              (SELECT COUNT(*) FROM client_portal_asn_lines l
                WHERE l.company_id = r.company_id AND l.asn_request_id = r.id) AS line_count,
              (SELECT COALESCE(SUM(l.expected_quantity), 0) FROM client_portal_asn_lines l
                WHERE l.company_id = r.company_id AND l.asn_request_id = r.id) AS expected_quantity,
              (SELECT COUNT(*) FROM grn_header g
                WHERE g.company_id = r.company_id AND g.asn_request_id = r.id) AS receipt_count
       FROM client_portal_asn_requests r
       JOIN clients c ON c.id = r.client_id AND c.company_id = r.company_id
       LEFT JOIN users requester ON requester.id = r.requested_by AND requester.company_id = r.company_id
       LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by AND reviewer.company_id = r.company_id
       ${whereClause}
       ${orderByClause}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    )

    return paginated(dataResult.rows, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch ASN requests"
    return fail("SERVER_ERROR", message, 500)
  }
}
