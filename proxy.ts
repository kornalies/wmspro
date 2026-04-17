import { NextResponse, type NextRequest } from "next/server"
import { jwtVerify } from "jose"

type TokenPayload = {
  role?: string
  permissions?: string[]
}

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  throw new Error("Missing JWT_SECRET environment variable")
}
const secret = new TextEncoder().encode(jwtSecret)

function getRequestId(request: NextRequest): string {
  const direct = request.headers.get("x-request-id")
  if (direct && direct.trim().length > 0) return direct.trim()

  const correlated = request.headers.get("x-correlation-id")
  if (correlated && correlated.trim().length > 0) return correlated.trim()

  return crypto.randomUUID()
}

function applyEnterpriseHeaders(response: NextResponse, requestId: string, request: NextRequest) {
  response.headers.set("x-request-id", requestId)
  response.headers.set("x-content-type-options", "nosniff")
  response.headers.set("x-frame-options", "DENY")
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin")
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  )
  if (request.nextUrl.protocol === "https:") {
    response.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains")
  }
  return response
}

function applyApiCorsHeaders(response: NextResponse) {
  response.headers.set("access-control-allow-origin", "*")
  response.headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
  response.headers.set("access-control-allow-headers", "Authorization, Content-Type, X-Requested-With")
  response.headers.set("access-control-max-age", "86400")
  return response
}

function nextWithHeaders(requestId: string, request: NextRequest) {
  const response = NextResponse.next()
  return applyEnterpriseHeaders(response, requestId, request)
}

function redirectWithHeaders(path: string, request: NextRequest, requestId: string) {
  const response = NextResponse.redirect(new URL(path, request.url))
  return applyEnterpriseHeaders(response, requestId, request)
}

async function getTokenPayload(request: NextRequest): Promise<TokenPayload | null> {
  const token = request.cookies.get("token")?.value
  if (!token) return null

  try {
    const verified = await jwtVerify(token, secret)
    return verified.payload as TokenPayload
  } catch {
    return null
  }
}

export default async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  const requestId = getRequestId(request)

  if (path.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      const preflight = new NextResponse(null, { status: 204 })
      return applyApiCorsHeaders(applyEnterpriseHeaders(preflight, requestId, request))
    }
    const response = nextWithHeaders(requestId, request)
    return applyApiCorsHeaders(response)
  }

  const payload = await getTokenPayload(request)

  if (!payload) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("next", path)
    const response = NextResponse.redirect(loginUrl)
    return applyEnterpriseHeaders(response, requestId, request)
  }

  const role = String(payload.role || "").toUpperCase()
  const isPortalOnlyRole =
    role === "CLIENT" ||
    role === "VIEWER" ||
    role === "CUSTOMER" ||
    role === "CLIENT_USER" ||
    role === "READONLY" ||
    role === "READ_ONLY"
  const isInternalWmsPath =
    path.startsWith("/dashboard") ||
    path.startsWith("/grn") ||
    path.startsWith("/do") ||
    path.startsWith("/stock") ||
    path.startsWith("/gate") ||
    path.startsWith("/admin") ||
    path.startsWith("/finance") ||
    path.startsWith("/reports") ||
    path.startsWith("/labor") ||
    path.startsWith("/integrations") ||
    path.startsWith("/wes")
  if (isPortalOnlyRole && isInternalWmsPath) {
    return redirectWithHeaders("/portal", request, requestId)
  }

  if (path.startsWith("/admin")) {
    const canAdminByPerm =
      payload.permissions?.includes("master.data.manage") ||
      payload.permissions?.includes("admin.companies.manage") ||
      payload.permissions?.includes("admin.users.manage") ||
      payload.permissions?.includes("settings.read") ||
      payload.permissions?.includes("settings.update") ||
      payload.permissions?.includes("scopes.read") ||
      payload.permissions?.includes("scopes.update") ||
      payload.permissions?.includes("audit.view")
    const canAdminByRole = ["SUPER_ADMIN", "ADMIN"].includes(payload.role || "")
    if (!canAdminByPerm && !canAdminByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  if (path.startsWith("/finance")) {
    const canFinanceByPerm = payload.permissions?.includes("finance.view")
    const canFinanceByRole = ["SUPER_ADMIN", "ADMIN", "FINANCE", "OPERATIONS", "MANAGER"].includes(payload.role || "")
    if (!canFinanceByPerm && !canFinanceByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  if (path.startsWith("/portal")) {
    const canPortalByPerm = payload.permissions?.includes("portal.client.view")
    const canPortalByRole = ["SUPER_ADMIN", "ADMIN", "CLIENT", "VIEWER"].includes(payload.role || "")
    if (!canPortalByPerm && !canPortalByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  if (path.startsWith("/labor")) {
    const canLaborByPerm =
      payload.permissions?.includes("labor.view") ||
      payload.permissions?.includes("labor.manage") ||
      payload.permissions?.includes("do.manage") ||
      payload.permissions?.includes("reports.view")
    const canLaborByRole = [
      "SUPER_ADMIN",
      "ADMIN",
      "WAREHOUSE_MANAGER",
      "SUPERVISOR",
      "OPERATIONS",
      "OPERATOR",
      "FINANCE",
      "MANAGER",
    ].includes(payload.role || "")
    if (!canLaborByPerm && !canLaborByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  if (path.startsWith("/integrations")) {
    const canIntegrationByPerm =
      payload.permissions?.includes("integration.view") ||
      payload.permissions?.includes("integration.manage")
    const canIntegrationByRole = [
      "SUPER_ADMIN",
      "ADMIN",
      "OPERATIONS",
      "WAREHOUSE_MANAGER",
      "SUPERVISOR",
    ].includes(payload.role || "")
    if (!canIntegrationByPerm && !canIntegrationByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  if (path.startsWith("/wes")) {
    const canWesByPerm =
      payload.permissions?.includes("wes.view") ||
      payload.permissions?.includes("wes.manage")
    const canWesByRole = [
      "SUPER_ADMIN",
      "ADMIN",
      "OPERATIONS",
      "WAREHOUSE_MANAGER",
      "SUPERVISOR",
    ].includes(payload.role || "")
    if (!canWesByPerm && !canWesByRole) {
      return redirectWithHeaders("/dashboard", request, requestId)
    }
  }

  return nextWithHeaders(requestId, request)
}

export const config = {
  matcher: [
    "/api/:path*",
    "/dashboard/:path*",
    "/grn/:path*",
    "/do/:path*",
    "/stock/:path*",
    "/gate/:path*",
    "/admin/:path*",
    "/finance/:path*",
    "/reports/:path*",
    "/labor/:path*",
    "/integrations/:path*",
    "/wes/:path*",
    "/portal/:path*",
  ],
}
