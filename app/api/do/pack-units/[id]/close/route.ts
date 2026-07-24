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
 * Close a pack unit. A closed unit accepts no further stock and is the only
 * thing a goods issue will pick up -- mirroring eFreight's "Pallet Close".
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
      `SELECT id, pack_code, status, total_quantity, warehouse_id, client_id
       FROM do_pack_units
       WHERE company_id = $1
         AND id = $2
       FOR UPDATE`,
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
    if (currentStatus === "CLOSED") {
      await db.query("ROLLBACK")
      return ok({ id: packUnitId, status: "CLOSED" }, "Pack unit already closed")
    }
    if (currentStatus !== "OPEN") {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot close a ${currentStatus} pack unit`, 409)
    }
    if (Number(row.total_quantity) <= 0) {
      await db.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Cannot close an empty pack unit", 409)
    }

    await db.query(
      `UPDATE do_pack_units
       SET status = 'CLOSED',
           closed_at = CURRENT_TIMESTAMP,
           closed_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [session.userId, session.companyId, packUnitId]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.pack.unit.close",
        entityType: "do_pack_units",
        entityId: String(packUnitId),
        before: { status: currentStatus },
        after: { status: "CLOSED" },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      { id: packUnitId, pack_code: String(row.pack_code), status: "CLOSED" },
      "Pack unit closed"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to close pack unit"
    return fail("PACK_UNIT_CLOSE_FAILED", message, 400)
  } finally {
    db.release()
  }
}