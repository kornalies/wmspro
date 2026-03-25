import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { ensurePortalTables } from "@/lib/portal"
import { query } from "@/lib/db"

export async function GET(request: NextRequest) {
  try {
    await ensurePortalTables()
    const token = String(request.nextUrl.searchParams.get("token") || "").trim()
    if (!token) return fail("VALIDATION_ERROR", "token is required", 400)

    const result = await query(
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
    const message = error instanceof Error ? error.message : "Failed to validate invite token"
    return fail("SERVER_ERROR", message, 500)
  }
}

