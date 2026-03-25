import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { syncFinanceLedger } from "@/lib/finance-ledger"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

const paymentSchema = z.object({
  payment_date: z.string().min(10),
  amount: z.number().positive(),
  payment_mode: z.string().optional(),
  reference_no: z.string().optional(),
  notes: z.string().optional(),
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

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const { id } = await context.params
    await ensurePaymentSchema()

    const result = await query(
      `SELECT
         ip.id,
         ip.payment_date::text AS payment_date,
         ip.amount,
         ip.payment_mode,
         ip.reference_no,
         ip.notes,
         ip.created_at
       FROM invoice_payments ip
       WHERE ip.company_id = $1
         AND ip.invoice_id = $2
       ORDER BY ip.payment_date DESC, ip.id DESC`,
      [session.companyId, Number(id)]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch invoice payments"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const { id } = await context.params
    const invoiceId = Number(id)
    if (!invoiceId) return fail("VALIDATION_ERROR", "Invalid invoice id", 400)

    const payload = paymentSchema.parse(await request.json())
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `finance.invoices.payment:${invoiceId}`
    if (idempotencyKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
      })
      if (cached) {
        return ok(cached.body as Record<string, unknown>, "Idempotent replay")
      }
    }
    await ensurePaymentSchema()
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const invoiceRes = await db.query(
      `SELECT
         id, due_date, grand_total, paid_amount, balance_amount, status
       FROM invoice_header
       WHERE company_id = $1 AND id = $2
       FOR UPDATE`,
      [session.companyId, invoiceId]
    )
    if (!invoiceRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Invoice not found", 404)
    }
    const invoice = invoiceRes.rows[0]
    const grandTotal = Number(invoice.grand_total || 0)
    const currentPaid = Number(invoice.paid_amount || 0)
    const currentBalance = Number(invoice.balance_amount ?? Math.max(grandTotal - currentPaid, 0))
    const amount = Number(payload.amount)
    if (amount > currentBalance + 0.01) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Payment exceeds outstanding balance", 400)
    }

    const paymentRes = await db.query(
      `INSERT INTO invoice_payments (
         company_id, invoice_id, payment_date, amount, payment_mode, reference_no, notes, created_by
       ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       RETURNING id, payment_date::text, amount, payment_mode, reference_no, notes`,
      [
        session.companyId,
        invoiceId,
        payload.payment_date,
        amount,
        payload.payment_mode || null,
        payload.reference_no || null,
        payload.notes || null,
        session.userId,
      ]
    )

    const newPaid = currentPaid + amount
    const newBalance = Math.max(grandTotal - newPaid, 0)
    const dueDate = new Date(invoice.due_date)
    const status =
      newBalance <= 0
        ? "PAID"
        : dueDate < new Date()
          ? "OVERDUE"
          : invoice.status === "DRAFT"
            ? "DRAFT"
            : "FINALIZED"

    const updatedRes = await db.query(
      `UPDATE invoice_header
       SET paid_amount = $1,
           balance_amount = $2,
           status = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $4
         AND id = $5
       RETURNING id, invoice_number, paid_amount, balance_amount AS balance, status`,
      [newPaid, newBalance, status, session.companyId, invoiceId]
    )

    await db.query("COMMIT")
    try {
      await syncFinanceLedger(session.companyId, session.userId)
    } catch (ledgerError) {
      // Payment write is committed; ledger sync retry can run asynchronously.
      console.error("invoice payment ledger sync failed:", ledgerError)
    }

    const responseBody = {
      payment: paymentRes.rows[0],
      invoice: updatedRes.rows[0],
    }
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Payment recorded")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to record payment"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}


