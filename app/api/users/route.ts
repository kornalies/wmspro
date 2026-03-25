import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission } from "@/lib/policy/guards"

const createSchema = z.object({
  full_name: z.string().min(2),
  username: z.string().min(3),
  email: z.string().email(),
  role: z.string().min(2).max(50),
  password: z.string().min(6),
  is_active: z.boolean().optional(),
  warehouse_id: z.number().positive().nullable().optional(),
})

const updateSchema = z.object({
  id: z.number().positive(),
  full_name: z.string().min(2),
  username: z.string().min(3),
  email: z.string().email(),
  role: z.string().min(2).max(50),
  password: z.string().min(6).optional().or(z.literal("")),
  is_active: z.boolean().optional(),
  warehouse_id: z.number().positive().nullable().optional(),
})

async function requireUsersPolicy(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  const policy = await getEffectivePolicy(
    session.companyId,
    session.userId,
    resolvePolicyActorType(session)
  )
  requireFeature(policy, "admin")
  requirePolicyPermission(policy, "admin.users.manage")
  return policy
}

async function replaceUserRoleAssignment(userId: number, roleId: number, assignedBy: number) {
  await query("DELETE FROM rbac_user_roles WHERE user_id = $1", [userId])
  await query(
    `INSERT INTO rbac_user_roles (user_id, role_id, is_primary, assigned_by)
     VALUES ($1, $2, true, $3)
     ON CONFLICT (user_id, role_id)
     DO UPDATE SET is_primary = true, assigned_by = EXCLUDED.assigned_by, assigned_at = CURRENT_TIMESTAMP`,
    [userId, roleId, assignedBy]
  )
}

