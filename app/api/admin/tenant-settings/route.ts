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
import { validateTenantSettings, type TenantSettingsShape } from "@/lib/policy/schema"

const updateSchema = z.object({
  feature_flags: z.record(z.string(), z.boolean()).optional(),
  security_policies: z.record(z.string(), z.unknown()).optional(),
  mobile_policies: z.record(z.string(), z.unknown()).optional(),
  ui_branding: z.record(z.string(), z.unknown()).optional(),
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
      company_id: row.companyId,
      config_version: row.configVersion,
      ...row.settings,
      updated_by: row.updatedBy,
      updated_at: row.updatedAt,
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch tenant settings"
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

    const payload = updateSchema.parse(await request.json())
    validateTenantSettings({
      ...(await getTenantSettings(session.companyId)).settings,
      ...payload,
    })

    const updated = await updateTenantSettings({
      companyId: session.companyId,
      actorUserId: session.userId,
      patch: payload as unknown as Partial<TenantSettingsShape>,
      req: request,
    })

    return ok({
      company_id: updated.companyId,
      config_version: updated.configVersion,
      ...updated.settings,
      updated_by: updated.updatedBy,
      updated_at: updated.updatedAt,
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update tenant settings"
    return fail("UPDATE_FAILED", message, 400)
  }
}
