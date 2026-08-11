import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { getAdjustmentSeparateApprover } from "@/lib/company-settings"
import {
  AdjustmentError,
  approveAdjustment,
  cancelAdjustment,
  listOpenClaims,
  rejectAdjustment,
} from "@/lib/inventory-adjustment"

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

    // The serials carry their live status so an approver sees the units as they
    // are now, not as they were when the draft was raised. Approving a write-off
    // without being shown what it covers is the formality this screen exists to
    // stop.
    const lines = await db.query(
      `SELECT l.*, i.item_code, i.item_name,
              (SELECT COALESCE(json_agg(json_build_object(
                        'serial_number', ias.serial_number,
                        'status', ssn.status,
                        'batch_number', ssn.batch_number,
                        'expiry_date', ssn.expiry_date,
                        'bin_location', ssn.bin_location,
                        'quarantined', (ssn.adjustment_line_id = l.id)
                      ) ORDER BY ias.serial_number), '[]'::json)
                 FROM inventory_adjustment_serials ias
                 LEFT JOIN stock_serial_numbers ssn
                        ON ssn.id = ias.serial_id AND ssn.company_id = ias.company_id
                WHERE ias.adjustment_line_id = l.id AND ias.company_id = l.company_id) AS serials
         FROM inventory_adjustment_lines l
         JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.adjustment_id = $2
        ORDER BY l.line_number`,
      [session.companyId, adjustmentId]
    )

    // Read live rather than replayed from the draft-time warning: a delivery
    // order may have taken or released the unit since.
    const claims = await listOpenClaims(db, session.companyId, adjustmentId)

    await db.query("COMMIT")
    return ok({ adjustment: header.rows[0], lines: lines.rows, claims })
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

    const { id } = await context.params
    const adjustmentId = Number(id)
    if (!Number.isFinite(adjustmentId)) return fail("VALIDATION_ERROR", "Invalid adjustment id", 400)

    const body = (await request.json().catch(() => ({}))) as {
      action?: string
      reason?: string
      acknowledge_claims?: boolean
    }
    const action = String(body.action ?? "").toLowerCase()

    // Deciding an adjustment is a different authority from raising one: approval
    // is what destroys the stock. Withdrawing your own request needs no such
    // authority, so cancel stays on the permission an operator already holds.
    // See migration 077.
    requirePermission(
      session,
      action === "cancel" ? "stock.putaway.manage" : "stock.adjustment.approve"
    )
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    if (action === "approve" || action === "reject") {
      const separate = await getAdjustmentSeparateApprover(db, session.companyId)
      if (separate) {
        const raiser = await db.query(
          `SELECT created_by, adjustment_number FROM inventory_adjustment_header
            WHERE company_id = $1 AND id = $2`,
          [session.companyId, adjustmentId]
        )
        if (raiser.rows.length && Number(raiser.rows[0].created_by) === Number(session.userId)) {
          await db.query("ROLLBACK")
          return fail(
            "SEPARATE_APPROVER_REQUIRED",
            `Adjustment ${raiser.rows[0].adjustment_number} was raised by you, and this company requires a different person to decide it`,
            403
          )
        }
      }
    }

    let result: Record<string, unknown>
    let message: string

    if (action === "approve") {
      const out = await approveAdjustment(db, session.companyId, adjustmentId, {
        userId: session.userId,
        acknowledgeClaims: body.acknowledge_claims === true,
      })
      result = {
        adjustment: out.adjustment,
        decreased: out.decreased,
        increased: out.increased,
        released_claims: out.releasedClaims,
      }
      message =
        `Adjustment ${out.adjustment.adjustment_number} approved — ${out.decreased} written off, ${out.increased} added` +
        (out.releasedClaims.length
          ? `. ${out.releasedClaims.length} unit(s) were released from ${[
              ...new Set(out.releasedClaims.map((c) => c.claimed_by)),
            ].join(", ")} — those orders are now short`
          : "")
    } else if (action === "reject") {
      const out = await rejectAdjustment(db, session.companyId, adjustmentId, {
        reason: body.reason ?? null,
        userId: session.userId,
      })
      result = { adjustment: out.adjustment, released: out.released }
      message = `Adjustment ${out.adjustment.adjustment_number} rejected — stock is unchanged and ${out.released} unit(s) are available again`
    } else if (action === "cancel") {
      const out = await cancelAdjustment(db, session.companyId, adjustmentId, {
        reason: body.reason ?? null,
        userId: session.userId,
      })
      result = { adjustment: out.adjustment, released: out.released }
      message = `Adjustment ${out.adjustment.adjustment_number} withdrawn — ${out.released} unit(s) are available again`
    } else {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "action must be approve, reject or cancel", 400)
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
