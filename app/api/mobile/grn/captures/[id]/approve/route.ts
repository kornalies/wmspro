import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { createGrnWithLineItems } from "@/lib/grn-service"
import { confirmGrnInTransaction, GrnConfirmError } from "@/lib/grn-confirm"
import {
  ensureGrnManualSchema,
  ensureMobileGrnCaptureSchema,
  ensureStockPutawaySchema,
} from "@/lib/db-bootstrap"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import type { MobileGrnCaptureInput } from "@/lib/validations/mobile-grn"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(_: NextRequest, context: RouteContext) {
  const db = await getClient()

  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.mobile.approve")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "mobile")
    requireFeature(policy, "grn")
    requirePolicyPermission(policy, "grn.mobile.approve")

    await ensureMobileGrnCaptureSchema(db)
    await ensureGrnManualSchema(db)
    await ensureStockPutawaySchema(db)

    const { id } = await context.params
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const captureResult = await db.query(
      "SELECT * FROM mobile_grn_captures WHERE id = $1 FOR UPDATE",
      [id]
    )
    if (!captureResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Capture not found", 404)
    }

    const capture = captureResult.rows[0]
    if (capture.status !== "PENDING") {
      await db.query("ROLLBACK")
      return fail("INVALID_STATUS", "Only pending captures can be approved", 400)
    }

    const payload = capture.payload as MobileGrnCaptureInput
    requireScope(policy, "warehouse", payload.header.warehouse_id)
    requireScope(policy, "client", payload.header.client_id)

    const lineItems = (payload.lineItems || []).map((item) => ({
      item_id: item.item_id,
      quantity: item.quantity,
      rate: item.rate || 0,
      serial_numbers: item.serial_numbers,
    }))

    const totalQuantity = lineItems.reduce((sum, item) => sum + item.quantity, 0)
    const totalValue = lineItems.reduce((sum, item) => sum + item.quantity * (item.rate || 0), 0)

    // Create the GRN as DRAFT (no stock yet), then run the SHARED confirmation so mobile
    // approvals get identical billing + LP traceability as the web confirm path. Previously
    // this created the GRN directly as CONFIRMED via createGrnWithLineItems, which wrote
    // stock serials with no lp_record_id and never staged the INBOUND_HANDLING charge.
    const createdGrn = await createGrnWithLineItems(db, {
      header: {
        ...payload.header,
        total_items: lineItems.length,
        total_quantity: totalQuantity,
        total_value: totalValue,
        source_channel: payload.source_channel || "MOBILE_OCR",
        status: "DRAFT",
      },
      lineItems,
      createdBy: session.userId,
    })

    const confirmed = await confirmGrnInTransaction(db, {
      companyId: session.companyId,
      userId: session.userId,
      grnId: Number(createdGrn.id),
    })

    await db.query(
      `UPDATE mobile_grn_captures
       SET status = 'APPROVED',
           approved_grn_id = $1,
           approved_by = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [createdGrn.id, session.userId, id]
    )

    await db.query("COMMIT")
    return ok(
      { capture_id: Number(id), grn_id: confirmed.id, status: confirmed.status },
      "Mobile GRN approved"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof GrnConfirmError) {
      return fail(error.code, error.message, error.status)
    }
    const message = error instanceof Error ? error.message : "Failed to approve capture"
    return fail("APPROVAL_FAILED", message, 400)
  } finally {
    db.release()
  }
}

