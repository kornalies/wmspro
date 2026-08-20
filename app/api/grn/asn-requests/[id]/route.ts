import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { canReviewAsn, loadAsnRequest } from "@/lib/asn"

type RouteContext = {
  params: Promise<{ id: string }>
}

/**
 * One ASN request in full, for the review drawer and for prefilling a GRN.
 *
 * Same loader the portal uses, so the client and the operator are looking at
 * the same rows -- if they ever disagree about what was announced, it is not
 * because two queries drifted apart.
 */
export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    if (!canReviewAsn(session)) {
      return fail("FORBIDDEN", "Insufficient permissions", 403)
    }

    const { id } = await context.params
    const asnRequestId = Number(id)
    if (!asnRequestId) return fail("VALIDATION_ERROR", "Invalid ASN request id", 400)

    const detail = await loadAsnRequest({ query }, session.companyId, asnRequestId)
    if (!detail) return fail("NOT_FOUND", "ASN request not found", 404)

    return ok(detail)
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch ASN request"
    return fail("SERVER_ERROR", message, 500)
  }
}
