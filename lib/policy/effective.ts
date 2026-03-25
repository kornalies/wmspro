import { query } from "@/lib/db"
import { getUserAccessProfile } from "@/lib/rbac"
import { getCachedPolicy, setCachedPolicy } from "@/lib/policy/cache"
import { getTenantSettings } from "@/lib/policy/repo"

export type PolicyActorType = "web" | "mobile" | "portal" | "system"

export type EffectivePolicy = {
  companyId: string
  configVersion: number
  features: Record<string, boolean>
  permissions: string[]
  scopes: {
    warehouseIds: string[]
    zoneIds: string[]
    clientIds: string[]
  }
  workflow: Record<string, unknown>
  security: Record<string, unknown>
  mobile: Record<string, unknown>
  branding: Record<string, unknown>
}

const DEFAULT_CACHE_TTL_MS = 90_000

function normalizeScopes(
  rows: Array<{ scope_type: string; scope_id: number }>
): EffectivePolicy["scopes"] {
  const warehouseIds = new Set<string>()
  const zoneIds = new Set<string>()
  const clientIds = new Set<string>()

  for (const row of rows) {
    const id = String(row.scope_id)
    if (row.scope_type === "warehouse") warehouseIds.add(id)
    if (row.scope_type === "zone") zoneIds.add(id)
    if (row.scope_type === "client") clientIds.add(id)
  }

  return {
    warehouseIds: Array.from(warehouseIds),
    zoneIds: Array.from(zoneIds),
    clientIds: Array.from(clientIds),
  }
}

export async function getEffectivePolicy(
  companyId: number,
  userId: number,
  actorType: PolicyActorType
): Promise<EffectivePolicy> {
  const tenantSettings = await getTenantSettings(companyId)
  const cacheKey = `${companyId}:${userId}:${actorType}:${tenantSettings.configVersion}`
  const cached = getCachedPolicy(cacheKey)
  if (cached) return cached

  const [access, scopeResult] = await Promise.all([
    getUserAccessProfile(userId),
    query(
      `SELECT scope_type, scope_id
       FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2`,
      [companyId, userId]
    ),
  ])

  const policy: EffectivePolicy = {
    companyId: String(companyId),
    configVersion: tenantSettings.configVersion,
    features: tenantSettings.settings.feature_flags,
    permissions: access.permissions,
    scopes: normalizeScopes(scopeResult.rows as Array<{ scope_type: string; scope_id: number }>),
    workflow: tenantSettings.settings.workflow_policies as Record<string, unknown>,
    security: tenantSettings.settings.security_policies as Record<string, unknown>,
    mobile: tenantSettings.settings.mobile_policies as Record<string, unknown>,
    branding: tenantSettings.settings.ui_branding as Record<string, unknown>,
  }

  setCachedPolicy(cacheKey, policy, DEFAULT_CACHE_TTL_MS)
  return policy
}

type SessionLike = {
  actorType?: string
  role?: string
}

export function resolvePolicyActorType(session: SessionLike): PolicyActorType {
  if (session.actorType === "mobile") return "mobile"
  if (session.actorType === "portal") return "portal"
  if (session.actorType === "system") return "system"

  const role = String(session.role || "").toUpperCase()
  if (role === "CLIENT" || role === "VIEWER") return "portal"
  return "web"
}
