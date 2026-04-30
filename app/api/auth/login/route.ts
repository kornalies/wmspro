import { NextRequest } from "next/server"

import { createAuthSession } from "@/lib/auth-session-store"
import { signToken } from "@/lib/auth"
import { authenticateUser } from "@/lib/auth-service"
import { getEnabledProductsForCompany } from "@/lib/product-access"
import { loginSchema } from "@/lib/validations"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

function getRequestIpAddress(request: NextRequest): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim()
    if (firstIp) return firstIp
  }
  const realIp = request.headers.get("x-real-ip")?.trim()
  return realIp || undefined
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const validatedData = loginSchema.parse(body)
    const requestedProduct = validatedData.requested_product

    let user
    try {
      user = await authenticateUser({
        username: validatedData.username,
        companyCode: validatedData.company_code,
        password: validatedData.password,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Login failed"
      const companyLookup = await query(
        "SELECT id FROM companies WHERE UPPER(company_code) = UPPER($1) LIMIT 1",
        [validatedData.company_code]
      )
      if (companyLookup.rows.length) {
        await writeAudit({
          companyId: Number(companyLookup.rows[0].id),
          actorType: "web",
          action: "auth.login.failed",
          entityType: "auth_session",
          entityId: validatedData.username,
          after: {
            username: validatedData.username,
            company_code: validatedData.company_code,
            requested_product: requestedProduct || null,
            reason: message === "INVALID_CREDENTIALS" ? "INVALID_CREDENTIALS" : "LOGIN_FAILED",
          },
          req: request,
        })
      }
      if (message === "INVALID_CREDENTIALS") {
        return fail("INVALID_CREDENTIALS", "Unable to sign in with those credentials", 401)
      }
      return fail("LOGIN_FAILED", "Unable to sign in right now", 500)
    }

    const sessionId = await createAuthSession({
      userId: user.id,
      companyId: user.company_id,
      actorType: "web",
      ipAddress: getRequestIpAddress(request),
      userAgent: request.headers.get("user-agent") || undefined,
    })
    const products = await getEnabledProductsForCompany(user.company_id)
    if (requestedProduct && !products.includes(requestedProduct)) {
      await writeAudit({
        companyId: user.company_id,
        actorUserId: user.id,
        actorType: "web",
        action: "auth.login.product_denied",
        entityType: "auth_session",
        entityId: sessionId,
        after: {
          username: user.username,
          requested_product: requestedProduct,
          available_products: products,
        },
        req: request,
      })
      return fail(
        "PRODUCT_DISABLED",
        `${requestedProduct} is not enabled for this company`,
        403,
        { requested_product: requestedProduct, available_products: products }
      )
    }

    const token = await signToken({
      sessionId,
      userId: user.id,
      username: user.username,
      role: user.role,
      roles: user.roles,
      permissions: user.permissions,
      products,
      companyId: user.company_id,
      companyCode: user.company_code,
      warehouseId: user.warehouse_id ?? undefined,
      actorType: "web",
    })

    const response = ok(
      {
        token,
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        roles: user.roles,
        permissions: user.permissions,
        products,
        requested_product: requestedProduct || null,
        company_id: user.company_id,
        company_code: user.company_code,
        warehouse_id: user.warehouse_id,
      },
      "Login successful"
    )

    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    })

    await writeAudit({
      companyId: user.company_id,
      actorUserId: user.id,
      actorType: "web",
      action: "auth.login.success",
      entityType: "auth_session",
      entityId: sessionId,
      after: {
        username: user.username,
        role: user.role,
        requested_product: requestedProduct || null,
        products,
      },
      req: request,
    })

    return response
  } catch (error: unknown) {
    console.error("Login error:", error)
    return fail("LOGIN_FAILED", "Unable to sign in right now", 400)
  }
}
