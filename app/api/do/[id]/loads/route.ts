import { NextRequest } from "next/server"
import { z } from "zod"

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
import {
  OutboundTailError,
  assertDOStatusIn,
  lockDO,
  nextDocumentNumber,
} from "@/lib/outbound-tail"

type RouteContext = {
  params: Promise<{ id: string }>
}

const createLoadSchema = z.object({
  vehicle_number: z.string().trim().min(3).max(50),
  driver_name: z.string().trim().min(2).max(120),
  driver_phone: z.string().trim().min(3).max(40),
  container_number: z.string().trim().max(50).optional(),
  seal_number: z.string().trim().max(50).optional(),
  transport_company: z.string().trim().max(150).optional(),
  loading_bay: z.string().trim().max(50).optional(),
  pack_unit_ids: z.array(z.number().positive()).min(1),
})

/**
 * Open a load and put issued pack units on it.
 *
 * One load carries one vehicle, matching how a loading bay actually works and
 * matching eFreight's constraint. Pack units must already be on a goods issue --
 * you cannot ship what was never issued.
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
    const payload = createLoadSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const doRow = await lockDO(db, session.companyId, id)
    requireScope(policy, "warehouse", doRow.warehouseId)
    requireScope(policy, "client", doRow.clientId)
    assertDOStatusIn(doRow, ["ISSUED", "LOADED"], "load")

    // Eligible = issued, on this DO, not already on another load.
    const eligible = await db.query(
      `SELECT u.id, u.total_quantity, gi.goods_issue_id
       FROM do_pack_units u
       JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       LEFT JOIN outbound_load_pack_units lp
         ON lp.pack_unit_id = u.id AND lp.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.do_header_id = $2
         AND u.status = 'CLOSED'
         AND lp.id IS NULL
         AND u.id = ANY($3::int[])
       ORDER BY u.id ASC
       FOR UPDATE OF u`,
      [session.companyId, doRow.id, payload.pack_unit_ids]
    )
    if (eligible.rows.length !== payload.pack_unit_ids.length) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        "One or more pack units are not issued, not on this DO, or already loaded",
        409
      )
    }

    const loadNumber = await nextDocumentNumber(db, "outbound_load_number_seq", "LOAD")
    const goodsIssueId = Number(eligible.rows[0].goods_issue_id) || null

    const load = await db.query(
      `INSERT INTO outbound_loads (
         company_id, load_number, do_header_id, goods_issue_id, warehouse_id, client_id,
         status, vehicle_number, container_number, seal_number, driver_name, driver_phone,
         transport_company, loading_bay, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        session.companyId,
        loadNumber,
        doRow.id,
        goodsIssueId,
        doRow.warehouseId,
        doRow.clientId,
        payload.vehicle_number,
        payload.container_number ?? null,
        payload.seal_number ?? null,
        payload.driver_name,
        payload.driver_phone,
        payload.transport_company ?? null,
        payload.loading_bay ?? null,
        session.userId,
      ]
    )
    const loadId = Number(load.rows[0].id)

    let totalQuantity = 0
    for (const row of eligible.rows) {
      totalQuantity += Number(row.total_quantity)
      await db.query(
        `INSERT INTO outbound_load_pack_units (company_id, load_id, pack_unit_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [session.companyId, loadId, Number(row.id), Number(row.total_quantity)]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.load.create",
        entityType: "outbound_loads",
        entityId: String(loadId),
        before: { do_status: doRow.status },
        after: {
          load_number: loadNumber,
          vehicle_number: payload.vehicle_number,
          pack_units: eligible.rows.length,
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
        load_number: loadNumber,
        do_id: doRow.id,
        status: "OPEN",
        pack_units: eligible.rows.length,
        total_quantity: totalQuantity,
      },
      "Load created"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundTailError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to create load"
    return fail("LOAD_CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}