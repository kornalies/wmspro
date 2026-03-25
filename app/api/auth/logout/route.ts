import { getSession } from "@/lib/auth"
import { revokeAuthSession } from "@/lib/auth-session-store"
import { ok } from "@/lib/api-response"

export async function POST() {
  const session = await getSession()
  if (session?.sessionId) {
    await revokeAuthSession(session.sessionId, "logout")
  }
  const response = ok(null, "Logged out successfully")
  response.cookies.delete("token")
  return response
}
