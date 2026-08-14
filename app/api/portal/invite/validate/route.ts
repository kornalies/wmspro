import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { setInviteTokenContext } from "@/lib/portal"
import { getClient } from "@/lib/db"

export async function GET(request: NextRequest) {
  const db = await getClient()
  try {
    const token = String(request.nextUrl.searchParams.get("token") || "").trim()
    if (!token) return fail("VALIDATION_ERROR", "token is required", 400)

    // Not query() from lib/db: that helper derives the tenant context from the
    // caller's session, and an invitee has none yet. Under the RLS policy added
    // in migration 080 the row is reachable only by presenting the token, which
    // has to be set on this same transaction.
    await db.query("BEGIN")
    await setInviteTokenContext(db, token)

    const result = await db.query(
      `SELECT
         pui.id,
         pui.status,
         pui.expires_at,
         u.id AS user_id,
         u.username,
         u.full_name,
         u.email
       FROM portal_user_invites pui
       JOIN users u
         ON u.id = pui.user_id
        AND u.company_id = pui.company_id
       WHERE pui.invite_token = $1
       LIMIT 1`,
      [token]
    )
    await db.query("COMMIT")

    if (!result.rows.length) return fail("NOT_FOUND", "Invite token not found", 404)
    const row = result.rows[0]
    const expired = new Date(String(row.expires_at)).getTime() < Date.now()
    const valid = String(row.status) === "PENDING" && !expired

    return ok({
      valid,
      status: String(row.status),
      expires_at: row.expires_at,
      user: {
        id: Number(row.user_id),
        username: String(row.username),
        full_name: String(row.full_name || ""),
        email: String(row.email || ""),
      },
    })
  } catch (error: unknown) {
    try {
      await db.query("ROLLBACK")
    } catch {
      // Surface the original failure, not a rollback error on a dead connection.
    }
    const message = error instanceof Error ? error.message : "Failed to validate invite token"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}
