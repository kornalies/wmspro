import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import { nextDocumentNumber, setDOStatus } from "@/lib/outbound-tail"

type RouteContext = {
  params: Promise<{ id: string }>
}

/**
 * Close loading and raise the (still PENDING) delivery note.
 *
 * Stock does not move here. The note exists so the driver has paperwork; the
 * stock only leaves the books when that note is finalized.
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
    const loadId = Number(id)
    if (!loadId) return fail("VALIDATION_ERROR", "Invalid load id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const load = await db.query(
      `SELECT id, load_number, status, do_header_id, warehouse_id, client_id
       FROM outbound_loads
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
      [session.companyId, loadId]
    )
    if (!load.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Load not found", 404)
    }

    const row = load.rows[0]
    requireScope(policy, "warehouse", Number(row.warehouse_id))
    requireScope(policy, "client", Number(row.client_id))

    const currentStatus = String(row.status)
    if (currentStatus !== "OPEN") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot complete a ${currentStatus} load`, 409)
    }

    const totals = await db.query(
      `SELECT COUNT(*)::int AS pack_units, COALESCE(SUM(quantity), 0)::int AS total_quantity
       FROM outbound_load_pack_units
       WHERE company_id = $1
         AND load_id = $2`,
      [session.companyId, loadId]
    )
    const packUnits = Number(totals.rows[0].pack_units)
    const totalQuantity = Number(totals.rows[0].total_quantity)
    if (packUnits <= 0) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Cannot complete a load with no pack units", 409)
    }

    await db.query(
      `UPDATE outbound_loads
       SET status = 'LOADED',
           loaded_at = CURRENT_TIMESTAMP,
           loaded_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [session.userId, session.companyId, loadId]
    )

    const doId = Number(row.do_header_id)
    const dnNumber = await nextDocumentNumber(db, "delivery_note_number_seq", "DN")

    const dn = await db.query(
      `INSERT INTO delivery_note_header (
         company_id, delivery_note_number, load_id, do_header_id, warehouse_id, client_id,
         status, total_pack_units, total_quantity
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)
       RETURNING id`,
      [
        session.companyId,
        dnNumber,
        loadId,
        doId,
        Number(row.warehouse_id),
        Number(row.client_id),
        packUnits,
        totalQuantity,
      ]
    )
    const deliveryNoteId = Number(dn.rows[0].id)

    // Note lines are the per-DO-line rollup of everything on the load.
    await db.query(
      `INSERT INTO delivery_note_lines (
         company_id, delivery_note_id, do_line_item_id, item_id, quantity
       )
       SELECT $1, $2, s.do_line_item_id, s.item_id, COUNT(*)::int
       FROM outbound_load_pack_units lp
       JOIN do_pack_unit_serials s
         ON s.pack_unit_id = lp.pack_unit_id AND s.company_id = lp.company_id
       WHERE lp.company_id = $1
         AND lp.load_id = $3
       GROUP BY s.do_line_item_id, s.item_id`,
      [session.companyId, deliveryNoteId, loadId]
    )

    await setDOStatus(db, session.companyId, doId, "LOADED")

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.load.complete",
        entityType: "outbound_loads",
        entityId: String(loadId),
        before: { status: currentStatus },
        after: {
          status: "LOADED",
          do_status: "LOADED",
          delivery_note_number: dnNumber,
          total_quantity: totalQuantity,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: loadId,
        load_number: String(row.load_number),
        status: "LOADED",
        do_id: doId,
        do_status: "LOADED",
        delivery_note_id: deliveryNoteId,
        delivery_note_number: dnNumber,
        total_quantity: totalQuantity,
      },
      "Load completed and delivery note raised"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to complete load"
    return fail("LOAD_COMPLETE_FAILED", message, 400)
  } finally {
    db.release()
  }
}