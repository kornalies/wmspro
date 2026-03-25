import { getSession } from "@/lib/auth"
import { revokeAuthSession } from "@/lib/auth-session-store"
import { fail, ok } from "@/lib/api-response"

export async function POST() {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
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
