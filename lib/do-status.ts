export const DO_STATUSES = [
  "DRAFT",
  "PENDING",
  "PICKED",
  "STAGED",
  "PARTIALLY_FULFILLED",
  "COMPLETED",
  "CANCELLED",
] as const

export type DOStatus = (typeof DO_STATUSES)[number]
export const DEFAULT_DO_STATUS: DOStatus = "PENDING"

export const DO_WORKFLOW_STATUSES = ["PICKED", "STAGED"] as const
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
  STAGED: "Staged",
  PARTIALLY_FULFILLED: "Partial",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
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

export function getDOStatusLabel(value: unknown): string {
  const normalized = normalizeDOStatus(value)
  if (normalized) return DO_STATUS_LABELS[normalized]
  return String(value ?? "Unknown")
}
