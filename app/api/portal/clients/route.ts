import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { resolvePermittedClientIds } from "@/lib/portal"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const clientIds = await resolvePermittedClientIds(session)
    if (!clientIds.length) return ok([])

    const result = await query(
      `SELECT id, client_code, client_name
       FROM clients
       WHERE id = ANY($1::int[])
       ORDER BY client_name ASC`,
      [clientIds]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch portal clients"
    return fail("SERVER_ERROR", message, 500)
  }
}
