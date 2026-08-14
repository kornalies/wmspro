import { TokenPayload } from "@/lib/auth"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { canAccessClient, resolvePortalFeaturePermissions } from "@/lib/portal"
import { getUserAccessProfile } from "@/lib/rbac"

export async function parseAndAuthorizeClientId(
  session: TokenPayload,
  rawClientId: string | null
): Promise<{ ok: true; clientId: number } | { ok: false; code: string; message: string; status: number }> {
  await assertProductEnabled(session.companyId, "WMS")
  const clientId = Number(rawClientId)
  if (!clientId) {
    return { ok: false, code: "VALIDATION_ERROR", message: "client_id is required", status: 400 }
  }
  const allowed = await canAccessClient(session, clientId)
  if (!allowed) {
    return { ok: false, code: "FORBIDDEN", message: "No access to this client", status: 403 }
  }
  return { ok: true, clientId }
}

export async function getPortalPermissions(session: TokenPayload) {
  await assertProductEnabled(session.companyId, "WMS")
  const access = await getUserAccessProfile(session.userId, session.role)
  return access.permissions
}

export async function hasPortalPermission(session: TokenPayload, permission: string) {
  if (session.role === "SUPER_ADMIN") return true
  const permissions = await getPortalPermissions(session)
  return permissions.includes(permission)
}

/**
 * A portal feature is allowed only if it was granted.
 *
 * This used to fall open: a user with no rows in portal_user_permissions was
 * treated as unrestricted, so provisioning a portal user and forgetting the
 * feature grants handed them everything — billing, disputes, SLA — rather than
 * nothing. Migration 080 backfills the full key set for every portal user who
 * relied on that default, so flipping it here changes no existing user's access,
 * only what a newly created one starts with.
 */
export async function hasPortalFeaturePermission(session: TokenPayload, featureKey: string) {
  await assertProductEnabled(session.companyId, "WMS")
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return true
  const allowed = await resolvePortalFeaturePermissions(session)
  return allowed.includes(featureKey)
}

export { guardProductError as guardPortalProductError }
