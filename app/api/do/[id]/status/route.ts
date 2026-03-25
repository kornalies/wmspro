import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import {
  DO_WORKFLOW_STATUSES,
  getDOStatusErrorMessage,
  isDOWorkflowStatus,
  normalizeDOStatus,
} from "@/lib/do-status"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

const statusSchema = z.object({
  status: z.string().trim().min(1),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const dbClient = await getClient()
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
    const rawRef = decodeURIComponent(id).trim()
    const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
    const doNumber = numericId ? null : rawRef
    if (!numericId && !doNumber) {
      return fail("VALIDATION_ERROR", "Invalid delivery order reference", 400)
    }

    const payload = statusSchema.parse(await request.json())
    const normalizedRequestedStatus = normalizeDOStatus(payload.status)
    if (!normalizedRequestedStatus) {
      return fail("VALIDATION_ERROR", getDOStatusErrorMessage(payload.status), 400)
    }
    if (!isDOWorkflowStatus(normalizedRequestedStatus)) {
      return fail(
        "VALIDATION_ERROR",
        `DO workflow status must be one of: ${DO_WORKFLOW_STATUSES.join(", ")}`,
        400
      )
    }

    await dbClient.query("BEGIN")
    await setTenantContext(dbClient, session.companyId)

    const doResult = await dbClient.query(
      `SELECT id, do_number, status, warehouse_id, client_id, total_quantity_dispatched
       FROM do_header
       WHERE company_id = $1
         AND (
           ($2::int IS NOT NULL AND id = $2)
           OR ($3::text IS NOT NULL AND do_number ILIKE $3)
         )
       FOR UPDATE`,
      [session.companyId, numericId, doNumber]
    )
    if (!doResult.rows.length) {
      await dbClient.query("ROLLBACK")
      return fail("NOT_FOUND", "Delivery Order not found", 404)
    }

    const doHeader = doResult.rows[0]
    const doId = Number(doHeader.id)
    const currentStatus = normalizeDOStatus(doHeader.status)
    if (!currentStatus) {
      await dbClient.query("ROLLBACK")
      return fail("DO_STATUS_INVALID", getDOStatusErrorMessage(doHeader.status), 409)
    }
    requireScope(policy, "warehouse", doHeader.warehouse_id)
    requireScope(policy, "client", doHeader.client_id)

    if (currentStatus === "CANCELLED" || currentStatus === "COMPLETED") {
      await dbClient.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", `Cannot update workflow for ${currentStatus} DO`, 409)
    }

    if (normalizedRequestedStatus === "PICKED") {
      if (!["DRAFT", "PENDING", "PICKED"].includes(currentStatus)) {
        await dbClient.query("ROLLBACK")
        return fail("WORKFLOW_BLOCKED", `Cannot mark PICKED from status ${currentStatus}`, 409)
      }
    }

    if (normalizedRequestedStatus === "STAGED") {
      if (!["PICKED", "STAGED"].includes(currentStatus)) {
        await dbClient.query("ROLLBACK")
        return fail("WORKFLOW_BLOCKED", `Cannot mark STAGED from status ${currentStatus}`, 409)
      }
    }

    const nextStatus = normalizedRequestedStatus
    await dbClient.query(
      `UPDATE do_header
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND id = $3`,
      [nextStatus, session.companyId, doId]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.workflow.status",
        entityType: "do_header",
        entityId: String(doId),
        before: {
          status: currentStatus,
          total_quantity_dispatched: doHeader.total_quantity_dispatched,
        },
        after: {
          status: nextStatus,
          total_quantity_dispatched: doHeader.total_quantity_dispatched,
        },
        req: request,
      },
      dbClient
    )

    await dbClient.query("COMMIT")
    return ok(
      {
        id: doId,
        do_number: doHeader.do_number,
        status: nextStatus,
      },
      "DO workflow status updated"
    )
  } catch (error: unknown) {
    await dbClient.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update DO workflow status"
    return fail("DO_STATUS_UPDATE_FAILED", message, 400)
  } finally {
    dbClient.release()
  }
}
