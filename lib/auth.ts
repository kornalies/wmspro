import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { headers } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

import { isAuthSessionActive, touchAuthSession } from "@/lib/auth-session-store"

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  throw new Error("Missing JWT_SECRET environment variable")
}
const secret = new TextEncoder().encode(jwtSecret)

export interface TokenPayload {
  sessionId?: string
  userId: number
  username: string
  role: string
  roles?: string[]
  permissions?: string[]
  companyId: number
  companyCode?: string
  warehouseId?: number
  actorType?: "web" | "mobile" | "portal" | "system"
}

type TokenPurpose = "access" | "refresh"

function extractBearerToken(authHeader?: string | null): string | null {
  if (!authHeader) return null
  const [scheme, value] = authHeader.split(" ")
  if (!scheme || !value) return null
  if (scheme.toLowerCase() !== "bearer") return null
  return value.trim() || null
}

export async function signToken(
  payload: TokenPayload,
  options?: { expiresIn?: string; purpose?: TokenPurpose }
): Promise<string> {
  const expiresIn = options?.expiresIn ?? "24h"
  const purpose = options?.purpose ?? "access"
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti(crypto.randomUUID())
    .setSubject(String(payload.userId))
    .setIssuer("wms-frontend")
    .setAudience(`wms-${purpose}`)
    .sign(secret)
}

type VerifyTokenOptions = {
  purpose?: TokenPurpose
  validateSession?: boolean
}

async function verifyTokenSignature(
  token: string,
  options?: { purpose?: TokenPurpose }
): Promise<TokenPayload | null> {
  try {
    const verified = await jwtVerify(token, secret, {
      issuer: "wms-frontend",
      audience: options?.purpose ? `wms-${options.purpose}` : undefined,
    })
    return verified.payload as unknown as TokenPayload
  } catch {
    return null
  }
}

export async function verifyToken(token: string, options?: VerifyTokenOptions): Promise<TokenPayload | null> {
  const payload = await verifyTokenSignature(token, { purpose: options?.purpose })
  if (!payload) return null

  if (options?.validateSession === false) {
    return payload
  }

  if (!payload.sessionId) {
    return null
  }

  try {
    const active = await isAuthSessionActive(payload.sessionId)
    if (!active) return null
    await touchAuthSession(payload.sessionId)
    return payload
  } catch {
    return null
  }
}

export async function verifyTokenWithoutSession(token: string): Promise<TokenPayload | null> {
  return verifyToken(token, { validateSession: false })
}

export async function getSession(): Promise<TokenPayload | null> {
  const headerStore = await headers()
  const bearerToken = extractBearerToken(headerStore.get("authorization"))
  if (bearerToken) {
    return verifyToken(bearerToken, { purpose: "access" })
  }

  const cookieStore = await cookies()
  const token = cookieStore.get("token")?.value
  if (!token) return null
  return verifyToken(token, { purpose: "access" })
}

export async function setAuthCookie(token: string) {
  const cookieStore = await cookies()
  cookieStore.set("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24,
    path: "/",
  })
}

export async function clearAuthCookie() {
  const cookieStore = await cookies()
  cookieStore.delete("token")
}

export async function requireAuth(request: NextRequest) {
  const bearerToken = extractBearerToken(request.headers.get("authorization"))
  const token = bearerToken || request.cookies.get("token")?.value

  if (!token) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const payload = await verifyToken(token, { purpose: "access" })
  if (!payload) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 })
  }

  return payload
}

export function requireRole(payload: TokenPayload, allowedRoles: string[]) {
  const userRoles = payload.roles?.length ? payload.roles : [payload.role]
  if (!userRoles.some((r) => allowedRoles.includes(r))) {
    throw new Error("Insufficient permissions")
  }
}

export function requirePermission(payload: TokenPayload, permission: string) {
  if (payload.role === "SUPER_ADMIN") return
  if (payload.permissions?.includes(permission)) return
  throw new Error("Insufficient permissions")
}
