import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { AdjustmentError, approveAdjustment, rejectAdjustment } from "@/lib/inventory-adjustment"

type RouteContext = { params: Promise<{ id: string }> }

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
    const adjustmentId = Number(id)
    if (!Number.isFinite(adjustmentId)) return fail("VALIDATION_ERROR", "Invalid adjustment id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const header = await db.query(
      `SELECT h.*, c.client_name, w.warehouse_name
         FROM inventory_adjustment_header h
         LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
         LEFT JOIN warehouses w ON w.id = h.warehouse_id AND w.company_id = h.company_id
        WHERE h.company_id = $1 AND h.id = $2`,
      [session.companyId, adjustmentId]
    )
    if (!header.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", `Adjustment ${adjustmentId} not found`, 404)
    }

    const lines = await db.query(
      `SELECT l.*, i.item_code, i.item_name,
              (SELECT COALESCE(json_agg(s.serial_number ORDER BY s.serial_number), '[]'::json)
                 FROM inventory_adjustment_serials s WHERE s.adjustment_line_id = l.id) AS serials
         FROM inventory_adjustment_lines l
         JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.adjustment_id = $2
        ORDER BY l.line_number`,
      [session.companyId, adjustmentId]
    )

    await db.query("COMMIT")
    return ok({ adjustment: header.rows[0], lines: lines.rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load adjustment"
    return fail("ADJUSTMENT_READ_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    // Approving an adjustment writes stock off, so it needs the same permission
    // as any other stock mutation rather than a read-only reporting role.
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")

    const { id } = await context.params
    const adjustmentId = Number(id)
    if (!Number.isFinite(adjustmentId)) return fail("VALIDATION_ERROR", "Invalid adjustment id", 400)

    const body = (await request.json().catch(() => ({}))) as { action?: string; reason?: string }
    const action = String(body.action ?? "").toLowerCase()

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    let result: Record<string, unknown>
    let message: string

    if (action === "approve") {
      const out = await approveAdjustment(db, session.companyId, adjustmentId, session.userId)
      result = { adjustment: out.adjustment, decreased: out.decreased, increased: out.increased }
      message = `Adjustment ${out.adjustment.adjustment_number} approved — ${out.decreased} written off, ${out.increased} added`
    } else if (action === "reject") {
      const adjustment = await rejectAdjustment(db, session.companyId, adjustmentId, {
        reason: body.reason ?? null,
        userId: session.userId,
      })
      result = { adjustment }
      message = `Adjustment ${adjustment.adjustment_number} rejected — stock is unchanged`
    } else {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "action must be approve or reject", 400)
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: `stock.adjustment.${action}`,
        entityType: "inventory_adjustment_header",
        entityId: adjustmentId,
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
    if (error instanceof AdjustmentError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Adjustment action failed"
    return fail("ADJUSTMENT_ACTION_FAILED", message, 400)
  } finally {
    db.release()
  }
}