async function validateWarehouse(companyId: number, warehouseId?: number | null) {
  if (!warehouseId) return null
  const result = await query(
    `SELECT id
     FROM warehouses
     WHERE id = $1
       AND company_id = $2
       AND is_active = true
     LIMIT 1`,
    [warehouseId, companyId]
  )
  return result.rows.length ? warehouseId : null
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "admin.users.manage")
    await requireUsersPolicy(session)

    const result = await query(
      `SELECT
         u.id,
         u.username,
         u.full_name,
         u.email,
         COALESCE(rr.role_code, u.role) AS role,
         u.warehouse_id,
         w.warehouse_name,
         u.is_active,
         u.created_at
       FROM users u
       LEFT JOIN rbac_user_roles rur
         ON rur.user_id = u.id
        AND rur.is_primary = true
       LEFT JOIN rbac_roles rr
         ON rr.id = rur.role_id
        AND rr.is_active = true
       LEFT JOIN warehouses w ON w.id = u.warehouse_id AND w.company_id = u.company_id
       WHERE u.company_id = $1
       ORDER BY u.created_at DESC`
      ,
      [session.companyId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch users"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "admin.users.manage")
    await requireUsersPolicy(session)

    const payload = createSchema.parse(await request.json())
    const passwordHash = await bcrypt.hash(payload.password, 10)
    const warehouseId = await validateWarehouse(session.companyId, payload.warehouse_id)
    if (payload.warehouse_id && !warehouseId) {
      return fail("VALIDATION_ERROR", "Invalid warehouse", 400)
    }

    const roleCode = payload.role.toUpperCase()
    const roleResult = await query(
      "SELECT id, role_code FROM rbac_roles WHERE role_code = $1 AND is_active = true",
      [roleCode]
    )
    if (!roleResult.rows.length) {
      return fail("VALIDATION_ERROR", "Invalid role code", 400)
    }

    const result = await query(
      `INSERT INTO users (company_id, username, email, full_name, role, password_hash, is_active, warehouse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, username, full_name, email, role, warehouse_id, is_active, created_at`,
      [
        session.companyId,
        payload.username,
        payload.email,
        payload.full_name,
        roleCode,
        passwordHash,
        payload.is_active ?? true,
        warehouseId,
      ]
    )

    await replaceUserRoleAssignment(
      Number(result.rows[0].id),
      Number(roleResult.rows[0].id),
      session.userId
    )

    await writeAudit({
      companyId: session.companyId,
      actorUserId: session.userId,
      actorType: "web",
      action: "user.create",
      entityType: "users",
      entityId: result.rows[0].id,
      after: result.rows[0],
      req: request,
    })

    return ok(result.rows[0], "User created successfully")
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to create user"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "admin.users.manage")
    await requireUsersPolicy(session)

    const payload = updateSchema.parse(await request.json())
    const warehouseId = await validateWarehouse(session.companyId, payload.warehouse_id)
    if (payload.warehouse_id && !warehouseId) {
      return fail("VALIDATION_ERROR", "Invalid warehouse", 400)
    }
    const beforeResult = await query(
      `SELECT id, username, full_name, email, role, warehouse_id, is_active
       FROM users
       WHERE id = $1
         AND company_id = $2
       LIMIT 1`,
      [payload.id, session.companyId]
    )
    const before = beforeResult.rows[0] || null

    const roleCode = payload.role.toUpperCase()
    const roleResult = await query(
      "SELECT id, role_code FROM rbac_roles WHERE role_code = $1 AND is_active = true",
      [roleCode]
    )
    if (!roleResult.rows.length) {
      return fail("VALIDATION_ERROR", "Invalid role code", 400)
    }

    if (payload.password && payload.password.length > 0) {
      const passwordHash = await bcrypt.hash(payload.password, 10)
      const result = await query(
        `UPDATE users
         SET username = $1, email = $2, full_name = $3, role = $4, is_active = $5, password_hash = $6, warehouse_id = $7, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8 AND company_id = $9
         RETURNING id, username, full_name, email, role, warehouse_id, is_active, created_at`,
        [
          payload.username,
          payload.email,
          payload.full_name,
          roleCode,
          payload.is_active ?? true,
          passwordHash,
          warehouseId,
          payload.id,
          session.companyId,
        ]
      )
      if (result.rows.length) {
        await replaceUserRoleAssignment(
          payload.id,
          Number(roleResult.rows[0].id),
          session.userId
        )
        await writeAudit({
          companyId: session.companyId,
          actorUserId: session.userId,
          actorType: "web",
          action: "user.update",
          entityType: "users",
          entityId: payload.id,
          before,
          after: result.rows[0],
          req: request,
        })
      }
      return ok(result.rows[0], "User updated successfully")
    }

    const result = await query(
      `UPDATE users
       SET username = $1, email = $2, full_name = $3, role = $4, is_active = $5, warehouse_id = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND company_id = $8
       RETURNING id, username, full_name, email, role, warehouse_id, is_active, created_at`,
      [
        payload.username,
        payload.email,
        payload.full_name,
        roleCode,
        payload.is_active ?? true,
        warehouseId,
        payload.id,
        session.companyId,
      ]
    )
    if (result.rows.length) {
      await replaceUserRoleAssignment(
        payload.id,
        Number(roleResult.rows[0].id),
        session.userId
      )
      await writeAudit({
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "user.update",
        entityType: "users",
        entityId: payload.id,
        before,
        after: result.rows[0],
        req: request,
      })
    }

    return ok(result.rows[0], "User updated successfully")
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update user"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "admin.users.manage")
    await requireUsersPolicy(session)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "User id is required", 400)

    const beforeResult = await query(
      `SELECT id, username, full_name, email, role, is_active
       FROM users
       WHERE id = $1
         AND company_id = $2
       LIMIT 1`,
      [id, session.companyId]
    )
    const before = beforeResult.rows[0] || null

    await query(
      "UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2",
      [id, session.companyId]
    )
    await writeAudit({
      companyId: session.companyId,
      actorUserId: session.userId,
      actorType: "web",
      action: "user.disable",
      entityType: "users",
      entityId: id,
      before,
      after: { ...(before || {}), is_active: false },
      req: request,
    })
    return ok({ id }, "User deactivated")
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to delete user"
    return fail("DELETE_FAILED", message, 400)
  }
}
