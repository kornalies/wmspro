import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, signToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

const switchSchema = z.object({
  company_id: z.number().positive(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!session.permissions?.includes("admin.companies.manage") && session.role !== "SUPER_ADMIN") {
      return fail("FORBIDDEN", "Only SUPER_ADMIN can switch company", 403)
    }

    const payload = switchSchema.parse(await request.json())

    const companyResult = await query(
      "SELECT id, company_code FROM companies WHERE id = $1 AND is_active = true",
      [payload.company_id]
    )
    if (!companyResult.rows.length) {
      return fail("NOT_FOUND", "Company not found or inactive", 404)
    }

    const targetCompany = companyResult.rows[0]
    const token = await signToken({
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      role: session.role,
      roles: session.roles,
      permissions: session.permissions,
      warehouseId: session.warehouseId,
      companyId: Number(targetCompany.id),
      companyCode: targetCompany.company_code,
      actorType: session.actorType || "web",
    })

    const response = ok(
      {
        company_id: Number(targetCompany.id),
        company_code: targetCompany.company_code,
      },
      "Company switched"
    )

    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    })

    return response
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to switch company"
    return fail("SWITCH_FAILED", message, 400)
  }
}
