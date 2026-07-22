import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureGrnManualSchema, ensureStockPutawaySchema } from "@/lib/db-bootstrap"
import { confirmGrnInTransaction, GrnConfirmError } from "@/lib/grn-confirm"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(_: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    await ensureGrnManualSchema(db)
    await ensureStockPutawaySchema(db)

    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.manage")

    const { id } = await context.params
    const grnId = Number(id)
    if (!grnId) return fail("VALIDATION_ERROR", "Invalid GRN id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const result = await confirmGrnInTransaction(db, {
      companyId: session.companyId,
      userId: session.userId,
      grnId,
    })

    await db.query("COMMIT")
    return ok({ id: result.id, status: result.status }, "Draft GRN confirmed successfully")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    if (error instanceof GrnConfirmError) {
      return fail(error.code, error.message, error.status)
    }
    const message = error instanceof Error ? error.message : "Failed to confirm draft GRN"
    return fail("CONFIRM_FAILED", message, 400)
  } finally {
    db.release()
  }
}

