import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { signToken, verifyToken } from "@/lib/auth"

const refreshSchema = z.object({
  refresh_token: z.string().min(10),
  device_id: z.string().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const payload = refreshSchema.parse(await request.json())
    const session = await verifyToken(payload.refresh_token, { purpose: "refresh" })
    if (!session) {
      return fail("UNAUTHORIZED", "Invalid refresh token", 401)
    }

    const accessToken = await signToken(
      {
        sessionId: session.sessionId,
        userId: session.userId,
        username: session.username,
        role: session.role,
        roles: session.roles || [session.role],
        permissions: session.permissions || [],
        companyId: session.companyId,
        companyCode: session.companyCode,
        warehouseId: session.warehouseId,
        actorType: session.actorType || "mobile",
      },
      { expiresIn: "24h", purpose: "access" }
    )
    const refreshToken = await signToken(
      {
        sessionId: session.sessionId,
        userId: session.userId,
        username: session.username,
        role: session.role,
        roles: session.roles || [session.role],
        permissions: session.permissions || [],
        companyId: session.companyId,
        companyCode: session.companyCode,
        warehouseId: session.warehouseId,
        actorType: session.actorType || "mobile",
      },
      { expiresIn: "30d", purpose: "refresh" }
    )

    return ok({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Refresh failed"
    return fail("REFRESH_FAILED", message, 400)
  }
}
