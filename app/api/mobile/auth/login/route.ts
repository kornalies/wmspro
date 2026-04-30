import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { createAuthSession } from "@/lib/auth-session-store"
import { signToken } from "@/lib/auth"
import { authenticateUser } from "@/lib/auth-service"
import { query } from "@/lib/db"
import { getEnabledProductsForCompany } from "@/lib/product-access"

const mobileLoginSchema = z.object({
  company_code: z.string().trim().min(2, "Company code is required"),
  username: z.string().trim().min(3, "Username is required"),
  password: z.string().min(6, "Password is required"),
  device_id: z.string().optional(),
  device_name: z.string().optional(),
})

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
    const payload = mobileLoginSchema.parse(await request.json())
    let user
    try {
      user = await authenticateUser({
        companyCode: payload.company_code,
        username: payload.username,
        password: payload.password,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Login failed"
      if (message === "INVALID_CREDENTIALS") {
        return fail("INVALID_CREDENTIALS", "Invalid credentials", 401)
      }
      return fail("LOGIN_FAILED", message, 500)
    }

    const assignedWarehouseResult =
      user.warehouse_id && user.warehouse_id > 0
        ? await query(
            `SELECT id, warehouse_code, warehouse_name
             FROM warehouses
             WHERE id = $1
               AND company_id = $2
             LIMIT 1`,
            [user.warehouse_id, user.company_id]
          )
        : { rows: [] as Array<{ id: number; warehouse_code: string; warehouse_name: string }> }
    const assignedWarehouse = assignedWarehouseResult.rows[0]

    const scopeResult = await query(
      `SELECT scope_id
       FROM user_scopes
       WHERE company_id = $1
         AND user_id = $2
         AND scope_type = 'warehouse'`,
      [user.company_id, user.id]
    )
    const scopedWarehouseIds = scopeResult.rows
      .map((row: { scope_id: number }) => Number(row.scope_id))
      .filter((id: number) => Number.isFinite(id) && id > 0)

    let allowedWarehouses: Array<{ id: number; warehouse_code: string; warehouse_name: string }> = []
    if (scopedWarehouseIds.length > 0) {
      const scopedWarehousesResult = await query(
        `SELECT id, warehouse_code, warehouse_name
         FROM warehouses
         WHERE company_id = $1
           AND is_active = true
           AND id = ANY($2::int[])
         ORDER BY warehouse_name ASC`,
        [user.company_id, scopedWarehouseIds]
      )
      allowedWarehouses = scopedWarehousesResult.rows
    } else if (assignedWarehouse) {
      allowedWarehouses = [assignedWarehouse]
    } else if (user.role === "SUPER_ADMIN" || user.role === "ADMIN") {
      const allWarehousesResult = await query(
        `SELECT id, warehouse_code, warehouse_name
         FROM warehouses
         WHERE company_id = $1
           AND is_active = true
         ORDER BY warehouse_name ASC`,
        [user.company_id]
      )
      allowedWarehouses = allWarehousesResult.rows
    }

    const dedupedAllowedWarehouses = Array.from(
      new Map(
        [...(assignedWarehouse ? [assignedWarehouse] : []), ...allowedWarehouses].map((warehouse) => [
          Number(warehouse.id),
          {
            id: Number(warehouse.id),
            warehouse_code: String(warehouse.warehouse_code || ""),
            warehouse_name: String(warehouse.warehouse_name || ""),
          },
        ])
      ).values()
    ).sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name))

    const sessionId = await createAuthSession({
      userId: user.id,
      companyId: user.company_id,
      actorType: "mobile",
      deviceId: payload.device_id,
      deviceName: payload.device_name,
      ipAddress: getRequestIpAddress(request),
      userAgent: request.headers.get("user-agent") || undefined,
    })
    const products = await getEnabledProductsForCompany(user.company_id)

    const accessToken = await signToken(
      {
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
        actorType: "mobile",
      },
      { expiresIn: "24h", purpose: "access" }
    )

    const refreshToken = await signToken(
      {
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
        actorType: "mobile",
      },
      { expiresIn: "30d", purpose: "refresh" }
    )

    return ok({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        roles: user.roles,
        permissions: user.permissions,
        products,
        company_id: user.company_id,
        company_code: user.company_code,
        warehouse_id: assignedWarehouse ? Number(assignedWarehouse.id) : null,
        warehouse_name: assignedWarehouse ? String(assignedWarehouse.warehouse_name || "") : null,
        warehouse: assignedWarehouse
          ? {
              id: Number(assignedWarehouse.id),
              code: String(assignedWarehouse.warehouse_code || ""),
              name: String(assignedWarehouse.warehouse_name || ""),
            }
          : null,
        allowed_warehouses: dedupedAllowedWarehouses,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Login failed"
    return fail("LOGIN_FAILED", message, 400)
  }
}
