import { fail } from "@/lib/api-response"
import { query } from "@/lib/db"

export type ProductCode = "WMS" | "FF"

const KNOWN_PRODUCTS: ProductCode[] = ["WMS", "FF"]
const CACHE_TTL_MS = 5_000

type EntitlementCacheEntry = {
  products: ProductCode[]
  expiresAt: number
}

type SessionLike = {
  companyId: number
  products?: string[]
}

const entitlementCache = new Map<number, EntitlementCacheEntry>()

function normalizeProduct(value: unknown): ProductCode | null {
  const code = String(value || "").trim().toUpperCase()
  if (code === "WMS" || code === "FF") return code
  return null
}

function dedupeProducts(values: unknown[]): ProductCode[] {
  const normalized = values
    .map((value) => normalizeProduct(value))
    .filter((value): value is ProductCode => value !== null)
  return Array.from(new Set(normalized))
}

export function normalizeProducts(values: unknown[] | null | undefined): ProductCode[] {
  if (!Array.isArray(values)) return []
  return dedupeProducts(values)
}

export async function getEnabledProductsForCompany(companyId: number): Promise<ProductCode[]> {
  const now = Date.now()
  const cached = entitlementCache.get(companyId)
  if (cached && cached.expiresAt > now) {
    return cached.products
  }

  const result = await query(
    `SELECT product_code
     FROM tenant_products
     WHERE company_id = $1
       AND status IN ('ACTIVE', 'TRIAL')
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at >= NOW())
     ORDER BY product_code ASC`,
    [companyId]
  )

  let products = dedupeProducts(result.rows.map((row: { product_code: string }) => row.product_code))

  if (!products.length) {
    const configuredResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM tenant_products
       WHERE company_id = $1`,
      [companyId]
    )
    const configuredCount = Number(configuredResult.rows[0]?.count || 0)
    // Backward compatibility: if entitlements are not yet configured, keep WMS accessible.
    if (configuredCount === 0) {
      products = ["WMS"]
    }
  }

  entitlementCache.set(companyId, {
    products,
    expiresAt: now + CACHE_TTL_MS,
  })
  return products
}

export async function resolveSessionProducts(session: SessionLike): Promise<ProductCode[]> {
  const fromToken = normalizeProducts(session.products)
  if (fromToken.length) return fromToken
  return getEnabledProductsForCompany(session.companyId)
}

export function hasProductAccess(products: string[] | null | undefined, product: ProductCode): boolean {
  const normalized = normalizeProducts(products)
  if (!normalized.length) {
    return product === "WMS"
  }
  return normalized.includes(product)
}

export class ProductAccessError extends Error {
  code: string
  status: number
  product: ProductCode

  constructor(product: ProductCode, message?: string) {
    super(message || `${product} is not enabled for this tenant`)
    this.name = "ProductAccessError"
    this.code = "PRODUCT_DISABLED"
    this.status = 403
    this.product = product
  }
}

export async function requireProduct(session: SessionLike, product: ProductCode) {
  const products = await resolveSessionProducts(session)
  if (products.includes(product)) return
  throw new ProductAccessError(product)
}

export async function assertProductEnabled(companyId: number, product: ProductCode) {
  const products = await getEnabledProductsForCompany(companyId)
  if (products.includes(product)) return
  throw new ProductAccessError(product)
}

export function guardProductError(error: unknown) {
  if (error instanceof ProductAccessError) {
    return fail(error.code, error.message, error.status, { product: error.product })
  }
  return null
}

export function listKnownProducts(): ProductCode[] {
  return [...KNOWN_PRODUCTS]
}

export function clearProductCache(companyId?: number) {
  if (typeof companyId === "number") {
    entitlementCache.delete(companyId)
    return
  }
  entitlementCache.clear()
}
