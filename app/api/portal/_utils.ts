import { TokenPayload } from "@/lib/auth"
import { canAccessClient, hasExplicitPortalPermissions, resolvePortalFeaturePermissions } from "@/lib/portal"
import { getUserAccessProfile } from "@/lib/rbac"

export async function parseAndAuthorizeClientId(
  session: TokenPayload,
  rawClientId: string | null
): Promise<{ ok: true; clientId: number } | { ok: false; code: string; message: string; status: number }> {
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
  const access = await getUserAccessProfile(session.userId, session.role)
  return access.permissions
}

export async function hasPortalPermission(session: TokenPayload, permission: string) {
  if (session.role === "SUPER_ADMIN") return true
  const permissions = await getPortalPermissions(session)
  return permissions.includes(permission)
}

export async function hasPortalFeaturePermission(session: TokenPayload, featureKey: string) {
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return true
  const hasExplicit = await hasExplicitPortalPermissions(session)
  if (!hasExplicit) {
    return true
  }
  const allowed = await resolvePortalFeaturePermissions(session)
  return allowed.includes(featureKey)
}
