import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { hasPortalFeaturePermission, hasPortalPermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

const createDisputeSchema = z.object({
  client_id: z.number().int().positive(),
  invoice_id: z.number().int().positive(),
  category: z.enum(["BILLING_AMOUNT", "SERVICE_QUALITY", "MISSING_DOCS", "OTHER"]).default("BILLING_AMOUNT"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  dispute_reason: z.string().trim().min(10).max(2000),
  dispute_amount: z.number().nonnegative().optional(),
})

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.dispute.view"))) {
      return fail("FORBIDDEN", "No portal dispute view permission", 403)
    }

    const url = new URL(request.url)
    const clientIdCheck = await parseAndAuthorizeClientId(session, url.searchParams.get("client_id"))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }
    const invoiceId = Number(url.searchParams.get("invoice_id") || 0)

    const result = await query(
      `SELECT
         d.id,
         d.dispute_number,
         d.invoice_id,
         ih.invoice_number,
         d.category,
         d.priority,
         d.dispute_reason,
         d.dispute_amount,
         d.status,
         d.raised_at,
         d.resolved_at,
         d.resolution_notes,
         u.full_name AS raised_by_name
       FROM portal_invoice_disputes d
       JOIN invoice_header ih ON ih.id = d.invoice_id AND ih.company_id = d.company_id
       LEFT JOIN users u ON u.id = d.raised_by AND u.company_id = d.company_id
       WHERE d.company_id = $1
         AND d.client_id = $2
         AND ($3::int = 0 OR d.invoice_id = $3)
       ORDER BY d.raised_at DESC
       LIMIT 300`,
      [session.companyId, clientIdCheck.clientId, invoiceId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch disputes"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: Request) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.dispute.create"))) {
      return fail("FORBIDDEN", "No portal dispute create permission", 403)
    }
    const canCreate =
      (await hasPortalPermission(session, "portal.dispute.create")) ||
      (await hasPortalPermission(session, "portal.dispute.manage")) ||
      session.role === "SUPER_ADMIN" ||
      session.role === "ADMIN"
    if (!canCreate) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = createDisputeSchema.parse(await request.json())
    const clientIdCheck = await parseAndAuthorizeClientId(session, String(payload.client_id))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const invoice = await db.query(
      `SELECT id
       FROM invoice_header
       WHERE company_id = $1
         AND id = $2
         AND client_id = $3
       LIMIT 1`,
      [session.companyId, payload.invoice_id, payload.client_id]
    )
    if (!invoice.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Invoice not found for client", 404)
    }

    const year = new Date().getFullYear()
    const seq = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(dispute_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
       FROM portal_invoice_disputes
       WHERE company_id = $1
         AND dispute_number LIKE 'DSP-${year}-%'`,
      [session.companyId]
    )
    const disputeNumber = `DSP-${year}-${String(seq.rows[0]?.next_seq || 1).padStart(6, "0")}`

    const created = await db.query(
      `INSERT INTO portal_invoice_disputes (
         company_id, client_id, invoice_id, dispute_number, category, priority,
         dispute_reason, dispute_amount, status, raised_by, raised_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,NOW())
       RETURNING *`,
      [
        session.companyId,
        payload.client_id,
        payload.invoice_id,
        disputeNumber,
        payload.category,
        payload.priority,
        payload.dispute_reason,
        payload.dispute_amount ?? null,
        session.userId,
      ]
    )
    const dispute = created.rows[0]

    await db.query(
      `INSERT INTO portal_invoice_dispute_events (
         company_id, dispute_id, event_type, to_status, comment, actor_user_id
       ) VALUES ($1,$2,'CREATED','OPEN',$3,$4)`,
      [session.companyId, dispute.id, payload.dispute_reason, session.userId]
    )

    await db.query(
      `UPDATE invoice_header
       SET client_action_status = 'DISPUTED',
           client_action_at = NOW(),
           client_last_action_note = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, payload.invoice_id, payload.dispute_reason]
    )

    await db.query(
      `INSERT INTO portal_invoice_actions (
         company_id, client_id, invoice_id, action_type, action_payload, actor_user_id
       ) VALUES ($1,$2,$3,'DISPUTE',$4::jsonb,$5)`,
      [
        session.companyId,
        payload.client_id,
        payload.invoice_id,
        JSON.stringify({
          dispute_number: disputeNumber,
          category: payload.category,
          priority: payload.priority,
          reason: payload.dispute_reason,
          amount: payload.dispute_amount ?? null,
        }),
        session.userId,
      ]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "portal",
        action: "portal.dispute.create",
        entityType: "portal_invoice_disputes",
        entityId: String(dispute.id),
        after: dispute,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(dispute, "Dispute created")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to create dispute"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
