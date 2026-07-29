import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { stageChargeTransaction } from "@/lib/billing-service"
import { getOutboundBillingTrigger } from "@/lib/company-settings"
import { isDOStatus } from "@/lib/do-status"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import { OutboundStockError, commitPackedSerials } from "@/lib/outbound-stock"

type RouteContext = {
  params: Promise<{ id: string }>
}

/**
 * Finalize the delivery note. This is the stock-out event for the new outbound
 * tail: the exact serials that were packed and loaded go to DISPATCHED and the
 * DO's dispatched totals move. Everything earlier in the tail was paperwork.
 *
 * Uses commitPackedSerials rather than FIFO re-selection so the stock that
 * leaves the books is the stock that physically left the building.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { id } = await context.params
    const deliveryNoteId = Number(id)
    if (!deliveryNoteId) return fail("VALIDATION_ERROR", "Invalid delivery note id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const dn = await db.query(
      `SELECT id, delivery_note_number, status, load_id, do_header_id, warehouse_id, client_id
       FROM delivery_note_header
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, deliveryNoteId]
    )
    if (!dn.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Delivery note not found", 404)
    }

    const note = dn.rows[0]
    requireScope(policy, "warehouse", Number(note.warehouse_id))
    requireScope(policy, "client", Number(note.client_id))

    const currentStatus = String(note.status)
    if (currentStatus === "COMPLETED") {
      await db.query("ROLLBACK")
      return ok(
        { id: deliveryNoteId, status: "COMPLETED" },
        "Delivery note already finalized"
      )
    }
    if (currentStatus !== "PENDING") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot finalize a ${currentStatus} delivery note`, 409)
    }

    const doId = Number(note.do_header_id)
    await db.query(`SELECT id FROM do_header WHERE company_id = $1 AND id = $2 FOR UPDATE`, [
      session.companyId,
      doId,
    ])

    // The serials physically on this load, grouped by DO line.
    const packed = await db.query(
      `SELECT s.do_line_item_id, ARRAY_AGG(s.serial_id ORDER BY s.serial_id) AS serial_ids
       FROM outbound_load_pack_units lp
       JOIN do_pack_unit_serials s
         ON s.pack_unit_id = lp.pack_unit_id AND s.company_id = lp.company_id
       WHERE lp.company_id = $1
         AND lp.load_id = $2
       GROUP BY s.do_line_item_id`,
      [session.companyId, Number(note.load_id)]
    )
    if (!packed.rows.length) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Delivery note has no packed stock to commit", 409)
    }

    let committed = 0
    for (const row of packed.rows) {
      const serialIds = (row.serial_ids as unknown[]).map((value) => Number(value))
      committed += await commitPackedSerials(db, {
        companyId: session.companyId,
        doLineItemId: Number(row.do_line_item_id),
        serialIds,
      })
    }

    const totals = await db.query(
      `SELECT COALESCE(SUM(quantity_requested), 0)::int AS total_requested,
              COALESCE(SUM(quantity_dispatched), 0)::int AS total_dispatched
       FROM do_line_items
       WHERE company_id = $1
         AND do_header_id = $2`,
      [session.companyId, doId]
    )
    const totalRequested = Number(totals.rows[0].total_requested)
    const totalDispatched = Number(totals.rows[0].total_dispatched)

    const nextStatusCandidate =
      totalRequested > 0 && totalDispatched >= totalRequested
        ? "COMPLETED"
        : totalDispatched > 0
          ? "PARTIALLY_FULFILLED"
          : "LOADED"
    if (!isDOStatus(nextStatusCandidate)) {
      await db.query("ROLLBACK")
      return fail("DO_STATUS_INVALID", `Computed invalid DO status ${nextStatusCandidate}`, 409)
    }

    await db.query(
      `UPDATE do_header
       SET total_quantity_dispatched = $1,
           dispatched_qty = $1,
           status = $2,
           dispatch_date = COALESCE(dispatch_date, CURRENT_DATE),
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $3
         AND id = $4`,
      [totalDispatched, nextStatusCandidate, session.companyId, doId]
    )

    // A5: a tenant on the default DISPATCH trigger is billed at the point stock
    // commits -- which, on this path, is here rather than the dispatch route.
    // Without this a DISPATCH tenant using the new tail would ship unbilled.
    // GOODS_ISSUE tenants were already staged by the goods issue document.
    const billingTrigger = await getOutboundBillingTrigger(db, session.companyId)
    let stagedCharge = false
    if (billingTrigger === "DISPATCH" && committed > 0) {
      const eventDate = new Date().toISOString().slice(0, 10)
      const doRef = await db.query(
        `SELECT do_number FROM do_header WHERE company_id = $1 AND id = $2`,
        [session.companyId, doId]
      )
      await stageChargeTransaction(db, {
        companyId: session.companyId,
        userId: session.userId,
        clientId: Number(note.client_id),
        warehouseId: Number(note.warehouse_id),
        chargeType: "OUTBOUND_HANDLING",
        sourceType: "DO",
        sourceDocId: doId,
        sourceRefNo: String(doRef.rows[0]?.do_number ?? doId),
        eventDate,
        periodFrom: eventDate,
        periodTo: eventDate,
        quantity: committed,
        uom: "UNIT",
        remarks: `Auto staged on delivery note ${String(note.delivery_note_number)}`,
      })
      stagedCharge = true
    }

    await db.query(
      `UPDATE delivery_note_header
       SET status = 'COMPLETED',
           finalized_at = CURRENT_TIMESTAMP,
           finalized_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [session.userId, session.companyId, deliveryNoteId]
    )

    // Physical exit record, same as the legacy dispatch route produces.
    const load = await db.query(
      `SELECT vehicle_number, driver_name, driver_phone, transport_company
       FROM outbound_loads
       WHERE company_id = $1 AND id = $2`,
      [session.companyId, Number(note.load_id)]
    )
    const vehicle = load.rows[0]
    if (vehicle?.vehicle_number) {
      await db.query(
        `INSERT INTO gate_out (
           company_id, gate_out_number, gate_out_datetime, warehouse_id, client_id,
           do_header_id, truck_number, driver_name, driver_phone, transport_company, created_by
         )
         VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          session.companyId,
          `GOUT-${String(note.delivery_note_number)}`,
          Number(note.warehouse_id),
          Number(note.client_id),
          doId,
          String(vehicle.vehicle_number),
          vehicle.driver_name ?? null,
          vehicle.driver_phone ?? null,
          vehicle.transport_company ?? null,
          session.userId,
        ]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.delivery.finalize",
        entityType: "delivery_note_header",
        entityId: String(deliveryNoteId),
        before: { status: currentStatus, do_status: "LOADED" },
        after: {
          status: "COMPLETED",
          do_status: nextStatusCandidate,
          serials_committed: committed,
          total_quantity_dispatched: totalDispatched,
          billing_trigger: billingTrigger,
          staged_outbound_handling: stagedCharge,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: deliveryNoteId,
        delivery_note_number: String(note.delivery_note_number),
        status: "COMPLETED",
        do_id: doId,
        do_status: nextStatusCandidate,
        serials_committed: committed,
        total_quantity_dispatched: totalDispatched,
        staged_outbound_handling: stagedCharge,
      },
      "Delivery finalized and stock released"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundStockError) return fail(error.code, error.message, 409)
    const message = error instanceof Error ? error.message : "Failed to finalize delivery"
    return fail("DELIVERY_FINALIZE_FAILED", message, 400)
  } finally {
    db.release()
  }
}