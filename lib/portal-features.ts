/**
 * The canonical portal feature keys.
 *
 * Deliberately its own module with no imports: the admin user editor is a client
 * component, and pulling this list out of lib/portal.ts would drag lib/db (and
 * with it pg) into the browser bundle.
 *
 * Four things have to agree on this list — the /api/portal/features response,
 * the admin editor's checkboxes, the route guards, and the backfill in migration
 * 080. When they drifted, the symptom was a key that no screen could grant but
 * some route still demanded, which reads as a permissions bug with no bad
 * permission anywhere in sight.
 */
export const PORTAL_FEATURE_KEYS = [
  "portal.inventory.view",
  "portal.orders.view",
  "portal.billing.view",
  "portal.reports.view",
  "portal.sla.view",
  "portal.sla.manage",
  "portal.dispute.view",
  "portal.dispute.create",
  "portal.dispute.manage",
  "portal.asn.view",
  "portal.asn.create",
] as const

export type PortalFeatureKey = (typeof PORTAL_FEATURE_KEYS)[number]

/**
 * Labels for the admin editor. A Record rather than a list of {key, label}
 * pairs so that adding a key above without labelling it here fails to compile.
 */
export const PORTAL_FEATURE_LABELS: Record<PortalFeatureKey, string> = {
  "portal.inventory.view": "Inventory",
  "portal.orders.view": "Orders",
  "portal.billing.view": "Billing",
  "portal.reports.view": "Reports",
  "portal.sla.view": "SLA View",
  "portal.sla.manage": "SLA Manage",
  "portal.dispute.view": "Dispute View",
  "portal.dispute.create": "Dispute Create",
  "portal.dispute.manage": "Dispute Manage",
  "portal.asn.view": "ASN View",
  "portal.asn.create": "ASN Create",
}
