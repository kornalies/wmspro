// Shared constants for the Warehouse Zone Layout master. Imported by both the
// server route (app/api/zone-layouts/route.ts) and the admin UI so the list of
// zone functions and bin statuses stays in one place.

// Functional classification of a zone. Drives put-away/picking behaviour and
// lets the system tell "where stock lands after GRN" apart from "where you pick"
// and "where you stage for dispatch".
export const ZONE_TYPES = [
  "RECEIVING",
  "STORAGE",
  "PICKING",
  "PACKING",
  "STAGING",
  "DISPATCH",
  "RETURNS",
  "QC",
  "QUARANTINE",
  "DAMAGE",
] as const

export type ZoneType = (typeof ZONE_TYPES)[number]

export const DEFAULT_ZONE_TYPE: ZoneType = "STORAGE"

export const ZONE_TYPE_LABELS: Record<ZoneType, string> = {
  RECEIVING: "Receiving",
  STORAGE: "Storage / Reserve",
  PICKING: "Picking / Forward Pick",
  PACKING: "Packing",
  STAGING: "Outbound Staging",
  DISPATCH: "Dispatch / Shipping",
  RETURNS: "Returns",
  QC: "Quality Control",
  QUARANTINE: "Quarantine / Hold",
  DAMAGE: "Damaged Goods",
}

export function isZoneType(value: unknown): value is ZoneType {
  return typeof value === "string" && (ZONE_TYPES as readonly string[]).includes(value)
}

export function zoneTypeLabel(value: unknown): string {
  return isZoneType(value) ? ZONE_TYPE_LABELS[value] : DEFAULT_ZONE_TYPE
}

// Operational status of a bin, independent of is_active (which is soft-delete).
// Only AVAILABLE bins accept put-away; the rest take the bin out of the pool
// without deleting it.
export const BIN_STATUSES = [
  "AVAILABLE",
  "BLOCKED",
  "HOLD",
  "DAMAGED",
  "COUNTING",
] as const

export type BinStatus = (typeof BIN_STATUSES)[number]

export const DEFAULT_BIN_STATUS: BinStatus = "AVAILABLE"

export const BIN_STATUS_LABELS: Record<BinStatus, string> = {
  AVAILABLE: "Available",
  BLOCKED: "Blocked",
  HOLD: "On Hold",
  DAMAGED: "Damaged",
  COUNTING: "Under Count",
}

export function isBinStatus(value: unknown): value is BinStatus {
  return typeof value === "string" && (BIN_STATUSES as readonly string[]).includes(value)
}

export function binStatusLabel(value: unknown): string {
  return isBinStatus(value) ? BIN_STATUS_LABELS[value] : BIN_STATUS_LABELS[DEFAULT_BIN_STATUS]
}
