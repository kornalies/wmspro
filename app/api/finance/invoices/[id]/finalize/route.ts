import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { finalizeInvoice } from "@/lib/billing-service"
import { syncFinanceLedgerInTransaction } from "@/lib/finance-ledger"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const { id } = await context.params
    const invoiceId = Number(id)
    if (!invoiceId) return fail("VALIDATION_ERROR", "Invalid invoice id", 400)
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `finance.invoices.finalize:${invoiceId}`
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
    const result = await finalizeInvoice(db, {
      companyId: session.companyId,
      invoiceId,
      userId: session.userId,
    })
    await syncFinanceLedgerInTransaction(db, session.companyId, session.userId)
    await db.query("COMMIT")
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody: result,
      })
    }
    return ok(result, "Invoice finalized")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to finalize invoice"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}


