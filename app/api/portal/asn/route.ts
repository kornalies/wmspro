import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { ensurePortalTables } from "@/lib/portal"

import { hasPortalFeaturePermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

const asnRequestSchema = z.object({
  client_id: z.number().positive(),
  expected_date: z.string().optional(),
  remarks: z.string().trim().optional(),
})

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.asn.view"))) {
      return fail("FORBIDDEN", "No portal ASN view permission", 403)
    }
    await ensurePortalTables()

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const result = await query(
      `SELECT id, request_number, expected_date, remarks, status, created_at
       FROM client_portal_asn_requests
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [clientIdCheck.clientId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch ASN requests"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.asn.create"))) {
      return fail("FORBIDDEN", "No portal ASN create permission", 403)
    }
    await ensurePortalTables()

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

    const seq = await query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(request_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
       FROM client_portal_asn_requests
       WHERE request_number LIKE 'ASNREQ-%'`
    )
    const requestNumber = `ASNREQ-${String(seq.rows[0]?.next_seq || 1).padStart(6, "0")}`

    const created = await query(
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

    const responseBody = created.rows[0]
    if (idemKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idemKey,
        routeKey: "portal.asn.create",
        responseBody,
      })
    }
    return ok(responseBody, "ASN request submitted")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to submit ASN request"
    return fail("CREATE_FAILED", message, 400)
  }
}
