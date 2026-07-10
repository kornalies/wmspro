import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || "all"
    const limit = Math.min(Number(searchParams.get("limit")) || 30, 100)

    const result = await query(
      `SELECT id, source, type, title, body, data, read_at, created_at
       FROM notifications
       WHERE user_id = $1
         AND ($2 = 'all' OR read_at IS NULL)
       ORDER BY created_at DESC
       LIMIT $3`,
      [session.userId, status, limit]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch notifications"
    return fail("SERVER_ERROR", message, 500)
  }
}