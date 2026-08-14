import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { setInviteTokenContext } from "@/lib/portal"

const activateSchema = z.object({
  token: z.string().min(12),
  password: z.string().min(6).max(120),
})

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const payload = activateSchema.parse(await request.json())

    await db.query("BEGIN")
    // The invitee has no session, so the token is the only thing that makes this
    // row visible under RLS. Set before the lookup; the tenant context set below
    // is what authorises the writes that follow.
    await setInviteTokenContext(db, payload.token)
    const inviteResult = await db.query(
      `SELECT id, company_id, user_id, status, expires_at
       FROM portal_user_invites
       WHERE invite_token = $1
       LIMIT 1
       FOR UPDATE`,
      [payload.token]
    )
    if (!inviteResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Invite token not found", 404)
    }
    const invite = inviteResult.rows[0]
    const status = String(invite.status || "")
    const expired = new Date(String(invite.expires_at)).getTime() < Date.now()
    if (status !== "PENDING" || expired) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Invite is expired or already used", 400)
    }

    await setTenantContext(db, Number(invite.company_id))
    const passwordHash = await bcrypt.hash(payload.password, 10)
    await db.query(
      `UPDATE users
       SET password_hash = $1,
           is_active = true,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND company_id = $3`,
      [passwordHash, Number(invite.user_id), Number(invite.company_id)]
    )
    await db.query(
      `UPDATE portal_user_invites
       SET status = 'ACCEPTED',
           accepted_at = NOW()
       WHERE id = $1`,
      [Number(invite.id)]
    )
    await db.query("COMMIT")
    return ok({ user_id: Number(invite.user_id) }, "Portal account activated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to activate portal account"
    return fail("ACTIVATION_FAILED", message, 400)
  } finally {
    db.release()
  }
}

