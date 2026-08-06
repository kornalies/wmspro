import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { AdjustmentError, createAdjustment } from "@/lib/inventory-adjustment"

/**
 * The adjustment register — the report half of the Inventory Adjustment Report.
 *
 * It answers the question a client actually asks: why did my stock figure move
 * when nothing was received or shipped. Totals are split by direction because
 * netting them hides the case worth seeing, a large write-off offset by a large
 * find in the same period.
 */
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
    const from = searchParams.get("from")
    const to = searchParams.get("to")

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const rows = await db.query(
      `SELECT h.*,
              c.client_name,
              w.warehouse_name,
              (SELECT COALESCE(SUM(l.quantity) FILTER (WHERE l.direction = 'DECREASE'), 0)::int
                 FROM inventory_adjustment_lines l WHERE l.adjustment_id = h.id) AS units_decreased,
              (SELECT COALESCE(SUM(l.quantity) FILTER (WHERE l.direction = 'INCREASE'), 0)::int
                 FROM inventory_adjustment_lines l WHERE l.adjustment_id = h.id) AS units_increased,
              (SELECT COUNT(*)::int FROM inventory_adjustment_lines l WHERE l.adjustment_id = h.id) AS line_count
         FROM inventory_adjustment_header h
         LEFT JOIN clients c ON c.id = h.client_id AND c.company_id = h.company_id
         LEFT JOIN warehouses w ON w.id = h.warehouse_id AND w.company_id = h.company_id
        WHERE h.company_id = $1
          AND ($2::text IS NULL OR h.status = $2)
          AND ($3::date IS NULL OR h.adjustment_date >= $3::date)
          AND ($4::date IS NULL OR h.adjustment_date <= $4::date)
        ORDER BY h.id DESC
        LIMIT 200`,
      [session.companyId, status, from, to]
    )

    await db.query("COMMIT")

    const approved = rows.rows.filter((r) => r.status === "APPROVED")
    return ok({
      totals: {
        adjustments: rows.rows.length,
        pending: rows.rows.filter((r) => r.status === "DRAFT").length,
        // Only approved rows moved stock. Counting drafts here would overstate
        // the loss and make the report unusable as evidence.
        units_written_off: approved.reduce((sum, r) => sum + Number(r.units_decreased ?? 0), 0),
        units_added: approved.reduce((sum, r) => sum + Number(r.units_increased ?? 0), 0),
      },
      rows: rows.rows,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to load adjustments"
    return fail("ADJUSTMENT_READ_FAILED", message, 400)
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
      warehouse_id?: number
      reason_code?: string
      reason?: string
      reference_no?: string
      lines?: Array<{
        item_id: number
        direction: "INCREASE" | "DECREASE"
        serials: string[]
        grn_line_item_id?: number
        batch_number?: string
        expiry_date?: string
        bin_location?: string
        remarks?: string
      }>
    }

    const clientId = Number(body.client_id)
    const warehouseId = Number(body.warehouse_id)
    if (!Number.isFinite(clientId) || !Number.isFinite(warehouseId)) {
      return fail("VALIDATION_ERROR", "client_id and warehouse_id are required", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const adjustment = await createAdjustment(db, session.companyId, {
      clientId,
      warehouseId,
      reasonCode: String(body.reason_code ?? ""),
      reason: body.reason ?? null,
      referenceNo: body.reference_no ?? null,
      lines: body.lines ?? [],
      userId: session.userId,
    })

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.adjustment.created",
        entityType: "inventory_adjustment_header",
        entityId: Number(adjustment.id),
        after: {
          adjustment_number: adjustment.adjustment_number,
          reason_code: adjustment.reason_code,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      adjustment,
      `Adjustment ${adjustment.adjustment_number} raised — stock is unchanged until it is approved`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof AdjustmentError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to raise adjustment"
    return fail("ADJUSTMENT_CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
