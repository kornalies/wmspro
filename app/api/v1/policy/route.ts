import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const actorType = resolvePolicyActorType(session)
    const policy = await getEffectivePolicy(session.companyId, session.userId, actorType)
    return ok(policy)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to resolve policy"
    return fail("SERVER_ERROR", message, 500)
  }
}
