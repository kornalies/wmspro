import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

const createCompanySchema = z.object({
  company_code: z.string().trim().min(2).max(50),
  company_name: z.string().trim().min(2).max(150),
  domain: z.string().trim().max(150).optional().or(z.literal("")),
  storage_bucket: z.string().trim().max(120).optional().or(z.literal("")),
  subscription_plan: z.enum(["BASIC", "PRO", "ENTERPRISE"]).optional(),
  storage_used_gb: z.number().min(0).optional(),
  billing_status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED"]).optional(),
  admin_username: z.string().trim().min(3).max(60),
  admin_email: z.string().email(),
  admin_full_name: z.string().trim().min(2).max(120),
  admin_password: z.string().min(6).max(120),
})

const updateCompanySchema = z.object({
  id: z.number().positive(),
  company_code: z.string().trim().min(2).max(50),
  company_name: z.string().trim().min(2).max(150),
  domain: z.string().trim().max(150).optional().or(z.literal("")),
  storage_bucket: z.string().trim().max(120).optional().or(z.literal("")),
  subscription_plan: z.enum(["BASIC", "PRO", "ENTERPRISE"]).optional(),
  storage_used_gb: z.number().min(0).optional(),
  billing_status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED"]).optional(),
  is_active: z.boolean().optional(),
})

async function canManageCompanies(session: { role: string; permissions?: string[]; companyCode?: string }) {
  if (session.permissions?.includes("admin.companies.manage")) return true

  const superAdminCount = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'SUPER_ADMIN' AND is_active = true"
  )
  const hasAnySuperAdmin = Number(superAdminCount.rows[0]?.count || 0) > 0
  if (!hasAnySuperAdmin && session.role === "ADMIN" && session.companyCode === "DEFAULT") {
    return true
  }

  return false
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const allowed = await canManageCompanies(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can manage companies", 403)

    const result = await query(
      `SELECT
         c.id,
         c.company_code,
         c.company_name,
         c.domain,
         c.storage_bucket,
         c.subscription_plan,
         c.storage_used_gb,
         c.billing_status,
         c.is_active,
         c.created_at,
         (
           SELECT COUNT(*)::int
           FROM users u
           WHERE u.company_id = c.id
         ) AS users_count
         ,
         (
           SELECT COUNT(*)::int
           FROM users u
           WHERE u.company_id = c.id
             AND u.is_active = true
         ) AS active_users
       FROM companies c
       ORDER BY c.created_at DESC`
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch companies"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const allowed = await canManageCompanies(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can manage companies", 403)

    const payload = createCompanySchema.parse(await request.json())
    const passwordHash = await bcrypt.hash(payload.admin_password, 10)

    await db.query("BEGIN")

    const companyResult = await db.query(
      `INSERT INTO companies (
        company_code, company_name, domain, storage_bucket,
        subscription_plan, storage_used_gb, billing_status, is_active
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING
         id, company_code, company_name, domain, storage_bucket,
         subscription_plan, storage_used_gb, billing_status, is_active, created_at`,
      [
        payload.company_code.toUpperCase(),
        payload.company_name,
        payload.domain || null,
        payload.storage_bucket || null,
        payload.subscription_plan || "BASIC",
        payload.storage_used_gb ?? 0,
        payload.billing_status || "TRIAL",
      ]
    )

    const company = companyResult.rows[0]

    const userResult = await db.query(
      `INSERT INTO users (company_id, username, email, full_name, role, password_hash, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'ADMIN', $5, true, $6)
       RETURNING id, username, email, full_name, role, is_active, created_at`,
      [
        company.id,
        payload.admin_username,
        payload.admin_email,
        payload.admin_full_name,
        passwordHash,
        session.userId,
      ]
    )

    const adminRole = await db.query(
      "SELECT id FROM rbac_roles WHERE role_code = 'ADMIN' AND is_active = true LIMIT 1"
    )
    if (adminRole.rows.length) {
      await db.query(
        `INSERT INTO rbac_user_roles (user_id, role_id, is_primary, assigned_by)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (user_id, role_id) DO UPDATE SET is_primary = true, assigned_by = EXCLUDED.assigned_by, assigned_at = CURRENT_TIMESTAMP`,
        [userResult.rows[0].id, adminRole.rows[0].id, session.userId]
      )
    }

    await db.query("COMMIT")
    return ok(
      {
        company,
        admin_user: userResult.rows[0],
      },
      "Company created successfully"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to create company"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const allowed = await canManageCompanies(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can manage companies", 403)

    const payload = updateCompanySchema.parse(await request.json())

    const result = await query(
      `UPDATE companies
       SET company_code = $1,
           company_name = $2,
           domain = $3,
           storage_bucket = $4,
           subscription_plan = $5,
           storage_used_gb = $6,
           billing_status = $7,
           is_active = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING
         id, company_code, company_name, domain, storage_bucket,
         subscription_plan, storage_used_gb, billing_status, is_active, created_at, updated_at`,
      [
        payload.company_code.toUpperCase(),
        payload.company_name,
        payload.domain || null,
        payload.storage_bucket || null,
        payload.subscription_plan || "BASIC",
        payload.storage_used_gb ?? 0,
        payload.billing_status || "TRIAL",
        payload.is_active ?? true,
        payload.id
      ]
    )

    return ok(result.rows[0], "Company updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update company"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const allowed = await canManageCompanies(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can manage companies", 403)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Company id is required", 400)

    await query("UPDATE companies SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id])
    return ok({ id }, "Company deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to deactivate company"
    return fail("DELETE_FAILED", message, 400)
  }
}
