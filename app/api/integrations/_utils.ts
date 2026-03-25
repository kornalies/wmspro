import { getSession } from "@/lib/auth"
import { fail } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { getUserAccessProfile } from "@/lib/rbac"

type IntegrationAccess = {
  companyId: number
  userId: number
  permissions: string[]
  canManage: boolean
}

function hasPermission(permissions: string[] | undefined, key: string) {
  return Array.isArray(permissions) && permissions.includes(key)
}

export async function getIntegrationAccess() {
  try {
    const session = await getSession()
    if (!session) return { error: fail("UNAUTHORIZED", "Unauthorized", 401) as Response }

    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "integrations")

    const access = await getUserAccessProfile(session.userId, session.role)
    const permissions = access.permissions

    const canView =
      hasPermission(permissions, "integration.view") ||
      hasPermission(permissions, "integration.manage") ||
      session.role === "SUPER_ADMIN"
    if (!canView) return { error: fail("FORBIDDEN", "Insufficient permissions", 403) as Response }

    const integrationAccess: IntegrationAccess = {
      companyId: session.companyId,
      userId: session.userId,
      permissions,
      canManage: hasPermission(permissions, "integration.manage") || session.role === "SUPER_ADMIN",
    }
    return { access: integrationAccess }
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return { error: guarded as Response }
    const message = error instanceof Error ? error.message : "Failed to validate integration access"
    return { error: fail("SERVER_ERROR", message, 500) as Response }
  }
}
