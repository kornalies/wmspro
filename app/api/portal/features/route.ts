import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { guardPortalProductError, hasPortalFeaturePermission } from "@/app/api/portal/_utils"
import { PORTAL_FEATURE_KEYS } from "@/lib/portal"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const checks = await Promise.all(
      PORTAL_FEATURE_KEYS.map(async (key) => [key, await hasPortalFeaturePermission(session, key)] as const)
    )

    const features = Object.fromEntries(checks) as Record<string, boolean>
    const allowed = checks.filter(([, v]) => v).map(([k]) => k)

    return ok({ features, allowed })
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch portal feature permissions"
    return fail("SERVER_ERROR", message, 500)
  }
}

