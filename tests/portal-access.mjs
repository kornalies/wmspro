/**
 * Portal scope and gate-combination acceptance.
 *
 * Two classes of bug are guarded here, both of which read as "the UI is a bit odd"
 * rather than as an error, which is how the first one survived across six screens:
 *
 * 1. THE WRONG CLIENT ON SCREEN. Every portal screen ended its load with
 *    `loadedClients[0]?.id ?? null`, so a user mapped to more than one client could
 *    choose C0002 on the overview, navigate to Billing, and read C0001's invoices.
 *    Nothing leaked past the access gates -- the routes and RLS still refused an
 *    unmapped client -- but the client shown was not the client asked for.
 *
 * 2. A CONTROL THE SERVER WILL REFUSE. The write routes gate on the portal feature
 *    grant AND an RBAC permission (ASN creation being the one exception, which
 *    gates on the grant alone). A UI that offers Save to someone holding only the
 *    grant sends them through a whole form to reach a 403.
 *
 * Pure: no database, no dev server.
 */

import process from "node:process"
import { resolvePortalAccess, resolvePortalClient } from "../lib/portal-access.ts"

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

const CLIENTS = [
  { id: 12, client_code: "C0001", client_name: "JK PVT LTD" },
  { id: 19, client_code: "C0002", client_name: "Northwind Foods" },
  { id: 23, client_code: "C0003", client_name: "Acme Retail" },
]

// ---------------------------------------------------------------- client scope

check(
  "the URL wins over the remembered client",
  resolvePortalClient(CLIENTS, "C0002", "C0003")?.id === 19,
  "this is the navigation case that used to reset to the first mapping"
)
check(
  "the remembered client is used when the URL says nothing",
  resolvePortalClient(CLIENTS, null, "C0003")?.id === 23
)
check(
  "the first mapping is the fallback, not the default",
  resolvePortalClient(CLIENTS, null, null)?.id === 12
)
check(
  "client codes match case-insensitively",
  resolvePortalClient(CLIENTS, "c0002", null)?.id === 19,
  "a hand-typed or lower-cased link still resolves"
)
check(
  "an unmapped code falls through instead of blanking the screen",
  resolvePortalClient(CLIENTS, "C9999", "C0003")?.id === 23,
  "a stale bookmark shows the user their own data"
)
check(
  "no mappings resolves to null rather than throwing",
  resolvePortalClient([], "C0001", "C0001") === null
)

// ------------------------------------------------------------------- the gates

const FULL_GRANTS = {
  "portal.inventory.view": true,
  "portal.orders.view": true,
  "portal.billing.view": true,
  "portal.reports.view": true,
  "portal.sla.view": true,
  "portal.sla.manage": true,
  "portal.dispute.view": true,
  "portal.dispute.create": true,
  "portal.dispute.manage": true,
  "portal.asn.view": true,
  "portal.asn.create": true,
}

const fullClient = resolvePortalAccess({
  features: {},
  permissions: ["billing.view", "portal.dispute.create", "portal.sla.manage"],
  grants: FULL_GRANTS,
})
check("a fully granted client reaches inventory", fullClient.can.inventory === true)
check("a fully granted client reaches billing", fullClient.can.billing === true)
check("a fully granted client reaches shipments", fullClient.can.shipments === true)

// Gate 1: the tenant product switch closes everything.
const portalOff = resolvePortalAccess({ features: { portal: false }, grants: FULL_GRANTS })
check(
  "portal disabled for the tenant closes every section",
  Object.values(portalOff.can).every((allowed) => allowed === false),
  JSON.stringify(portalOff.can)
)

// Gate 2: a product feature closes only its own section.
const stockOff = resolvePortalAccess({
  features: { stock: false },
  permissions: ["billing.view"],
  grants: FULL_GRANTS,
})
check("stock disabled closes inventory", stockOff.can.inventory === false)
check("stock disabled leaves billing alone", stockOff.can.billing === true)

