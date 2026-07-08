import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { id } = await context.params

    const result = await query(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, session.userId]
    )

    if (!result.rows.length) {
      return fail("NOT_FOUND", "Notification not found", 404)
    }

    return ok({ id: result.rows[0].id })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to mark notification as read"
    return fail("SERVER_ERROR", message, 500)
  }
}