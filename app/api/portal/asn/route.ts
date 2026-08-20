import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query, getClient, setTenantContext } from "@/lib/db"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import {
  AsnError,
  loadAsnRequest,
  reserveAsnRequestNumber,
  resolveAsnLineItems,
} from "@/lib/asn"
import { notifyUsers, resolveUsersWithPermission } from "@/lib/notifications"

import { hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

const asnLineSchema = z.object({
  item_id: z.number().int().positive(),
  expected_quantity: z.number().int().positive("Expected quantity must be at least 1"),
  batch_no: z.string().trim().max(100).optional(),
  expiry_date: z.string().trim().optional(),
  remarks: z.string().trim().max(500).optional(),
})

const asnRequestSchema = z.object({
  client_id: z.number().positive(),
  expected_date: z.string().optional(),
  remarks: z.string().trim().optional(),
  // A request with no lines is the thing this feature exists to stop being
  // possible: it is what the portal used to submit, and it is what nobody in
  // the warehouse could act on.
  lines: z.array(asnLineSchema).min(1, "Add at least one item to the request").max(200),
})

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.asn.view"))) {
      return fail("FORBIDDEN", "No portal ASN view permission", 403)
    }

    const url = new URL(request.url)
    const clientIdCheck = await parseAndAuthorizeClientId(session, url.searchParams.get("client_id"))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    // A single request, with its lines and any receipts raised against it. This
    // is how a client answers "what happened to the shipment I announced?" --
    // the question the feature could not answer at all before.
    const requestedId = Number(url.searchParams.get("id"))
    if (requestedId) {
      const detail = await loadAsnRequest({ query }, session.companyId, requestedId)
      if (!detail || Number(detail.client_id) !== clientIdCheck.clientId) {
        return fail("NOT_FOUND", "ASN request not found", 404)
      }
      return ok(detail)
    }

    const result = await query(
      `SELECT r.id, r.request_number, r.expected_date, r.remarks, r.status,
              r.reviewed_at, r.review_remarks, r.created_at,
              (SELECT COUNT(*) FROM client_portal_asn_lines l
                WHERE l.company_id = r.company_id AND l.asn_request_id = r.id) AS line_count,
              (SELECT COALESCE(SUM(l.expected_quantity), 0) FROM client_portal_asn_lines l
                WHERE l.company_id = r.company_id AND l.asn_request_id = r.id) AS expected_quantity,
              (SELECT COUNT(*) FROM grn_header g
                WHERE g.company_id = r.company_id AND g.asn_request_id = r.id) AS receipt_count
       FROM client_portal_asn_requests r
       WHERE r.company_id = $1
         AND r.client_id = $2
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [session.companyId, clientIdCheck.clientId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch ASN requests"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: Request) {
  const db = await getClient()
  let transactionOpen = false

  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.asn.create"))) {
      return fail("FORBIDDEN", "No portal ASN create permission", 403)
    }

    const idemKey = request.headers.get("x-idempotency-key")
    if (idemKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idemKey,
        routeKey: "portal.asn.create",
      })
      if (cached) {
        return ok(cached.body as Record<string, unknown>, "Idempotent replay")
      }
    }

    const payload = asnRequestSchema.parse(await request.json())
    const clientIdCheck = await parseAndAuthorizeClientId(session, String(payload.client_id))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    await db.query("BEGIN")
    transactionOpen = true
    await setTenantContext(db, session.companyId)

    const uomByItem = await resolveAsnLineItems(db, session.companyId, payload.lines)
    const requestNumber = await reserveAsnRequestNumber(db, session.companyId)

    const created = await db.query(
      `INSERT INTO client_portal_asn_requests (
        company_id, client_id, request_number, expected_date, remarks, status, requested_by
      )
      VALUES ($1, $2, $3, $4::date, $5, 'REQUESTED', $6)
      RETURNING id, request_number, expected_date, remarks, status, created_at`,
      [
        session.companyId,
        clientIdCheck.clientId,
        requestNumber,
        payload.expected_date || null,
        payload.remarks || null,
        session.userId,
      ]
    )

    const asnRequestId = Number(created.rows[0].id)
    for (let i = 0; i < payload.lines.length; i++) {
      const line = payload.lines[i]
      await db.query(
        `INSERT INTO client_portal_asn_lines (
          company_id, asn_request_id, line_number, item_id,
          expected_quantity, uom, batch_no, expiry_date, remarks
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
        [
          session.companyId,
          asnRequestId,
          i + 1,
          line.item_id,
          line.expected_quantity,
          uomByItem.get(Number(line.item_id)) ?? null,
          line.batch_no || null,
          line.expiry_date || null,
          line.remarks || null,
        ]
      )
    }

    const responseBody = {
      ...created.rows[0],
      line_count: payload.lines.length,
      expected_quantity: payload.lines.reduce((sum, line) => sum + line.expected_quantity, 0),
    }

    await db.query("COMMIT")
    transactionOpen = false

    // Written after COMMIT on purpose: the idempotency record exists to stop a
    // retry creating a second request, and a request that rolled back never
    // existed to be duplicated.
    if (idemKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idemKey,
        routeKey: "portal.asn.create",
        responseBody,
      })
    }

    // Tell the warehouse. Without this the queue only works for someone who
    // thinks to open it, which is the same "nobody is watching" failure the
    // whole feature had -- moved one screen along rather than fixed. After
    // COMMIT and non-throwing: a notification problem must not lose the request.
    const clientName = await query(
      "SELECT client_name FROM clients WHERE company_id = $1 AND id = $2",
      [session.companyId, clientIdCheck.clientId]
    )
    const reviewers = await resolveUsersWithPermission(session.companyId, "grn.manage")
    await notifyUsers({
      companyId: session.companyId,
      userIds: reviewers,
      type: "asn.request.submitted",
      title: "New client shipment notice",
      body: `${clientName.rows[0]?.client_name || "A client"} announced ${responseBody.line_count} line${
        responseBody.line_count === 1 ? "" : "s"
      } (${responseBody.expected_quantity} units) as ${responseBody.request_number}`,
      data: {
        asn_request_id: asnRequestId,
        request_number: responseBody.request_number,
        client_id: clientIdCheck.clientId,
        href: "/grn/asn-requests",
      },
    })

    return ok(responseBody, "ASN request submitted")
  } catch (error: unknown) {
    if (transactionOpen) await db.query("ROLLBACK")
    if (error instanceof AsnError) {
      return fail(error.code, error.message, error.status)
    }
    const message = error instanceof Error ? error.message : "Failed to submit ASN request"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
