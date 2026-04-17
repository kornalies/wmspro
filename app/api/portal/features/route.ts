import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { hasPortalFeaturePermission } from "@/app/api/portal/_utils"

const PORTAL_FEATURE_KEYS = [
  "portal.inventory.view",
  "portal.orders.view",
  "portal.billing.view",
  "portal.reports.view",
  "portal.sla.view",
  "portal.sla.manage",
  "portal.dispute.view",
  "portal.dispute.create",
  "portal.dispute.manage",
  "portal.asn.view",
  "portal.asn.create",
] as const

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
    const message = error instanceof Error ? error.message : "Failed to fetch portal feature permissions"
    return fail("SERVER_ERROR", message, 500)
  }
}

