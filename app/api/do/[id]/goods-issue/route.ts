import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { stageChargeTransaction } from "@/lib/billing-service"
import { getOutboundBillingTrigger } from "@/lib/company-settings"
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
  setDOStatus,
} from "@/lib/outbound-tail"

type RouteContext = {
  params: Promise<{ id: string }>
}

const goodsIssueSchema = z.object({
  pack_unit_ids: z.array(z.number().positive()).optional(),
  remarks: z.string().trim().max(2000).optional(),
})

/**
 * Generate a Goods Issue over the DO's closed, not-yet-issued pack units.
 *
 * Stock is NOT decremented here -- the goods are declared issued but are still
 * physically in the building until the delivery note is finalized. That split is
 * the whole point of the document, and it is what lets a warehouse answer
 * "issued but not yet shipped".
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
    const payload = goodsIssueSchema.parse(await request.json().catch(() => ({})))

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const doRow = await lockDO(db, session.companyId, id)
    requireScope(policy, "warehouse", doRow.warehouseId)
    requireScope(policy, "client", doRow.clientId)
    assertDOStatusIn(doRow, ["PACKED", "STAGED", "ISSUED"], "generate a goods issue for")

    // Eligible = closed, belongs to this DO, not already on another goods issue.
    const eligible = await db.query(
      `SELECT u.id, u.total_quantity
       FROM do_pack_units u
       LEFT JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.do_header_id = $2
         AND u.status = 'CLOSED'
         AND gi.id IS NULL
         AND ($3::int[] IS NULL OR u.id = ANY($3::int[]))
       ORDER BY u.id ASC
       FOR UPDATE OF u`,
      [session.companyId, doRow.id, payload.pack_unit_ids ?? null]
    )

    if (!eligible.rows.length) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        "No closed, un-issued pack units available for this DO. Close a pack unit first.",
        409
      )
    }
    if (payload.pack_unit_ids && eligible.rows.length !== payload.pack_unit_ids.length) {
      await db.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        "One or more requested pack units are not closed, not on this DO, or already issued",
        409
      )
    }

    const totalQuantity = eligible.rows.reduce(
      (sum: number, row: { total_quantity: unknown }) => sum + Number(row.total_quantity),
      0
    )
    const giNumber = await nextDocumentNumber(db, "goods_issue_number_seq", "GI")

    const gi = await db.query(
      `INSERT INTO goods_issue_header (
         company_id, gi_number, do_header_id, warehouse_id, client_id,
         status, total_pack_units, total_quantity, issued_by, remarks
       )
       VALUES ($1, $2, $3, $4, $5, 'GENERATED', $6, $7, $8, $9)
       RETURNING id`,
      [
        session.companyId,
        giNumber,
        doRow.id,
        doRow.warehouseId,
        doRow.clientId,
        eligible.rows.length,
        totalQuantity,
        session.userId,
        payload.remarks ?? null,
      ]
    )
    const goodsIssueId = Number(gi.rows[0].id)

    for (const row of eligible.rows) {
      await db.query(
        `INSERT INTO goods_issue_pack_units (company_id, goods_issue_id, pack_unit_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [session.companyId, goodsIssueId, Number(row.id), Number(row.total_quantity)]
      )
    }

    await setDOStatus(db, session.companyId, doRow.id, "ISSUED")

    // A5: revenue recognition point. Tenants on the default DISPATCH trigger are
    // billed by the dispatch route exactly as before, so this stages nothing.
    const billingTrigger = await getOutboundBillingTrigger(db, session.companyId)
    let stagedCharge = false
    if (billingTrigger === "GOODS_ISSUE" && totalQuantity > 0) {
      const eventDate = new Date().toISOString().slice(0, 10)
      await stageChargeTransaction(db, {
        companyId: session.companyId,
        userId: session.userId,
        clientId: doRow.clientId,
        warehouseId: doRow.warehouseId,
        chargeType: "OUTBOUND_HANDLING",
        sourceType: "DO",
        sourceDocId: doRow.id,
        sourceRefNo: doRow.doNumber,
        eventDate,
        periodFrom: eventDate,
        periodTo: eventDate,
        quantity: totalQuantity,
        uom: "UNIT",
        remarks: `Auto staged on goods issue ${giNumber}`,
      })
      stagedCharge = true
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.goods.issue.generate",
        entityType: "goods_issue_header",
        entityId: String(goodsIssueId),
        before: { do_status: doRow.status },
        after: {
          do_status: "ISSUED",
          gi_number: giNumber,
          total_pack_units: eligible.rows.length,
          total_quantity: totalQuantity,
          billing_trigger: billingTrigger,
          staged_outbound_handling: stagedCharge,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: goodsIssueId,
        gi_number: giNumber,
        do_id: doRow.id,
        do_status: "ISSUED",
        total_pack_units: eligible.rows.length,
        total_quantity: totalQuantity,
        staged_outbound_handling: stagedCharge,
      },
      "Goods issue generated"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundTailError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to generate goods issue"
    return fail("GOODS_ISSUE_FAILED", message, 400)
  } finally {
    db.release()
  }
}