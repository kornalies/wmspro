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

type RouteContext = {
  params: Promise<{ id: string }>
}

/**
 * Void a pack unit and hand its serials back to the packable pool.
 *
 * Packing is the one step in the tail where a human picks the stock by hand, so
 * it is the step where a wrong scan actually happens -- serial ...1234 instead
 * of ...1222. Until now there was no way back: create and close were the only
 * pack-unit endpoints, so a mis-scan could only be undone by reversing the whole
 * delivery order, and reversal does not free packed serials at all. An operator
 * who scanned one digit wrong had to abandon the order.
 *
 * The serial links are deleted rather than flagged. Every consumer -- the
 * packable pool's anti-join, the outstanding-quantity ceiling, the goods issue
 * roll-up -- derives from do_pack_unit_serials, so removing the rows releases
 * the stock everywhere at once instead of requiring each of them to learn about
 * a new "ignore voided units" rule and one of them forgetting. The pack unit row
 * survives as CANCELLED, and the audit entry records exactly which serials came
 * out, so the void is still traceable after the links are gone.
 *
 * Voiding is refused once the unit is issued or loaded. Past goods issue the
 * unit is on a document the customer may already have seen, and unpicking it
 * silently would leave that document lying; those cases reverse the DO instead.
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
    const packUnitId = Number(id)
    if (!packUnitId) return fail("VALIDATION_ERROR", "Invalid pack unit id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const unit = await db.query(
      `SELECT u.id, u.pack_code, u.status, u.total_quantity, u.do_header_id,
              u.warehouse_id, u.client_id,
              (gi.pack_unit_id IS NOT NULL) AS is_issued,
              (lp.pack_unit_id IS NOT NULL) AS is_loaded
       FROM do_pack_units u
       LEFT JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       LEFT JOIN outbound_load_pack_units lp
         ON lp.pack_unit_id = u.id AND lp.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.id = $2
       FOR UPDATE OF u`,
      [session.companyId, packUnitId]
    )
    if (!unit.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Pack unit not found", 404)
    }

    const row = unit.rows[0]
    requireScope(policy, "warehouse", Number(row.warehouse_id))
    requireScope(policy, "client", Number(row.client_id))

    const currentStatus = String(row.status)
    if (currentStatus === "CANCELLED") {
      await db.query("ROLLBACK")
      return ok({ id: packUnitId, status: "CANCELLED" }, "Pack unit already voided")
    }
    if (row.is_issued) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        `Pack unit ${row.pack_code} is already on a goods issue and cannot be voided. Reverse the delivery order instead.`,
        409
      )
    }
    if (row.is_loaded) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        `Pack unit ${row.pack_code} is already on a load and cannot be voided. Reverse the delivery order instead.`,
        409
      )
    }

    // Captured before the delete so the audit trail still names the stock.
    const releasedRows = await db.query(
      `SELECT s.serial_number
       FROM do_pack_unit_serials pus
       JOIN stock_serial_numbers s ON s.id = pus.serial_id AND s.company_id = pus.company_id
       WHERE pus.company_id = $1
         AND pus.pack_unit_id = $2
       ORDER BY s.serial_number`,
      [session.companyId, packUnitId]
    )
    const releasedSerials = releasedRows.rows.map((r: { serial_number: unknown }) =>
      String(r.serial_number)
    )

    await db.query(
      `DELETE FROM do_pack_unit_serials
       WHERE company_id = $1
         AND pack_unit_id = $2`,
      [session.companyId, packUnitId]
    )

    await db.query(
      `UPDATE do_pack_units
       SET status = 'CANCELLED',
           total_quantity = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, packUnitId]
    )

    // Voiding the last live pack unit puts the DO back where it was before
    // packing started, so the screen offers the pack step again rather than
    // stranding the order in PACKED with nothing packed.
    const remaining = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM do_pack_units
       WHERE company_id = $1
         AND do_header_id = $2
         AND status <> 'CANCELLED'`,
      [session.companyId, Number(row.do_header_id)]
    )
    const liveUnits = Number(remaining.rows[0]?.n ?? 0)
    let revertedStatus: string | null = null
    if (liveUnits === 0) {
      const reverted = await db.query(
        `UPDATE do_header
         SET status = 'PICKED',
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $1
           AND id = $2
           AND status = 'PACKED'
         RETURNING status`,
        [session.companyId, Number(row.do_header_id)]
      )
      if (reverted.rows.length) revertedStatus = "PICKED"
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.pack.unit.cancel",
        entityType: "do_pack_units",
        entityId: String(packUnitId),
        before: {
          status: currentStatus,
          total_quantity: Number(row.total_quantity),
          serials: releasedSerials,
        },
        after: {
          status: "CANCELLED",
          total_quantity: 0,
          released_serial_count: releasedSerials.length,
          ...(revertedStatus ? { do_status: revertedStatus } : {}),
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: packUnitId,
        pack_code: String(row.pack_code),
        status: "CANCELLED",
        released_serial_count: releasedSerials.length,
        do_status: revertedStatus,
      },
      `Pack unit voided. ${releasedSerials.length} serial(s) returned to the packable pool.`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to void pack unit"
    return fail("PACK_UNIT_CANCEL_FAILED", message, 400)
  } finally {
    db.release()
  }
}
