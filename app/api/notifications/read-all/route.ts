import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    await query(
      `UPDATE notifications
       SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [session.userId]
    )

    return ok(null, "All notifications marked as read")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to mark notifications as read"
    return fail("SERVER_ERROR", message, 500)
  }
}