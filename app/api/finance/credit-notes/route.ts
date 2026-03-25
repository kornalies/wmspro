import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { syncFinanceLedgerInTransaction } from "@/lib/finance-ledger"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

const payloadSchema = z.object({
  invoice_id: z.number().positive(),
  note_date: z.string().min(10),
  reason: z.string().min(3),
  lines: z
    .array(
      z.object({
        invoice_line_id: z.number().positive().optional(),
        description: z.string().min(1),
        quantity: z.number().min(0),
        rate: z.number().min(0),
        tax_rate: z.number().min(0).optional(),
      })
    )
    .min(1),
})

type InvoiceLockRow = {
  id: number
  client_id: number
}

type BillingSeqRow = {
  last_seq: number
}

type CreditNoteHeaderRow = {
  id: number
  grand_total: number
}

function makeNoteNumber(prefix: string, seq: number, dateIso: string) {
  return `${prefix}-${dateIso.slice(0, 7).replace("-", "")}-${String(seq).padStart(6, "0")}`
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const invoiceId = Number(request.nextUrl.searchParams.get("invoice_id") || 0)
    const params: Array<number> = [session.companyId]
    const where = invoiceId ? "AND cnh.invoice_id = $2" : ""
    if (invoiceId) params.push(invoiceId)
    const res = await query(
      `SELECT cnh.*, ih.invoice_number, c.client_name
       FROM credit_note_header cnh
       JOIN invoice_header ih
         ON ih.id = cnh.invoice_id
        AND ih.company_id = cnh.company_id
       JOIN clients c
         ON c.id = cnh.client_id
        AND c.company_id = cnh.company_id
       WHERE cnh.company_id = $1
       ${where}
       ORDER BY cnh.note_date DESC, cnh.id DESC`,
      params
    )
    return ok(res.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch credit notes"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const payload = payloadSchema.parse(await request.json())
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `finance.credit-notes.create:${payload.invoice_id}:${payload.note_date}`
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

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const invRes = await db.query(
      `SELECT id, client_id, status
       FROM invoice_header
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, payload.invoice_id]
    )
    if (!invRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Invoice not found", 404)
    }
    const invoice = invRes.rows[0] as InvoiceLockRow

    const seqRes = await db.query(
      `INSERT INTO billing_invoice_seq (company_id, last_seq, updated_at)
       VALUES ($1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (company_id)
       DO UPDATE SET last_seq = billing_invoice_seq.last_seq + 1, updated_at = CURRENT_TIMESTAMP
       RETURNING last_seq`,
      [session.companyId]
    )
    const seq = Number((seqRes.rows[0] as BillingSeqRow | undefined)?.last_seq || 1)
    const noteNumber = makeNoteNumber("CN", seq, payload.note_date)

    let taxable = 0
    let totalTax = 0
    const mapped = payload.lines.map((line) => {
      const amount = Number((line.quantity * line.rate).toFixed(2))
      const taxRate = Number(line.tax_rate ?? 18)
      const taxAmount = Number(((amount * taxRate) / 100).toFixed(2))
      taxable += amount
      totalTax += taxAmount
      return {
        ...line,
        amount,
        taxRate,
        taxAmount,
        grossAmount: Number((amount + taxAmount).toFixed(2)),
      }
    })

    const headerRes = await db.query(
      `INSERT INTO credit_note_header (
         company_id, note_number, invoice_id, client_id, note_date, reason, taxable_amount,
         cgst_amount, sgst_amount, igst_amount, total_tax_amount, grand_total, status, created_by
       ) VALUES (
         $1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,'ISSUED',$13
       ) RETURNING *`,
      [
        session.companyId,
        noteNumber,
        payload.invoice_id,
        invoice.client_id,
        payload.note_date,
        payload.reason,
        taxable,
        Number((totalTax / 2).toFixed(2)),
        Number((totalTax / 2).toFixed(2)),
        0,
        totalTax,
        Number((taxable + totalTax).toFixed(2)),
        session.userId,
      ]
    )
    const header = headerRes.rows[0] as CreditNoteHeaderRow

    let lineNo = 1
    for (const line of mapped) {
      await db.query(
        `INSERT INTO credit_note_lines (
           company_id, credit_note_id, invoice_line_id, line_no, description, quantity, rate, amount, tax_rate, tax_amount, gross_amount
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
         )`,
        [
          session.companyId,
          header.id,
          line.invoice_line_id || null,
          lineNo,
          line.description,
          line.quantity,
          line.rate,
          line.amount,
          line.taxRate,
          line.taxAmount,
          line.grossAmount,
        ]
      )
      lineNo += 1
    }

    await db.query(
      `UPDATE invoice_header
       SET balance_amount = GREATEST(balance_amount - $1, 0),
           status = CASE WHEN GREATEST(balance_amount - $1, 0) <= 0 THEN 'PAID' ELSE status END,
           updated_by = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $3
         AND id = $4`,
      [header.grand_total, session.userId, session.companyId, payload.invoice_id]
    )

    await syncFinanceLedgerInTransaction(db, session.companyId, session.userId)
    await db.query("COMMIT")
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody: header,
      })
    }
    return ok(header, "Credit note issued")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to issue credit note"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}


