export type AccessUser = {
  role?: string | null
  permissions?: string[] | null
  products?: string[] | null
}

export type ProductCode = "WMS" | "FF"

type RoutePermissionRule = {
  href: string
  permissions: string[]
}

const ROUTE_PERMISSION_RULES: RoutePermissionRule[] = [
  {
    href: "/dashboard",
    permissions: [
      "reports.view",
      "grn.manage",
      "do.manage",
      "gate.in.create",
      "gate.out.create",
      "stock.putaway.manage",
      "finance.view",
      "master.data.manage",
      "admin.users.manage",
      "admin.companies.manage",
      "labor.view",
      "labor.manage",
      "integration.view",
      "integration.manage",
      "wes.view",
      "wes.manage",
    ],
  },
  { href: "/grn/mobile-approvals", permissions: ["grn.mobile.approve"] },
  { href: "/grn", permissions: ["grn.manage"] },
  { href: "/do", permissions: ["do.manage"] },
  { href: "/stock/transfer", permissions: ["stock.putaway.manage"] },
  { href: "/gate/in", permissions: ["gate.in.create"] },
  { href: "/gate/out", permissions: ["gate.out.create"] },
  { href: "/admin/onboarding", permissions: ["master.data.manage", "admin.users.manage", "admin.companies.manage"] },
  { href: "/admin/clients", permissions: ["master.data.manage"] },
  { href: "/admin/users", permissions: ["admin.users.manage"] },
  { href: "/admin/items", permissions: ["master.data.manage"] },
  { href: "/admin/warehouses", permissions: ["master.data.manage"] },
  { href: "/admin/zone-layouts", permissions: ["master.data.manage"] },
  { href: "/admin/tenant-settings", permissions: ["settings.read", "settings.update"] },
  { href: "/admin/scopes", permissions: ["scopes.read", "scopes.update"] },
  { href: "/admin/audit", permissions: ["audit.view"] },
  { href: "/admin/security", permissions: ["audit.view"] },
  { href: "/admin/companies", permissions: ["admin.companies.manage"] },
  { href: "/finance/invoices", permissions: ["finance.view"] },
  { href: "/finance/billing", permissions: ["finance.view"] },
  { href: "/finance/contracts", permissions: ["finance.view"] },
  { href: "/finance/rates", permissions: ["finance.view"] },
  { href: "/reports", permissions: ["reports.view"] },
  { href: "/labor", permissions: ["labor.view", "labor.manage", "do.manage", "reports.view"] },
  { href: "/integrations", permissions: ["integration.view", "integration.manage"] },
  { href: "/wes", permissions: ["wes.view", "wes.manage"] },
  { href: "/freight", permissions: ["freight.view", "freight.manage"] },
]

const SORTED_RULES = ROUTE_PERMISSION_RULES.slice().sort((a, b) => b.href.length - a.href.length)
const WMS_PREFIXES = [
  "/dashboard",
  "/grn",
  "/do",
  "/stock",
  "/gate",
  "/admin",
  "/finance",
  "/reports",
  "/labor",
  "/integrations",
  "/wes",
  "/portal",
]
const FF_PREFIXES = ["/freight"]

export function getRequiredPermissionsForPath(pathname: string): string[] {
  const normalizedPath = String(pathname || "").trim()
  if (!normalizedPath) return []

  for (const rule of SORTED_RULES) {
    if (normalizedPath === rule.href || normalizedPath.startsWith(`${rule.href}/`)) {
      return rule.permissions
    }
  }

  return []
}

export function canAccessPermissions(user: AccessUser | null | undefined, permissions: string[]): boolean {
  if (!permissions.length) return true
  if (!user) return false
  if (String(user.role || "").toUpperCase() === "SUPER_ADMIN") return true

  const userPermissions = Array.isArray(user.permissions) ? user.permissions : []
  if (!userPermissions.length) return false
  return permissions.some((perm) => userPermissions.includes(perm))
}

export function getRequiredProductsForPath(pathname: string): ProductCode[] {
  const normalizedPath = String(pathname || "").trim()
  if (!normalizedPath) return []

  if (FF_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return ["FF"]
  }

  if (WMS_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return ["WMS"]
  }

  return []
}

export function canAccessProducts(
  user: AccessUser | null | undefined,
  products: ProductCode[]
): boolean {
  if (!products.length) return true
  if (!user) return false

  const assigned = Array.isArray(user.products)
    ? user.products.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
    : []

  if (!assigned.length) {
    return products.includes("WMS")
  }

  return products.some((product) => assigned.includes(product))
}

export function canAccessPath(user: AccessUser | null | undefined, pathname: string): boolean {
  const permissions = getRequiredPermissionsForPath(pathname)
  const products = getRequiredProductsForPath(pathname)
  return canAccessPermissions(user, permissions) && canAccessProducts(user, products)
}
