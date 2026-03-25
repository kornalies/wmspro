import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { getTenantSettings, updateTenantSettings } from "@/lib/policy/repo"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"
import type { TenantSettingsShape } from "@/lib/policy/schema"

const workflowSchema = z.object({
  requireGateInBeforeGrn: z.boolean().optional(),
  requireQc: z.boolean().optional(),
  disallowDispatchIfPaymentHold: z.boolean().optional(),
})

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "settings.read")

    const row = await getTenantSettings(session.companyId)
    return ok({
      config_version: row.configVersion,
      workflow_policies: row.settings.workflow_policies,
      updated_by: row.updatedBy,
      updated_at: row.updatedAt,
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch workflow policies"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "settings.update")

    const payload = workflowSchema.parse(await request.json())
    const updated = await updateTenantSettings({
      companyId: session.companyId,
      actorUserId: session.userId,
      patch: {
        workflow_policies: payload as TenantSettingsShape["workflow_policies"],
      },
      req: request,
    })

    return ok({
      config_version: updated.configVersion,
      workflow_policies: updated.settings.workflow_policies,
      updated_by: updated.updatedBy,
      updated_at: updated.updatedAt,
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update workflow policies"
    return fail("UPDATE_FAILED", message, 400)
  }
}
