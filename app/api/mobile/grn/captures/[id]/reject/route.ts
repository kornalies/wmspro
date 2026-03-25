import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMobileGrnCaptureSchema } from "@/lib/db-bootstrap"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.mobile.approve")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "mobile")
    requireFeature(policy, "grn")
    requirePolicyPermission(policy, "grn.mobile.approve")

    await ensureMobileGrnCaptureSchema()
    const { id } = await context.params

    const body = await request.json().catch(() => ({}))
    const notes = typeof body?.notes === "string" ? body.notes : null

    const result = await query(
      `UPDATE mobile_grn_captures
       SET status = 'REJECTED',
           notes = COALESCE($1, notes),
           approved_by = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'PENDING'
       RETURNING id`,
      [notes, session.userId, id]
    )

    if (!result.rows.length) {
      return fail("INVALID_STATUS", "Capture not found or not pending", 400)
    }

    return ok({ id: Number(id) }, "Mobile GRN rejected")
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to reject capture"
    return fail("REJECTION_FAILED", message, 400)
  }
}
