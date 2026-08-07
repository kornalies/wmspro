import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { AdjustmentError, createAdjustment } from "@/lib/inventory-adjustment"
import { listTransferExceptions } from "@/lib/stock-transfer"

/** Stock that left a warehouse and never turned up. */
export async function GET(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "reports.view")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")

    const { searchParams } = new URL(request.url)
    const rawWarehouse = searchParams.get("warehouse_id")
    const warehouseId = rawWarehouse ? Number(rawWarehouse) : null
    if (rawWarehouse && !Number.isFinite(warehouseId)) {
      return fail("VALIDATION_ERROR", "warehouse_id must be a number", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const rows = await listTransferExceptions(db, session.companyId, { warehouseId })
    await db.query("COMMIT")

    return ok({
      rows,
      short_receipt_units: rows.filter((r) => r.bucket === "SHORT_RECEIPT").length,
      overdue_units: rows.filter((r) => r.bucket === "OVERDUE").length,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load transfer exceptions"
    return fail("TRANSFER_EXCEPTIONS_FAILED", message, 400)
  } finally {
    db.release()
  }
}

/**
 * Turn a transfer's lost units into a write-off.
 *
 * Deliberately creates a DRAFT adjustment rather than approving one. The whole
 * design of adjustments is that a draft changes nothing and approval is the only
 * thing that touches stock — a worklist button that silently wrote off inventory
 * would route around the control that exists precisely for this.
 *
 * Only SHORT_RECEIPT units are eligible. An overdue transfer is still in flight;
 * writing it off would be giving up on stock that may well arrive tomorrow.
 */
export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")

    const body = (await request.json().catch(() => ({}))) as { transfer_id?: number }
    const transferId = Number(body.transfer_id)
    if (!Number.isFinite(transferId)) {
      return fail("VALIDATION_ERROR", "transfer_id is required", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const all = await listTransferExceptions(db, session.companyId)
    const lost = all.filter((r) => r.transfer_id === transferId && r.bucket === "SHORT_RECEIPT")
    if (!lost.length) {
      await db.query("ROLLBACK")
      return fail(
        "VALIDATION_ERROR",
        "That transfer has no units to write off — it is either still in flight or fully received",
        400
      )
    }

    // Grouped by item because an adjustment line is per item and names its
    // serials; a transfer that lost units of two items is one adjustment with
    // two lines, not two adjustments.
    const byItem = new Map<number, typeof lost>()
    for (const row of lost) {
      const existing = byItem.get(row.item_id)
      if (existing) existing.push(row)
      else byItem.set(row.item_id, [row])
    }

    const first = lost[0]
    const adjustment = await createAdjustment(db, session.companyId, {
      clientId: first.client_id,
      // The units were last accountable to the sender: they never reached the
      // destination, so writing them off there would claim they arrived.
      warehouseId: first.from_warehouse_id,
      reasonCode: "LOSS",
      reason: `Lost in transit on ${first.transfer_number}`,
      referenceNo: first.transfer_number,
      sourceModule: "TRANSFER",
      sourceRef: first.transfer_number,
      lines: [...byItem.entries()].map(([itemId, rows]) => ({
        item_id: itemId,
        direction: "DECREASE" as const,
        serials: rows.map((r) => r.serial_number),
        batch_number: rows[0].batch_number,
        remarks: `Dispatched ${rows[0].dispatched_at ?? "?"}, never received`,
      })),
      userId: session.userId,
    })

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.transfer.write_off_drafted",
        entityType: "inventory_adjustment_header",
        entityId: Number(adjustment.id),
        after: { transfer_number: first.transfer_number, units: lost.length },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      { adjustment, units: lost.length },
      `Draft write-off ${adjustment.adjustment_number} raised for ${lost.length} unit(s) lost on ${first.transfer_number} — it changes nothing until approved`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof AdjustmentError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to raise write-off"
    return fail("TRANSFER_WRITE_OFF_FAILED", message, 400)
  } finally {
    db.release()
  }
}
