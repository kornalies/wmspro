import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { requireFeature, requirePolicyPermission, guardToFailResponse } from "@/lib/policy/guards"
import { writeAudit } from "@/lib/audit"

// Roles allowed to hold a put-away override PIN. Must match the approver set in
// wms-mobile-api (putaway.service.ts) and the shared-schema index
// (db/migrations/054_add_putaway_supervisor_pin.sql).
const PUTAWAY_APPROVER_ROLES = ["SUPERVISOR", "WAREHOUSE_MANAGER", "ADMIN", "SUPER_ADMIN"]

const setSchema = z.object({
  user_id: z.number().positive(),
  // 4-12 digits keeps it a PIN, not a password. Adjust here if policy changes.
  pin: z.string().regex(/^\d{4,12}$/, "PIN must be 4-12 digits"),
})

const clearSchema = z.object({
  // Sent as a query param on DELETE (apiClient.delete carries no body), so coerce.
  user_id: z.coerce.number().positive(),
})

async function loadTarget(
  db: Awaited<ReturnType<typeof getClient>>,
  userId: number
) {
  const res = await db.query(
    `SELECT id, username, full_name, role, company_id, is_active,
            (putaway_pin_hash IS NOT NULL) AS has_pin
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [userId]
  )
  return res.rows[0] as
    | {
        id: number
        username: string
        full_name: string
        role: string
        company_id: number
        is_active: boolean
        has_pin: boolean
      }
    | undefined
}

// Set or reset a supervisor's put-away override PIN (stored as a bcrypt hash).
export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "admin.users.manage")

    const payload = setSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const target = await loadTarget(db, payload.user_id)

    if (!target) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "User not found", 404)
    }
    if (
      !session.permissions?.includes("admin.companies.manage") &&
      Number(target.company_id) !== Number(session.companyId)
    ) {
      await db.query("ROLLBACK")
      return fail("FORBIDDEN", "Cannot manage a user from another company", 403)
    }
    if (!target.is_active) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Cannot set a PIN for an inactive user", 400)
    }
    if (!PUTAWAY_APPROVER_ROLES.includes(target.role)) {
      await db.query("ROLLBACK")
      return fail(
        "VALIDATION_ERROR",
        `Only ${PUTAWAY_APPROVER_ROLES.join(", ")} roles can hold a put-away PIN`,
        400
      )
    }

    const hash = await bcrypt.hash(payload.pin, 10)
    await db.query(
      `UPDATE users
       SET putaway_pin_hash = $1,
           putaway_pin_set_at = CURRENT_TIMESTAMP,
           putaway_pin_set_by = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [hash, session.userId, payload.user_id]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        // Never log the PIN itself -- only that it was set/reset.
        action: target.has_pin ? "user.putaway_pin_reset" : "user.putaway_pin_set",
        entityType: "users",
        entityId: payload.user_id,
        before: { has_pin: target.has_pin },
        after: { has_pin: true },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      { id: target.id, username: target.username, has_pin: true },
      target.has_pin ? "Put-away PIN reset" : "Put-away PIN set"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof z.ZodError) {
      return fail("VALIDATION_ERROR", error.issues[0]?.message || "Invalid input", 400)
    }
    const message = error instanceof Error ? error.message : "Failed to set put-away PIN"
    return fail("PUTAWAY_PIN_FAILED", message, 400)
  } finally {
    db.release()
  }
}

// Clear a supervisor's put-away override PIN.
export async function DELETE(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "admin")
    requirePolicyPermission(policy, "admin.users.manage")

    const payload = clearSchema.parse({
      user_id: request.nextUrl.searchParams.get("user_id"),
    })

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const target = await loadTarget(db, payload.user_id)

    if (!target) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "User not found", 404)
    }
    if (
      !session.permissions?.includes("admin.companies.manage") &&
      Number(target.company_id) !== Number(session.companyId)
    ) {
      await db.query("ROLLBACK")
      return fail("FORBIDDEN", "Cannot manage a user from another company", 403)
    }

    await db.query(
      `UPDATE users
       SET putaway_pin_hash = NULL,
           putaway_pin_set_at = NULL,
           putaway_pin_set_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [session.userId, payload.user_id]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "user.putaway_pin_cleared",
        entityType: "users",
        entityId: payload.user_id,
        before: { has_pin: target.has_pin },
        after: { has_pin: false },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({ id: target.id, username: target.username, has_pin: false }, "Put-away PIN cleared")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof z.ZodError) {
      return fail("VALIDATION_ERROR", error.issues[0]?.message || "Invalid input", 400)
    }
    const message = error instanceof Error ? error.message : "Failed to clear put-away PIN"
    return fail("PUTAWAY_PIN_FAILED", message, 400)
  } finally {
    db.release()
  }
}
