import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requireRole } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"

const QC_DISPOSITION_ROLES = ["SUPERVISOR", "WAREHOUSE_MANAGER", "ADMIN", "SUPER_ADMIN"]

const dispositionSchema = z.object({
  hold_id: z.string().uuid(),
  disposition: z.enum(["RELEASE", "SCRAP", "RETURN_TO_VENDOR", "REWORK"]),
})

// Per-disposition outcome: the serial status the quarantined units move to, the
// status stamped on the hold, and the mobile LP mirror status. REWORK leaves the
// stock quarantined (RESERVED) for a later re-inspection.
const DISPOSITION_EFFECTS = {
  RELEASE: { serialStatus: "IN_STOCK", holdStatus: "RELEASED", lpStatus: "AVAILABLE" },
  SCRAP: { serialStatus: "CANCELLED", holdStatus: "SCRAPPED", lpStatus: "SCRAPPED" },
  RETURN_TO_VENDOR: { serialStatus: "CANCELLED", holdStatus: "RETURNED", lpStatus: "RETURNED" },
  REWORK: { serialStatus: null, holdStatus: "REWORK", lpStatus: "QUARANTINE" },
} as const

async function qcDispositionEnabled(companyId: number): Promise<boolean> {
  const result = await query(
    `SELECT COALESCE((settings ->> 'qc_disposition_enabled')::boolean, false) AS enabled
     FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  )
  return result.rows[0]?.enabled === true
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requireRole(session, QC_DISPOSITION_ROLES)
    if (!(await qcDispositionEnabled(session.companyId))) {
      return fail("FEATURE_DISABLED", "QC disposition workflow is not enabled for this tenant", 403)
    }

    const result = await query(
      `SELECT
         h.id AS hold_id,
         h.grn_line_item_id,
         h.lp_id,
         h.hold_reason,
         h.status,
         h.created_at,
         r.lp_code,
         r.sku,
         r.result,
         r.reason_code,
         r.rejected_qty,
         r.accepted_qty,
         r.quantity AS total_qty,
         r.remarks,
         r.submitted_at,
         u.full_name AS inspector_name
       FROM public.mobile_qc_holds h
       LEFT JOIN public.mobile_qc_results r ON r.id = h.qc_result_id
       LEFT JOIN public.users u ON u.id = r.worker_id
       WHERE h.company_id = $1
         AND h.status = 'OPEN'
       ORDER BY h.created_at ASC`,
      [session.companyId]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch QC holds"
    const status = message === "Insufficient permissions" ? 403 : 500
    return fail("SERVER_ERROR", message, status)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) {
      db.release()
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }
    requireRole(session, QC_DISPOSITION_ROLES)
    if (!(await qcDispositionEnabled(session.companyId))) {
      db.release()
      return fail("FEATURE_DISABLED", "QC disposition workflow is not enabled for this tenant", 403)
    }

    const { hold_id, disposition } = dispositionSchema.parse(await request.json())
    const effect = DISPOSITION_EFFECTS[disposition]

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    // Lock the hold; only an OPEN hold in this tenant can be dispositioned.
    const holdResult = await db.query(
      `SELECT id, qc_result_id, warehouse_id, client_id, grn_line_item_id, lp_id, approval_request_id
       FROM public.mobile_qc_holds
       WHERE id = $1 AND company_id = $2 AND status = 'OPEN'
       FOR UPDATE`,
      [hold_id, session.companyId]
    )
    if (!holdResult.rows.length) {
      await db.query("ROLLBACK")
      db.release()
      return fail("NOT_FOUND", "Open QC hold not found", 404)
    }
    const hold = holdResult.rows[0]

    // How many units this hold quarantined (the RESERVED serials to act on).
    const qtyResult = await db.query(
      `SELECT COALESCE(rejected_qty, 0)::int AS rejected_qty
       FROM public.mobile_qc_results WHERE id = $1`,
      [hold.qc_result_id]
    )
    const rejectedQty = Number(qtyResult.rows[0]?.rejected_qty ?? 0)

    // Move exactly the quarantined serials to the disposition's target status.
    // REWORK keeps them RESERVED, so no serial update runs.
    if (effect.serialStatus && rejectedQty > 0) {
      await db.query(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
           FROM public.stock_serial_numbers
           WHERE company_id = $1
             AND warehouse_id = $2
             AND client_id = $3
             AND grn_line_item_id = $4
             AND status = 'RESERVED'
         )
         UPDATE public.stock_serial_numbers ss
         SET status = $5,
             updated_at = NOW()
         FROM ranked
         WHERE ss.id = ranked.id
           AND ranked.rn <= $6`,
        [
          session.companyId,
          hold.warehouse_id,
          hold.client_id,
          hold.grn_line_item_id,
          effect.serialStatus,
          rejectedQty,
        ]
      )
    }

    await db.query(
      `UPDATE public.mobile_qc_holds
       SET status = $2,
           disposition = $3,
           resolved_by = $4,
           resolved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [hold_id, effect.holdStatus, disposition, session.userId]
    )

    // Terminal dispositions close the reject's approval request; REWORK leaves it
    // pending since the stock is still quarantined and awaiting re-inspection.
    if (hold.approval_request_id && disposition !== "REWORK") {
      await db.query(
        `UPDATE public.mobile_approval_requests
         SET status = 'APPROVED',
             payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          hold.approval_request_id,
          JSON.stringify({ disposition, resolved_by: session.userId }),
        ]
      )
    }

    // Keep the mobile LP mirror in step. A synthetic GRNLINE-* lp_id matches no
    // row here, so this is a safe no-op in that case.
    await db.query(
      `UPDATE public.mobile_lp_records
       SET status = $2, updated_at = NOW()
       WHERE id = $1`,
      [hold.lp_id, effect.lpStatus]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "qc.hold.dispositioned",
        entityType: "qc_hold",
        entityId: hold_id,
        after: {
          hold_id,
          disposition,
          hold_status: effect.holdStatus,
          serial_status: effect.serialStatus,
          rejected_qty: rejectedQty,
          grn_line_item_id: hold.grn_line_item_id,
          lp_id: hold.lp_id,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({ hold_id, disposition, status: effect.holdStatus }, "QC hold dispositioned")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to disposition QC hold"
    const status = message === "Insufficient permissions" ? 403 : 400
    return fail("DISPOSITION_FAILED", message, status)
  } finally {
    db.release()
  }
}