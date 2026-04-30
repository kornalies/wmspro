import { getSession } from "@/lib/auth"
import { revokeAuthSession } from "@/lib/auth-session-store"
import { fail, ok } from "@/lib/api-response"
import { securityTelemetry } from "@/lib/security-telemetry"

export async function POST() {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }
    if ((session.actorType ?? "").toLowerCase() !== "mobile") {
      securityTelemetry.onEvent("mobile_auth_actor_scope_rejected", "route=/api/mobile/auth/logout")
      return fail("FORBIDDEN", "Token actor scope is not allowed for mobile auth logout", 403)
    }
    if (session.sessionId) {
      await revokeAuthSession(session.sessionId, "mobile_logout")
    }
    return ok(null, "Logged out successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Logout failed"
    return fail("LOGOUT_FAILED", message, 400)
  }
}
