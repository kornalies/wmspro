import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { getTransferSeparateApprover } from "@/lib/company-settings"
import {
  StockTransferError,
  approveTransfer,
  cancelTransfer,
  dispatchTransfer,
  pickTransfer,
  receiveTransfer,
} from "@/lib/stock-transfer"

type RouteContext = { params: Promise<{ id: string }> }

/**
 * One route for every state change, chosen by `action`.
 *
 * The alternative -- /approve, /dispatch, /receive, /cancel as separate routes --
 * spreads one state machine across four files that each have to re-derive the
 * same guards. lib/stock-transfer.ts owns the transition table; this is the door.
 */
export async function GET(request: NextRequest, context: RouteContext) {
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

    const { id } = await context.params
    const transferId = Number(id)
    if (!Number.isFinite(transferId)) return fail("VALIDATION_ERROR", "Invalid transfer id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const header = await db.query(
      `SELECT h.*, c.client_name,
              fw.warehouse_name AS from_warehouse_name,
              tw.warehouse_name AS to_warehouse_name
         FROM stock_transfer_header h
         LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
         LEFT JOIN warehouses fw ON fw.id = h.from_warehouse_id AND fw.company_id = h.company_id
         LEFT JOIN warehouses tw ON tw.id = h.to_warehouse_id AND tw.company_id = h.company_id
        WHERE h.company_id = $1 AND h.id = $2`,
      [session.companyId, transferId]
    )
    if (!header.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", `Transfer ${transferId} not found`, 404)
    }

    const lines = await db.query(
      `SELECT l.*, i.item_code, i.item_name
         FROM stock_transfer_lines l
         JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.transfer_id = $2
        ORDER BY l.line_number`,
      [session.companyId, transferId]
    )

    const serials = await db.query(
      `SELECT sts.serial_id, sts.received, s.serial_number, s.status, s.batch_number,
              s.expiry_date, i.item_code
         FROM stock_transfer_serials sts
         JOIN stock_serial_numbers s ON s.id = sts.serial_id AND s.company_id = sts.company_id
         JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
        WHERE sts.company_id = $1 AND sts.transfer_id = $2
        ORDER BY s.serial_number`,
      [session.companyId, transferId]
    )

    await db.query("COMMIT")
    return ok({ transfer: header.rows[0], lines: lines.rows, serials: serials.rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load transfer"
    return fail("TRANSFER_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
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

    const { id } = await context.params
    const transferId = Number(id)
    if (!Number.isFinite(transferId)) return fail("VALIDATION_ERROR", "Invalid transfer id", 400)

    const body = (await request.json().catch(() => ({}))) as {
      action?: string
      picked_serial_ids?: number[]
      received_serial_ids?: number[]
      vehicle_number?: string
      driver_name?: string
      remarks?: string
    }
    const action = String(body.action ?? "").toLowerCase()

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    let result: Record<string, unknown>
    let message: string

    switch (action) {
      case "approve": {
        // Approving is the one action that is not just workflow: since migration
        // 072 it places a real hold on inventory, so it carries its own
        // permission rather than the operator-level one the rest share.
        requirePermission(session, "stock.transfer.approve")
        const transfer = await approveTransfer(db, session.companyId, transferId, session.userId, {
          requireSeparateApprover: await getTransferSeparateApprover(db, session.companyId),
        })
        result = { transfer }
        message = `Transfer ${transfer.transfer_number} approved`
        break
      }
      case "pick": {
        const out = await pickTransfer(db, session.companyId, transferId, {
          serialIds: body.picked_serial_ids ?? null,
          userId: session.userId,
        })
        result = { transfer: out.transfer, picked: out.picked }
        message = `Transfer ${out.transfer.transfer_number} picked — ${out.picked} unit(s) staged for dispatch`
        break
      }
      case "dispatch": {
        const out = await dispatchTransfer(db, session.companyId, transferId, {
          vehicleNumber: body.vehicle_number ?? null,
          driverName: body.driver_name ?? null,
          userId: session.userId,
        })
        result = { transfer: out.transfer, sent: out.sent }
        message = `Transfer ${out.transfer.transfer_number} dispatched — ${out.sent} unit(s) in transit`
        break
      }
      case "receive": {
        const out = await receiveTransfer(db, session.companyId, transferId, {
          receivedSerialIds: body.received_serial_ids ?? null,
          remarks: body.remarks ?? null,
          userId: session.userId,
        })
        result = { transfer: out.transfer, received: out.received, short: out.short }
        // Received stock has no bin yet, and the next action is a put-away. Say
        // so here rather than leaving the operator to discover it.
        message = out.short
          ? `Transfer received short — ${out.received} arrived, ${out.short} did not. ${out.received} unit(s) are awaiting put-away.`
          : `Transfer ${out.transfer.transfer_number} received in full — ${out.received} unit(s) awaiting put-away`
        break
      }
      case "cancel": {
        const out = await cancelTransfer(db, session.companyId, transferId, session.userId)
        result = { transfer: out.transfer, released: out.released }
        message = out.released
          ? `Transfer ${out.transfer.transfer_number} cancelled — ${out.released} unit(s) released back to stock`
          : `Transfer ${out.transfer.transfer_number} cancelled`
        break
      }
      default:
        await db.query("ROLLBACK")
        return fail(
          "VALIDATION_ERROR",
          "action must be approve, pick, dispatch, receive or cancel",
          400
        )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: `stock.transfer.${action}`,
        entityType: "stock_transfer_header",
        entityId: transferId,
        after: result,
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(result, message)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof StockTransferError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Transfer action failed"
    return fail("TRANSFER_ACTION_FAILED", message, 400)
  } finally {
    db.release()
  }
}
