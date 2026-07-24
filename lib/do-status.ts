export const DO_STATUSES = [
  "DRAFT",
  "PENDING",
  "PICKED",
  "PACKED",
  "STAGED",
  "ISSUED",
  "LOADED",
  "PARTIALLY_FULFILLED",
  "COMPLETED",
  "CANCELLED",
] as const

export type DOStatus = (typeof DO_STATUSES)[number]
export const DEFAULT_DO_STATUS: DOStatus = "PENDING"

/**
 * Statuses an operator may set directly through the DO workflow endpoint.
 *
 * ISSUED and LOADED are deliberately excluded: they are owned by the goods-issue
 * and loading endpoints (Track A2/A3). Until those ship there is no UI to move a
 * DO out of them, so letting the workflow endpoint set them would strand orders.
 */
export const DO_WORKFLOW_STATUSES = ["PICKED", "PACKED", "STAGED"] as const
export type DOWorkflowStatus = (typeof DO_WORKFLOW_STATUSES)[number]

export const LEGACY_DO_STATUS_MAP: Readonly<Record<string, DOStatus>> = Object.freeze({
  CREATED: "DRAFT",
  OPEN: "DRAFT",
  NEW: "DRAFT",
  CONFIRMED: "PENDING",
  APPROVED: "PENDING",
  ALLOCATED: "PENDING",
  PICKING_DONE: "PICKED",
  READY: "STAGED",
  READY_TO_DISPATCH: "STAGED",
  PARTIAL: "PARTIALLY_FULFILLED",
  DISPATCHED: "COMPLETED",
  DELIVERED: "COMPLETED",
  FULFILLED: "COMPLETED",
})

export const DO_FULFILLMENT_STATUSES: readonly DOStatus[] = [
  "PARTIALLY_FULFILLED",
  "COMPLETED",
]

export const DO_STATUS_LABELS: Readonly<Record<DOStatus, string>> = Object.freeze({
  DRAFT: "Draft",
  PENDING: "Pending",
  PICKED: "Picked",
  PACKED: "Packed",
  STAGED: "Staged",
  ISSUED: "Goods Issued",
  LOADED: "Loaded",
  PARTIALLY_FULFILLED: "Partial",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
})

/**
 * Allowed forward transitions, keyed by current status.
 *
 * PICKED -> STAGED is retained alongside PICKED -> PACKED so tenants that do not
 * pack (bulk / non-palletised outbound) keep their existing one-step path.
 * COMPLETED and CANCELLED are terminal.
 */
export const DO_STATUS_TRANSITIONS: Readonly<Record<DOStatus, readonly DOStatus[]>> =
  Object.freeze({
    DRAFT: ["PENDING", "PICKED", "CANCELLED"],
    PENDING: ["PICKED", "CANCELLED"],
    PICKED: ["PACKED", "STAGED", "CANCELLED"],
    PACKED: ["STAGED", "CANCELLED"],
    STAGED: ["ISSUED", "PARTIALLY_FULFILLED", "COMPLETED", "CANCELLED"],
    ISSUED: ["LOADED", "PARTIALLY_FULFILLED", "COMPLETED", "CANCELLED"],
    LOADED: ["PARTIALLY_FULFILLED", "COMPLETED"],
    PARTIALLY_FULFILLED: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: [],
  })

const DO_STATUS_SET = new Set<string>(DO_STATUSES)
const DO_WORKFLOW_SET = new Set<string>(DO_WORKFLOW_STATUSES)

export function getDOStatusErrorMessage(value: unknown) {
  return `Invalid DO status '${String(value ?? "")}'. Allowed statuses: ${DO_STATUSES.join(", ")}`
}

export function normalizeDOStatus(value: unknown): DOStatus | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toUpperCase()
  if (!normalized) return null
  if (DO_STATUS_SET.has(normalized)) return normalized as DOStatus
  return LEGACY_DO_STATUS_MAP[normalized] ?? null
}

export function isDOStatus(value: unknown): value is DOStatus {
  if (typeof value !== "string") return false
  return DO_STATUS_SET.has(value)
}

export function isDOWorkflowStatus(value: unknown): value is DOWorkflowStatus {
  if (typeof value !== "string") return false
  return DO_WORKFLOW_SET.has(value)
}

/**
 * Whether `from` may move to `to`. Re-asserting the current status is always
 * allowed so workflow calls stay idempotent on retry.
 */
export function canTransitionDOStatus(from: DOStatus, to: DOStatus): boolean {
  if (from === to) return true
  return DO_STATUS_TRANSITIONS[from].includes(to)
}

export function getDOStatusLabel(value: unknown): string {
  const normalized = normalizeDOStatus(value)
  if (normalized) return DO_STATUS_LABELS[normalized]
  return String(value ?? "Unknown")
}
