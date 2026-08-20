/**
 * Who the portal is looking at, and what they may see.
 *
 * Pure functions, deliberately separate from the React context that calls them
 * (components/portal/portal-scope.tsx). Two reasons:
 *
 * 1. This is the security-adjacent half. The four access gates are enforced by the
 *    API routes and by RLS, and what happens here only decides what the UI offers --
 *    but a UI that offers a control the server will refuse is its own bug, and one
 *    that a client discovers by filling in a form and getting a 403.
 *
 * 2. Client resolution is where the real defect lived. Every screen used to end its
 *    load with `loadedClients[0]?.id ?? null`, so a user mapped to more than one
 *    client would choose C0002 on one screen and silently read C0001 on the next.
 *
 * Both are testable only if they are not trapped inside a hook. See tests/portal-access.mjs.
 */

export type PortalClientRef = {
  id: number
  client_code: string
  client_name: string
}

export type PortalSection =
  | "overview"
  | "inventory"
  | "orders"
  | "shipments"
  | "billing"
  | "disputes"
  | "performance"
  | "reports"

export type PortalAccess = {
  portalEnabled: boolean
  can: Record<PortalSection, boolean>
  canCreateAsn: boolean
  canCreateDispute: boolean
  canManageSla: boolean
  canActOnInvoice: boolean
}

/**
 * Pick the client in scope.
 *
 * Order: the URL, then what the browser remembered, then the first mapping. The URL
 * wins because an explicit link -- a bookmark, something pasted into an email -- must
 * never be overridden by what this browser happens to remember.
 *
 * A code that is not among the user's mappings falls through to the next candidate
 * rather than resolving to nothing: a stale bookmark should show the user their own
 * data, not an empty screen. It is not an access decision -- the routes and RLS
 * refuse an unmapped client regardless of what this returns.
 */
export function resolvePortalClient(
  clients: readonly PortalClientRef[],
  requestedCode: string | null | undefined,
  rememberedCode: string | null | undefined
): PortalClientRef | null {
  if (!clients.length) return null
  const byCode = (code: string | null | undefined) =>
    code ? clients.find((c) => c.client_code.toLowerCase() === code.toLowerCase()) : undefined
  return byCode(requestedCode) || byCode(rememberedCode) || clients[0]
}

/**
 * Combine the gates into what the nav should offer.
 *
 * `grants` is the /api/portal/features payload; `null` means the question was not
 * answered (the request failed, or the caller is an admin who bypasses that gate),
 * in which case the feature gate is not applied. `features` is the tenant product
 * switch, where only an explicit `false` disables -- an absent flag means enabled.
 */
export function resolvePortalAccess({
  features = {},
  permissions = [],
  grants = null,
}: {
  features?: Record<string, boolean>
  permissions?: readonly string[]
  grants?: Record<string, boolean> | null
}): PortalAccess {
  const portalEnabled = features.portal !== false
  const hasGrant = (key: string) => (grants ? grants[key] === true : true)
  const hasRbac = (key: string) => permissions.includes(key)

  // Billing needs the product flag AND an RBAC read permission before any portal
  // grant is even consulted. Disputes hang off the same pair: a client who cannot
  // see an invoice cannot meaningfully query one.
  const billingVisible =
    features.billing !== false && (hasRbac("billing.view") || hasRbac("finance.view"))

  const can: Record<PortalSection, boolean> = {
    overview: portalEnabled,
    inventory: portalEnabled && features.stock !== false && hasGrant("portal.inventory.view"),
    orders: portalEnabled && features.do !== false && hasGrant("portal.orders.view"),
    shipments:
      portalEnabled && (features.grn !== false || features.do !== false) && hasGrant("portal.asn.view"),
    billing: portalEnabled && billingVisible && hasGrant("portal.billing.view"),
    disputes: portalEnabled && billingVisible && hasGrant("portal.dispute.view"),
    performance: portalEnabled && hasGrant("portal.sla.view"),
    reports: portalEnabled && hasGrant("portal.reports.view"),
  }

  return {
    portalEnabled,
    can,
    // Each write mirrors one route exactly. ASN creation is gated on the grant
    // alone; the other three also demand an RBAC permission, and invoice actions
    // accept either of two. Guessing here produces a button the server refuses.
    canCreateAsn: can.shipments && hasGrant("portal.asn.create"),
    canCreateDispute:
      can.disputes &&
      hasGrant("portal.dispute.create") &&
      (hasRbac("portal.dispute.create") || hasRbac("portal.dispute.manage")),
    canManageSla: can.performance && hasGrant("portal.sla.manage") && hasRbac("portal.sla.manage"),
    canActOnInvoice:
      can.billing && (hasRbac("portal.billing.action") || hasRbac("portal.dispute.create")),
  }
}
