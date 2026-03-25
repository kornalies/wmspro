import type { EffectivePolicy } from "@/lib/policy/effective"

const cache = new Map<string, { expiresAt: number; policy: EffectivePolicy }>()

export function getCachedPolicy(cacheKey: string): EffectivePolicy | null {
  const hit = cache.get(cacheKey)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    cache.delete(cacheKey)
    return null
  }
  return hit.policy
}

export function setCachedPolicy(cacheKey: string, policy: EffectivePolicy, ttlMs: number) {
  cache.set(cacheKey, { policy, expiresAt: Date.now() + ttlMs })
}

export function invalidateEffectivePolicyCache(companyId?: number) {
  if (!companyId) {
    cache.clear()
    return
  }

  const prefix = `${companyId}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}
