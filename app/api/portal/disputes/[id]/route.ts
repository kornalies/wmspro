import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { hasPortalFeaturePermission, hasPortalPermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

const updateSchema = z.object({
  client_id: z.number().int().positive(),
  status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED", "CLOSED"]).optional(),
  comment: z.string().trim().min(1).max(2000),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

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

    const updated = await db.query(
      `UPDATE portal_invoice_disputes
       SET status = $1,
           resolution_notes = CASE WHEN $1 IN ('RESOLVED', 'REJECTED', 'CLOSED') THEN $2 ELSE resolution_notes END,
           resolved_at = CASE WHEN $1 IN ('RESOLVED', 'REJECTED', 'CLOSED') THEN NOW() ELSE resolved_at END,
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
