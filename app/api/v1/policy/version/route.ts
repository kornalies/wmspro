import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getTenantSettings } from "@/lib/policy/repo"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const settings = await getTenantSettings(session.companyId)
    return ok({ configVersion: settings.configVersion })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch policy version"
    return fail("SERVER_ERROR", message, 500)
  }
}
