import { getSession } from "@/lib/auth"
import { fail } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { getUserAccessProfile } from "@/lib/rbac"

type WesAccess = {
  companyId: number
  userId: number
  canManage: boolean
}

function hasPermission(permissions: string[] | undefined, key: string) {
  return Array.isArray(permissions) && permissions.includes(key)
}

export async function getWesAccess() {
  try {
    const session = await getSession()
    if (!session) return { error: fail("UNAUTHORIZED", "Unauthorized", 401) as Response }
    await assertProductEnabled(session.companyId, "WMS")

    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "wes")

    const access = await getUserAccessProfile(session.userId, session.role)
    const canView =
      hasPermission(access.permissions, "wes.view") ||
      hasPermission(access.permissions, "wes.manage") ||
      session.role === "SUPER_ADMIN"
    if (!canView) return { error: fail("FORBIDDEN", "Insufficient permissions", 403) as Response }

    const wesAccess: WesAccess = {
      companyId: session.companyId,
      userId: session.userId,
      canManage:
        hasPermission(access.permissions, "wes.manage") ||
        session.role === "SUPER_ADMIN",
    }
    return { access: wesAccess }
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return { error: productGuarded as Response }
    const guarded = guardToFailResponse(error)
    if (guarded) return { error: guarded as Response }
    const message = error instanceof Error ? error.message : "Failed to validate WES access"
    return { error: fail("SERVER_ERROR", message, 500) as Response }
  }
}
