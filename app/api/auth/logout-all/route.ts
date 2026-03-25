import { z } from "zod"

import { getSession } from "@/lib/auth"
import { revokeAllAuthSessionsForUser } from "@/lib/auth-session-store"
import { fail, ok } from "@/lib/api-response"

const logoutAllSchema = z
  .object({
    keep_current_session: z.boolean().optional(),
    actor_type: z.enum(["web", "mobile", "portal", "system"]).optional(),
  })
  .optional()

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }

    const body = logoutAllSchema.parse(await request.json().catch(() => undefined))
    const keepCurrent = body?.keep_current_session ?? true
    const revoked = await revokeAllAuthSessionsForUser(
      {
        userId: session.userId,
        actorType: body?.actor_type,
        exceptSessionId: keepCurrent ? session.sessionId : undefined,
      },
      "logout_all"
    )

    const response = ok({ revoked_sessions: revoked }, "Sessions revoked")
    if (!keepCurrent) {
      response.cookies.delete("token")
    }
    return response
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to revoke sessions"
    return fail("LOGOUT_ALL_FAILED", message, 400)
  }
}