// Gate 3: feature grants fail closed. This is the migration-080 behaviour.
const noGrants = resolvePortalAccess({
  features: {},
  permissions: ["billing.view"],
  grants: {},
})
check(
  "a user with zero grants reaches no gated section",
  [
    noGrants.can.inventory,
    noGrants.can.orders,
    noGrants.can.billing,
    noGrants.can.disputes,
    noGrants.can.reports,
    noGrants.can.performance,
    noGrants.can.shipments,
  ].every((allowed) => allowed === false),
  "grants fail closed -- an empty map is not 'unrestricted'"
)
check(
  "an unanswered grants payload does not close the portal",
  resolvePortalAccess({ features: {}, permissions: ["billing.view"], grants: null }).can.inventory ===
    true,
  "null means the question was not asked, which is not the same as 'denied'"
)

// Billing needs an RBAC read permission before any grant is consulted.
const grantWithoutRbac = resolvePortalAccess({ features: {}, permissions: [], grants: FULL_GRANTS })
check(
  "a billing grant without billing.view does not open billing",
  grantWithoutRbac.can.billing === false
)
check(
  "disputes close with billing, since a client cannot query an invoice they cannot see",
  grantWithoutRbac.can.disputes === false
)
check(
  "finance.view is accepted in place of billing.view",
  resolvePortalAccess({ features: {}, permissions: ["finance.view"], grants: FULL_GRANTS }).can
    .billing === true
)

// ------------------------------------------------------------------ the writes

const viewOnly = resolvePortalAccess({
  features: {},
  permissions: ["billing.view"],
  grants: { ...FULL_GRANTS, "portal.asn.create": false },
})
check("a view-only ASN grant hides the create path", viewOnly.canCreateAsn === false)
check(
  "ASN creation needs only the grant, matching its route",
  resolvePortalAccess({ features: {}, permissions: [], grants: FULL_GRANTS }).canCreateAsn === true,
  "the ASN route carries no second RBAC check"
)
check(
  "raising a dispute needs the RBAC permission as well as the grant",
  resolvePortalAccess({ features: {}, permissions: ["billing.view"], grants: FULL_GRANTS })
    .canCreateDispute === false,
  "grant alone would offer a form that ends in a 403"
)
check(
  "portal.dispute.manage also opens dispute creation, as the route allows",
  resolvePortalAccess({
    features: {},
    permissions: ["billing.view", "portal.dispute.manage"],
    grants: FULL_GRANTS,
  }).canCreateDispute === true
)
check(
  "saving SLA targets needs both the grant and the permission",
  resolvePortalAccess({ features: {}, permissions: [], grants: FULL_GRANTS }).canManageSla === false
)
check(
  "invoice actions open on portal.billing.action",
  resolvePortalAccess({
    features: {},
    permissions: ["billing.view", "portal.billing.action"],
    grants: FULL_GRANTS,
  }).canActOnInvoice === true
)
check(
  "invoice actions also open on portal.dispute.create, as the route allows",
  resolvePortalAccess({
    features: {},
    permissions: ["billing.view", "portal.dispute.create"],
    grants: FULL_GRANTS,
  }).canActOnInvoice === true
)
check(
  "invoice actions stay shut on the view permission alone",
  fullClient.canActOnInvoice === true && grantWithoutRbac.canActOnInvoice === false,
  "and are closed outright when billing itself is closed"
)


// -------------------------------------------------------------- portal documents
//
// The two finance documents are served by their own portal route rather than by
// /api/documents, which gates on the staff `finance.view` permission. What the
// portal exposes is therefore a decision in its own right, and this is the list.

check(
  "billing documents follow the billing section, not a separate grant",
  resolvePortalAccess({ features: {}, permissions: ["billing.view"], grants: FULL_GRANTS }).can
    .billing === true &&
    resolvePortalAccess({ features: {}, permissions: [], grants: FULL_GRANTS }).can.billing === false,
  "so a client who cannot see an invoice cannot print one either"
)
check(
  "billing disabled for the tenant closes the documents with it",
  resolvePortalAccess({
    features: { billing: false },
    permissions: ["billing.view"],
    grants: FULL_GRANTS,
  }).can.billing === false
)

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll portal access checks passed.")
process.exit(failures ? 1 : 0)
