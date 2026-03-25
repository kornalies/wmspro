import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { hasPortalFeaturePermission, hasPortalPermission, parseAndAuthorizeClientId } from "@/app/api/portal/_utils"

const actionSchema = z.object({
  client_id: z.number().int().positive(),
  action: z.enum(["APPROVE", "DISPUTE", "PAY"]),
  notes: z.string().trim().max(1000).optional(),
  dispute_reason: z.string().trim().max(2000).optional(),
  dispute_amount: z.number().nonnegative().optional(),
  payment_date: z.string().min(10).optional(),
  amount: z.number().positive().optional(),
  payment_mode: z.string().trim().max(50).optional(),
  reference_no: z.string().trim().max(120).optional(),
})

async function ensurePaymentSchema() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        invoice_id INTEGER NOT NULL,
        payment_date DATE NOT NULL,
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        payment_mode VARCHAR(30),
        reference_no VARCHAR(120),
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await query(
      "CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_invoice ON invoice_payments(company_id, invoice_id)"
    )
  } catch (error) {
    if (!(error instanceof Error) || !/permission denied|insufficient privilege|must be owner of/i.test(error.message)) {
      throw error
    }
  }
}

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.billing.view"))) {
      return fail("FORBIDDEN", "No portal billing permission", 403)
    }
    const payload = actionSchema.parse(await request.json())
    const invoiceId = Number((await context.params).id || 0)
    if (!invoiceId) return fail("VALIDATION_ERROR", "Invalid invoice id", 400)

    const canAction =
      (await hasPortalPermission(session, "portal.billing.action")) ||
      (await hasPortalPermission(session, "portal.dispute.create")) ||
      session.role === "SUPER_ADMIN" ||
      session.role === "ADMIN"
    if (!canAction) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const clientIdCheck = await parseAndAuthorizeClientId(session, String(payload.client_id))
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    await ensurePaymentSchema()
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const invoiceRes = await db.query(
      `SELECT
         id,
         invoice_number,
         client_id,
         due_date,
         status,
         paid_amount,
         balance_amount,
         grand_total
       FROM invoice_header
       WHERE company_id = $1
         AND id = $2
         AND client_id = $3
       FOR UPDATE`,
      [session.companyId, invoiceId, payload.client_id]
    )
    if (!invoiceRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Invoice not found for client", 404)
    }
    const invoice = invoiceRes.rows[0] as {
      invoice_number: string
      status: string
      paid_amount: number
      balance_amount: number
      grand_total: number
    }

    if (payload.action === "APPROVE") {
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
        [session.companyId, invoiceId, payload.notes || "Approved from portal"]
      )
    }

    if (payload.action === "DISPUTE") {
      if (!payload.dispute_reason || payload.dispute_reason.trim().length < 10) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", "dispute_reason of at least 10 characters is required", 400)
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

      const dispute = await db.query(
        `INSERT INTO portal_invoice_disputes (
           company_id, client_id, invoice_id, dispute_number, category, priority, dispute_reason,
           dispute_amount, status, raised_by, raised_at
         ) VALUES (
           $1,$2,$3,$4,'BILLING_AMOUNT','MEDIUM',$5,$6,'OPEN',$7,NOW()
         )
         RETURNING id`,
        [
          session.companyId,
          payload.client_id,
          invoiceId,
          disputeNumber,
          payload.dispute_reason,
          payload.dispute_amount ?? null,
          session.userId,
        ]
      )

      await db.query(
        `INSERT INTO portal_invoice_dispute_events (
           company_id, dispute_id, event_type, to_status, comment, actor_user_id
         ) VALUES ($1,$2,'CREATED','OPEN',$3,$4)`,
        [session.companyId, dispute.rows[0].id, payload.dispute_reason, session.userId]
      )

      await db.query(
        `UPDATE invoice_header
         SET client_action_status = 'DISPUTED',
             client_action_at = NOW(),
             client_last_action_note = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $1
           AND id = $2`,
        [session.companyId, invoiceId, payload.dispute_reason]
      )
    }

    if (payload.action === "PAY") {
      const amount = Number(payload.amount || 0)
      if (amount <= 0) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", "Positive payment amount is required", 400)
      }
      const currentBalance = Number(invoice.balance_amount ?? Math.max(Number(invoice.grand_total) - Number(invoice.paid_amount), 0))
      if (amount > currentBalance + 0.01) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", "Payment exceeds outstanding balance", 400)
      }

      await db.query(
        `INSERT INTO invoice_payments (
           company_id, invoice_id, payment_date, amount, payment_mode, reference_no, notes, created_by
         ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)`,
        [
          session.companyId,
          invoiceId,
          payload.payment_date || new Date().toISOString().slice(0, 10),
          amount,
          payload.payment_mode || "PORTAL",
          payload.reference_no || null,
          payload.notes || "Portal self-service payment",
          session.userId,
        ]
      )

      const newPaid = Number(invoice.paid_amount || 0) + amount
      const newBalance = Math.max(Number(invoice.grand_total || 0) - newPaid, 0)
      await db.query(
        `UPDATE invoice_header
         SET paid_amount = $1,
             balance_amount = $2,
             status = CASE WHEN $2 <= 0 THEN 'PAID' ELSE status END,
             client_action_status = CASE
               WHEN $2 <= 0 THEN 'PAID'
               ELSE 'PARTIALLY_PAID'
             END,
             client_action_at = NOW(),
             client_last_action_note = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $4
           AND id = $5`,
        [newPaid, newBalance, payload.notes || "Payment received from portal", session.companyId, invoiceId]
      )
    }

    await db.query(
      `INSERT INTO portal_invoice_actions (
         company_id, client_id, invoice_id, action_type, action_payload, actor_user_id
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        session.companyId,
        payload.client_id,
        invoiceId,
        payload.action,
        JSON.stringify({
          notes: payload.notes || null,
          amount: payload.amount ?? null,
          payment_date: payload.payment_date || null,
          dispute_reason: payload.dispute_reason || null,
          reference_no: payload.reference_no || null,
        }),
        session.userId,
      ]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "portal",
        action: `portal.invoice.${payload.action.toLowerCase()}`,
        entityType: "invoice_header",
        entityId: String(invoiceId),
        after: {
          invoice_number: invoice.invoice_number,
          action: payload.action,
          amount: payload.amount ?? null,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({ invoice_id: invoiceId, action: payload.action }, "Invoice action saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to process invoice action"
    return fail("ACTION_FAILED", message, 400)
  } finally {
    db.release()
  }
}
