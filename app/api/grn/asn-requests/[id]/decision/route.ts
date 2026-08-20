import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { writeAudit } from "@/lib/audit"
import { canReviewAsn } from "@/lib/asn"
import { notifyUsers } from "@/lib/notifications"

type RouteContext = {
  params: Promise<{ id: string }>
}

const decisionSchema = z.object({
  decision: z.enum(["ACCEPT", "REJECT"]),
  remarks: z.string().trim().max(1000).optional(),
})

/**
 * The warehouse's answer to a client's shipment announcement.
 *
 * Accepting does not create anything. It records that the warehouse expects the
 * truck and unlocks the "Receive" action, which opens the normal GRN form
 * prefilled from the request's lines. Staff then correct the quantities against
 * what actually came off the vehicle before saving -- the whole point of
 * keeping expected and received apart. Auto-creating a draft GRN here would
 * mean a draft receipt on the books for every truck that never turns up.
 *
 * Both decisions are audited: a client will eventually ask why their request
 * was refused, and "the warehouse rejected it" needs a name and a timestamp
 * behind it.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  let transactionOpen = false

  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    // Before any DB work, and as an explicit 403: a client rejected here must
    // not see the generic DECISION_FAILED 400 the catch block produces.
    if (!canReviewAsn(session)) {
      return fail("FORBIDDEN", "Insufficient permissions", 403)
    }

    const { id } = await context.params
    const asnRequestId = Number(id)
    if (!asnRequestId) return fail("VALIDATION_ERROR", "Invalid ASN request id", 400)

    const payload = decisionSchema.parse(await request.json())
    const nextStatus = payload.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED"

    await db.query("BEGIN")
    transactionOpen = true
    await setTenantContext(db, session.companyId)

    // FOR UPDATE, and the status predicate on the UPDATE below, so two
    // operators clicking Accept and Reject on the same request cannot both
    // win. Only a request still awaiting a decision can receive one -- you
    // cannot reject something already received.
    const existing = await db.query(
      `SELECT id, status, request_number, client_id, requested_by
       FROM client_portal_asn_requests
       WHERE company_id = $1 AND id = $2
       FOR UPDATE`,
      [session.companyId, asnRequestId]
    )
    if (!existing.rows.length) {
      await db.query("ROLLBACK")
      transactionOpen = false
      return fail("NOT_FOUND", "ASN request not found", 404)
    }

    const currentStatus = String(existing.rows[0].status)
    if (currentStatus !== "REQUESTED") {
      await db.query("ROLLBACK")
      transactionOpen = false
      return fail(
        "INVALID_STATUS",
        `This request is already ${currentStatus.toLowerCase()} and cannot be reviewed again`,
        409
      )
    }

    const lineCount = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM client_portal_asn_lines
       WHERE company_id = $1 AND asn_request_id = $2`,
      [session.companyId, asnRequestId]
    )
    // Requests created before migration 081 have no lines and nothing to
    // receive against. They can still be rejected -- that is how the queue gets
    // cleared of them -- but accepting one would lead to a Receive button that
    // prefills an empty GRN.
    if (payload.decision === "ACCEPT" && Number(lineCount.rows[0].count) === 0) {
      await db.query("ROLLBACK")
      transactionOpen = false
      return fail(
        "NO_LINES",
        "This request has no line items, so there is nothing to receive. Ask the client to resubmit with items.",
        400
      )
    }

    const updated = await db.query(
      `UPDATE client_portal_asn_requests
       SET status = $3,
           reviewed_by = $4,
           reviewed_at = CURRENT_TIMESTAMP,
           review_remarks = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2
         AND status = 'REQUESTED'
       RETURNING id, request_number, status, reviewed_at, review_remarks`,
      [session.companyId, asnRequestId, nextStatus, session.userId, payload.remarks || null]
    )
    if (!updated.rows.length) {
      await db.query("ROLLBACK")
      transactionOpen = false
      return fail("INVALID_STATUS", "This request was reviewed by someone else", 409)
    }

    await db.query("COMMIT")
    transactionOpen = false

    await writeAudit({
      companyId: session.companyId,
      actorUserId: session.userId,
      actorType: "web",
      action: payload.decision === "ACCEPT" ? "asn.request.accepted" : "asn.request.rejected",
      entityType: "client_portal_asn_request",
      entityId: String(asnRequestId),
      before: { status: currentStatus },
      after: {
        status: nextStatus,
        request_number: existing.rows[0].request_number,
        client_id: existing.rows[0].client_id,
        remarks: payload.remarks || null,
      },
      req: request,
    })

    // Close the loop back to the person who raised it. A rejection the client
    // only discovers by re-opening the portal is barely better than no answer at
    // all -- they will phone instead, which is what the portal exists to avoid.
    await notifyUsers({
      companyId: session.companyId,
      userIds: [Number(existing.rows[0].requested_by)],
      type: payload.decision === "ACCEPT" ? "asn.request.accepted" : "asn.request.rejected",
      title:
        payload.decision === "ACCEPT"
          ? `Shipment ${existing.rows[0].request_number} accepted`
          : `Shipment ${existing.rows[0].request_number} rejected`,
      body:
        payload.remarks ||
        (payload.decision === "ACCEPT"
          ? "Your warehouse provider is expecting this shipment."
          : "Your warehouse provider could not accept this request."),
      data: {
        asn_request_id: asnRequestId,
        request_number: existing.rows[0].request_number,
        href: "/portal/asn",
      },
    })

    return ok(
      updated.rows[0],
      payload.decision === "ACCEPT" ? "ASN request accepted" : "ASN request rejected"
    )
  } catch (error: unknown) {
    if (transactionOpen) await db.query("ROLLBACK")
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to review ASN request"
    return fail("DECISION_FAILED", message, 400)
  } finally {
    db.release()
  }
}
