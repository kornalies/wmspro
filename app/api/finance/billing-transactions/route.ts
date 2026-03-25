import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { stageChargeTransaction } from "@/lib/billing-service"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

const createSchema = z.object({
  client_id: z.number().positive(),
  warehouse_id: z.number().positive().optional(),
  charge_type: z.enum(["INBOUND_HANDLING", "OUTBOUND_HANDLING", "STORAGE", "VAS", "FIXED", "MINIMUM", "ADJUSTMENT"]),
  source_type: z.enum(["GRN", "DO", "VAS", "STORAGE", "MANUAL"]),
  source_doc_id: z.number().int().optional(),
  source_line_id: z.number().int().optional(),
  source_ref_no: z.string().optional(),
  event_date: z.string().min(10),
  period_from: z.string().optional(),
  period_to: z.string().optional(),
  quantity: z.number().min(0),
  base_amount: z.number().min(0).optional(),
  item_id: z.number().int().positive().optional(),
  uom: z.string().optional(),
  remarks: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const status = request.nextUrl.searchParams.get("status")
    const clientId = Number(request.nextUrl.searchParams.get("client_id") || 0)
    const chargeType = request.nextUrl.searchParams.get("charge_type")
    const dateFrom = request.nextUrl.searchParams.get("date_from")
    const dateTo = request.nextUrl.searchParams.get("date_to")

    const conditions: string[] = ["bt.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let i = 2

    if (status && status !== "all") {
      conditions.push(`bt.status = $${i++}`)
      params.push(status)
    }
    if (clientId) {
      conditions.push(`bt.client_id = $${i++}`)
      params.push(clientId)
    }
    if (chargeType && chargeType !== "all") {
      conditions.push(`bt.charge_type = $${i++}`)
      params.push(chargeType)
    }
    if (dateFrom) {
      conditions.push(`bt.event_date >= $${i++}::date`)
      params.push(dateFrom)
    }
    if (dateTo) {
      conditions.push(`bt.event_date <= $${i++}::date`)
      params.push(dateTo)
    }

    const result = await query(
      `SELECT
         bt.*,
         c.client_name,
         w.warehouse_name,
         ih.invoice_number
       FROM billing_transactions bt
       JOIN clients c
         ON c.id = bt.client_id
        AND c.company_id = bt.company_id
       LEFT JOIN warehouses w
         ON w.id = bt.warehouse_id
        AND w.company_id = bt.company_id
       LEFT JOIN invoice_header ih
         ON ih.id = bt.invoice_id
        AND ih.company_id = bt.company_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY bt.event_date DESC, bt.id DESC`,
      params
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch billing transactions"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const payload = createSchema.parse(await request.json())
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `finance.billing-transactions.create:${payload.source_type}:${payload.source_doc_id || 0}:${payload.charge_type}:${payload.event_date}`
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
    await stageChargeTransaction(db, {
      companyId: session.companyId,
      userId: session.userId,
      clientId: payload.client_id,
      warehouseId: payload.warehouse_id ?? null,
      chargeType: payload.charge_type,
      sourceType: payload.source_type,
      sourceDocId: payload.source_doc_id ?? null,
      sourceLineId: payload.source_line_id ?? null,
      sourceRefNo: payload.source_ref_no ?? null,
      eventDate: payload.event_date,
      periodFrom: payload.period_from ?? payload.event_date,
      periodTo: payload.period_to ?? payload.event_date,
      quantity: payload.quantity,
      baseAmount: payload.base_amount,
      itemId: payload.item_id ?? null,
      uom: payload.uom || "UNIT",
      remarks: payload.remarks ?? "Manual billing transaction",
    })
    await db.query("COMMIT")
    const responseBody = { success: true }
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Billing transaction staged")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to stage billing transaction"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function PUT(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const body = (await request.json()) as { id?: number; action?: "VOID" | "UNBILL" }
    const id = Number(body.id || 0)
    if (!id) return fail("VALIDATION_ERROR", "Transaction id is required", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const action = body.action || "VOID"
    const txRes = await db.query(
      `SELECT id, status, invoice_id
       FROM billing_transactions
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, id]
    )
    if (!txRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Billing transaction not found", 404)
    }
    const tx = txRes.rows[0] as { status: string; invoice_id: number | null }
    const isLinkedBilled = tx.status === "BILLED" && Boolean(tx.invoice_id)
    if (isLinkedBilled) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        "Billed transaction linked to invoice cannot be voided/unbilled directly. Reverse using invoice adjustment workflow first.",
        409
      )
    }

    if (action === "UNBILL") {
      await db.query(
        `UPDATE billing_transactions
         SET status = 'UNBILLED',
             invoice_id = NULL,
             billed_at = NULL,
             billed_by = NULL,
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $2
           AND id = $3
           AND status <> 'VOID'`,
        [session.userId, session.companyId, id]
      )
      await db.query("COMMIT")
      return ok({ id }, "Transaction moved to UNBILLED")
    }

    await db.query(
      `UPDATE billing_transactions
       SET status = 'VOID',
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $2
         AND id = $3`,
      [session.userId, session.companyId, id]
    )
    await db.query("COMMIT")
    return ok({ id }, "Transaction voided")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to update transaction"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}


