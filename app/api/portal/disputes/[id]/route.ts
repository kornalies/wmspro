import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { hasPortalFeaturePermission, hasPortalPermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

/**
 * One dispute, as the conversation it actually is.
 *
 * The PUT below has been writing COMMENT and STATUS_CHANGE rows into
 * portal_invoice_dispute_events since disputes shipped, but nothing ever read
 * them back -- so every exchange between a client and the warehouse was
 * recorded and then shown to nobody, and the portal rendered a dispute as a
 * status column. That is the same dead end the notification rows were in before
 * the portal could read them.
 *
 * The GET is deliberately not gated on portal.dispute.manage the way the PUT is:
 * reading your own dispute is not managing it, and a client who can see the
 * dispute list can see what was said on their own dispute.
 */

type RouteContext = {
  params: Promise<{ id: string }>
}

type DisputeEventRow = {
  id: number
  event_type: string
  from_status: string | null
  to_status: string | null
  comment: string | null
  created_at: string
  actor_user_id: number | null
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.dispute.view"))) {
      return fail("FORBIDDEN", "No portal dispute permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const disputeId = Number((await context.params).id || 0)
    if (!disputeId) return fail("VALIDATION_ERROR", "Invalid dispute id", 400)

    // client_id in the WHERE as well as in the gate: the gate proves the caller
    // may read this client, this proves the dispute belongs to it.
    const disputeRes = await query(
      // `currency`, aliased: the column is named currency on invoice_header and
      // every other portal route exposes it as currency_code.
      `SELECT d.*, ih.invoice_number, COALESCE(ih.currency, 'INR') AS currency_code, ih.grand_total,
              u.full_name AS raised_by_name
       FROM portal_invoice_disputes d
       LEFT JOIN invoice_header ih ON ih.id = d.invoice_id
       LEFT JOIN users u ON u.id = d.raised_by
       WHERE d.client_id = $1 AND d.id = $2
       LIMIT 1`,
      [clientIdCheck.clientId, disputeId]
    )
    if (!disputeRes.rows.length) return fail("NOT_FOUND", "Dispute not found", 404)
    const dispute = disputeRes.rows[0] as Record<string, unknown>

    const eventsRes = await query(
      `SELECT e.id, e.event_type, e.from_status, e.to_status, e.comment, e.created_at,
              e.actor_user_id
       FROM portal_invoice_dispute_events e
       WHERE e.dispute_id = $1
       ORDER BY e.created_at ASC, e.id ASC`,
      [disputeId]
    )

    // Who said it, in terms the client understands. Their own messages are
    // "You"; everything else is the warehouse speaking, and the operator's
    // personal name is not the client's business.
    const events = (eventsRes.rows as DisputeEventRow[]).map((event) => ({
      id: event.id,
      event_type: event.event_type,
      from_status: event.from_status,
      to_status: event.to_status,
      comment: event.comment,
      created_at: event.created_at,
      author: Number(event.actor_user_id || 0) === session.userId ? "you" : "warehouse",
    }))

    // Whether this caller may add to the thread, decided by the same two rules
    // the PUT enforces, so the UI never offers a reply box the route refuses.
    const canManage =
      (await hasPortalPermission(session, "portal.dispute.manage")) ||
      session.role === "SUPER_ADMIN" ||
      session.role === "ADMIN"
    const canComment =
      (await hasPortalFeaturePermission(session, "portal.dispute.manage")) &&
      (canManage || Number(dispute.raised_by || 0) === session.userId)

    return ok({ ...dispute, events, can_comment: canComment, can_change_status: canManage })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch dispute"
    return fail("SERVER_ERROR", message, 500)
  }
}

const updateSchema = z.object({
  client_id: z.number().int().positive(),
  status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED", "CLOSED"]).optional(),
  comment: z.string().trim().min(1).max(2000),
})

export async function PUT(request: Request, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.dispute.manage"))) {
      return fail("FORBIDDEN", "No portal dispute manage permission", 403)
    }
    const payload = updateSchema.parse(await request.json())
    const disputeId = Number((await context.params).id || 0)
    if (!disputeId) return fail("VALIDATION_ERROR", "Invalid dispute id", 400)

    const clientIdCheck = await parseAndAuthorizeClientId(session, String(payload.client_id))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const canManage =
      (await hasPortalPermission(session, "portal.dispute.manage")) ||
      session.role === "SUPER_ADMIN" ||
      session.role === "ADMIN"

    if (payload.status && !canManage) {
      return fail("FORBIDDEN", "Only dispute managers can change status", 403)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const currentRes = await db.query(
      `SELECT id, invoice_id, status, raised_by
       FROM portal_invoice_disputes
       WHERE company_id = $1
         AND client_id = $2
         AND id = $3
       FOR UPDATE`,
      [session.companyId, payload.client_id, disputeId]
    )
    if (!currentRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Dispute not found", 404)
    }
    const current = currentRes.rows[0] as { status: string; invoice_id: number; raised_by: number | null }
    if (!canManage && Number(current.raised_by || 0) !== session.userId) {
      await db.query("ROLLBACK")
      return fail("FORBIDDEN", "Only dispute creator can comment on this dispute", 403)
    }

    const nextStatus = payload.status || current.status

    // $1 is cast explicitly because it is used in two incompatible contexts: as a
    // value for the varchar `status` column, and against untyped string literals
    // in the IN lists. Postgres deduced varchar from the first and text from the
    // second and refused the statement outright with "inconsistent types deduced
    // for parameter $1" -- so every comment and every status change on a dispute
    // failed, which is why portal_invoice_dispute_events was empty everywhere.
    const updated = await db.query(
      `UPDATE portal_invoice_disputes
       SET status = $1::text,
           resolution_notes = CASE WHEN $1::text IN ('RESOLVED', 'REJECTED', 'CLOSED') THEN $2 ELSE resolution_notes END,
           resolved_at = CASE WHEN $1::text IN ('RESOLVED', 'REJECTED', 'CLOSED') THEN NOW() ELSE resolved_at END,
           updated_at = NOW()
       WHERE company_id = $3
         AND id = $4
       RETURNING *`,
      [nextStatus, payload.comment, session.companyId, disputeId]
    )

    await db.query(
      `INSERT INTO portal_invoice_dispute_events (
         company_id, dispute_id, event_type, from_status, to_status, comment, actor_user_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7
       )`,
      [
        session.companyId,
        disputeId,
        payload.status ? "STATUS_CHANGE" : "COMMENT",
        current.status,
        nextStatus,
        payload.comment,
        session.userId,
      ]
    )

    if (payload.status && ["RESOLVED", "REJECTED", "CLOSED"].includes(payload.status)) {
      await db.query(
        `UPDATE invoice_header
         SET client_action_status = CASE
               WHEN status = 'PAID' THEN 'PAID'
               ELSE 'APPROVED'
             END,
             client_action_at = NOW(),
             client_last_action_note = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $1
           AND id = $2`,
        [session.companyId, current.invoice_id, payload.comment]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: canManage ? "web" : "portal",
        action: payload.status ? "portal.dispute.status_update" : "portal.dispute.comment",
        entityType: "portal_invoice_disputes",
        entityId: String(disputeId),
        after: {
          from_status: current.status,
          to_status: nextStatus,
          comment: payload.comment,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(updated.rows[0], "Dispute updated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to update dispute"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
