import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { StockTransferError, createTransfer } from "@/lib/stock-transfer"

/** The transfer register, and the way a new one is raised. */
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
    const status = searchParams.get("status")

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const rows = await db.query(
      `SELECT h.*,
              c.client_name,
              fw.warehouse_name AS from_warehouse_name,
              tw.warehouse_name AS to_warehouse_name,
              (SELECT COUNT(*)::int FROM stock_transfer_lines l
                WHERE l.transfer_id = h.id) AS line_count,
              (SELECT COALESCE(SUM(l.quantity_requested), 0)::int FROM stock_transfer_lines l
                WHERE l.transfer_id = h.id) AS qty_requested,
              (SELECT COALESCE(SUM(l.quantity_sent), 0)::int FROM stock_transfer_lines l
                WHERE l.transfer_id = h.id) AS qty_sent,
              (SELECT COALESCE(SUM(l.quantity_received), 0)::int FROM stock_transfer_lines l
                WHERE l.transfer_id = h.id) AS qty_received
         FROM stock_transfer_header h
         LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
         LEFT JOIN warehouses fw ON fw.id = h.from_warehouse_id AND fw.company_id = h.company_id
         LEFT JOIN warehouses tw ON tw.id = h.to_warehouse_id AND tw.company_id = h.company_id
        WHERE h.company_id = $1
          AND ($2::text IS NULL OR h.status = $2)
        ORDER BY h.id DESC
        LIMIT 200`,
      [session.companyId, status]
    )

    await db.query("COMMIT")
    return ok({
      rows: rows.rows.map((row) => ({
        ...row,
        // A transfer that arrived short is the case worth surfacing in a list:
        // it is finished, so nothing else will draw attention to it.
        short_units:
          row.status === "RECEIVED" ? Number(row.qty_sent ?? 0) - Number(row.qty_received ?? 0) : 0,
      })),
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load transfers"
    return fail("TRANSFER_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}

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

    const body = (await request.json().catch(() => ({}))) as {
      client_id?: number
      from_warehouse_id?: number
      to_warehouse_id?: number
      reason?: string
      expected_date?: string
      remarks?: string
      lines?: Array<{ item_id: number; quantity: number; uom?: string; remarks?: string }>
    }

    const clientId = Number(body.client_id)
    const fromWarehouseId = Number(body.from_warehouse_id)
    const toWarehouseId = Number(body.to_warehouse_id)
    if (![clientId, fromWarehouseId, toWarehouseId].every(Number.isFinite)) {
      return fail(
        "VALIDATION_ERROR",
        "client_id, from_warehouse_id and to_warehouse_id are required",
        400
      )
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const transfer = await createTransfer(db, session.companyId, {
      clientId,
      fromWarehouseId,
      toWarehouseId,
      lines: body.lines ?? [],
      reason: body.reason ?? null,
      expectedDate: body.expected_date ?? null,
      remarks: body.remarks ?? null,
      userId: session.userId,
    })

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.transfer.created",
        entityType: "stock_transfer_header",
        entityId: Number(transfer.id),
        after: { transfer_number: transfer.transfer_number, lines: body.lines?.length ?? 0 },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(transfer, `Transfer ${transfer.transfer_number} created`)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof StockTransferError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to create transfer"
    return fail("TRANSFER_CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
