import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM notifications
       WHERE user_id = $1
         AND read_at IS NULL`,
      [session.userId]
    )

    return ok({ count: result.rows[0]?.count ?? 0 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch unread count"
    return fail("SERVER_ERROR", message, 500)
  }
}