import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"

const createCompanySchema = z.object({
  company_code: z.string().trim().min(2).max(50),
  company_name: z.string().trim().min(2).max(150),
  domain: z.string().trim().max(150).optional().or(z.literal("")),
  storage_bucket: z.string().trim().max(120).optional().or(z.literal("")),
  subscription_plan: z.enum(["BASIC", "PRO", "ENTERPRISE"]).optional(),
  storage_used_gb: z.number().min(0).optional(),
  billing_status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED"]).optional(),
  is_active: z.boolean().optional(),
  product_codes: z.array(z.enum(["WMS", "FF"])).min(1).optional(),
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
  product_codes: z.array(z.enum(["WMS", "FF"])).min(1).optional(),
})

const KNOWN_PRODUCT_CODES = ["WMS", "FF"] as const

async function syncTenantProducts(
  db: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  companyId: number,
  selectedProducts?: Array<"WMS" | "FF">
) {
  const normalized = new Set((selectedProducts?.length ? selectedProducts : ["WMS"]).map((code) => code.toUpperCase()))

  for (const code of KNOWN_PRODUCT_CODES) {
    const isEnabled = normalized.has(code)
    await db.query(
      `INSERT INTO tenant_products (company_id, product_code, plan_code, status)
       VALUES ($1, $2, 'STANDARD', $3)
       ON CONFLICT (company_id, product_code)
       DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [companyId, code, isEnabled ? "ACTIVE" : "INACTIVE"]
    )
  }
}

async function canManageCompanies(session: { role: string; permissions?: string[]; companyCode?: string }) {
  if (session.role === "SUPER_ADMIN") return true
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
         c.updated_at,
         owner.full_name AS owner_name,
         owner.email AS owner_email,
         (
           SELECT MAX(us.last_seen_at)
           FROM user_sessions us
           WHERE us.company_id = c.id
             AND us.revoked_at IS NULL
         ) AS last_activity_at,
         (
           SELECT MAX(al.created_at)
           FROM audit_logs al
           WHERE al.company_id = c.id
         ) AS last_audit_at,
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
         ,
         COALESCE(
           (
             SELECT json_agg(tp.product_code ORDER BY tp.product_code)
             FROM tenant_products tp
             WHERE tp.company_id = c.id
               AND tp.status IN ('ACTIVE', 'TRIAL')
               AND (tp.starts_at IS NULL OR tp.starts_at <= NOW())
             AND (tp.ends_at IS NULL OR tp.ends_at >= NOW())
           ),
           '[]'::json
         ) AS product_codes
       FROM companies c
       LEFT JOIN LATERAL (
         SELECT u.full_name, u.email
         FROM users u
         WHERE u.company_id = c.id
           AND u.role IN ('SUPER_ADMIN', 'ADMIN')
           AND u.is_active = true
         ORDER BY
           CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END,
           u.created_at ASC
         LIMIT 1
       ) owner ON true
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
        payload.is_active ?? true,
      ]
    )

    const company = companyResult.rows[0]
    await setTenantContext(db, Number(company.id))
    await syncTenantProducts(db, Number(company.id), payload.product_codes)

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

    await writeAudit(
      {
        companyId: Number(company.id),
        actorUserId: session.userId,
        actorType: "web",
        action: "company.created",
        entityType: "company",
        entityId: company.id,
        after: {
          company_code: company.company_code,
          company_name: company.company_name,
          subscription_plan: company.subscription_plan,
          billing_status: company.billing_status,
          is_active: company.is_active,
          product_codes: payload.product_codes ?? ["WMS"],
        },
        req: request,
      },
      db
    )

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
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const allowed = await canManageCompanies(session)
    if (!allowed) return fail("FORBIDDEN", "Only SUPER_ADMIN can manage companies", 403)

    const payload = updateCompanySchema.parse(await request.json())

    await db.query("BEGIN")
    const beforeResult = await db.query(
      `SELECT
         id, company_code, company_name, domain, storage_bucket,
         subscription_plan, storage_used_gb, billing_status, is_active, created_at, updated_at
       FROM companies
       WHERE id = $1
       FOR UPDATE`,
      [payload.id]
    )

    if (!beforeResult.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Company not found", 404)
    }

    const result = await db.query(
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

    if (!result.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Company not found", 404)
    }

    await setTenantContext(db, Number(result.rows[0].id))
    await syncTenantProducts(db, Number(result.rows[0].id), payload.product_codes)
    await writeAudit(
      {
        companyId: Number(result.rows[0].id),
        actorUserId: session.userId,
        actorType: "web",
        action: "company.updated",
        entityType: "company",
        entityId: result.rows[0].id,
        before: beforeResult.rows[0],
        after: {
          ...result.rows[0],
          product_codes: payload.product_codes,
        },
        req: request,
      },
      db
    )
    await db.query("COMMIT")
    return ok(result.rows[0], "Company updated successfully")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to update company"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
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

    const beforeResult = await query(
      "SELECT id, company_code, company_name, is_active FROM companies WHERE id = $1",
      [id]
    )
    if (!beforeResult.rows.length) return fail("NOT_FOUND", "Company not found", 404)

    await query("UPDATE companies SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id])
    await writeAudit({
      companyId: id,
      actorUserId: session.userId,
      actorType: "web",
      action: "company.deactivated",
      entityType: "company",
      entityId: id,
      before: beforeResult.rows[0],
      after: { ...beforeResult.rows[0], is_active: false },
      req: request,
    })
    return ok({ id }, "Company deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to deactivate company"
    return fail("DELETE_FAILED", message, 400)
  }
}
