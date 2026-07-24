/**
 * Shared plumbing for the outbound tail (pack -> goods issue -> load ->
 * delivery note). Keeps the six endpoints to their actual business rules
 * instead of six copies of the same lock-and-scope preamble.
 */

import { normalizeDOStatus, type DOStatus } from "@/lib/do-status"

type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export class OutboundTailError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
    this.name = "OutboundTailError"
  }
}

export type LockedDO = {
  id: number
  doNumber: string
  status: DOStatus
  warehouseId: number
  clientId: number
}

/** Resolve a DO by numeric id or do_number, lock it, and normalize its status. */
export async function lockDO(
  db: DBClient,
  companyId: number,
  ref: string
): Promise<LockedDO> {
  const trimmed = decodeURIComponent(ref).trim()
  const numericId = /^\d+$/.test(trimmed) ? Number(trimmed) : null
  const doNumber = numericId ? null : trimmed
  if (!numericId && !doNumber) {
    throw new OutboundTailError("VALIDATION_ERROR", "Invalid delivery order reference", 400)
  }

  const result = await db.query(
    `SELECT id, do_number, status, warehouse_id, client_id
     FROM do_header
     WHERE company_id = $1
       AND (
         ($2::int IS NOT NULL AND id = $2)
         OR ($3::text IS NOT NULL AND do_number ILIKE $3)
       )
     FOR UPDATE`,
    [companyId, numericId, doNumber]
  )
  if (!result.rows.length) {
    throw new OutboundTailError("NOT_FOUND", "Delivery Order not found", 404)
  }

  const row = result.rows[0]
  const status = normalizeDOStatus(row.status)
  if (!status) {
    throw new OutboundTailError(
      "DO_STATUS_INVALID",
      `Invalid DO status '${String(row.status ?? "")}'`
    )
  }

  return {
    id: Number(row.id),
    doNumber: String(row.do_number),
    status,
    warehouseId: Number(row.warehouse_id),
    clientId: Number(row.client_id),
  }
}

export function assertDOStatusIn(doRow: LockedDO, allowed: DOStatus[], action: string) {
  if (!allowed.includes(doRow.status)) {
    throw new OutboundTailError(
      "WORKFLOW_BLOCKED",
      `Cannot ${action} a DO in status ${doRow.status}. Expected one of: ${allowed.join(", ")}.`
    )
  }
}

/**
 * Document numbers come from dedicated sequences (migrations 063-065) rather
 * than the CONCAT(..., RANDOM()) shape used by gate_out, which collides.
 */
export async function nextDocumentNumber(
  db: DBClient,
  sequence: string,
  prefix: string
): Promise<string> {
  const allowed = [
    "pack_unit_code_seq",
    "goods_issue_number_seq",
    "outbound_load_number_seq",
    "delivery_note_number_seq",
  ]
  if (!allowed.includes(sequence)) {
    throw new OutboundTailError("VALIDATION_ERROR", `Unknown sequence ${sequence}`, 400)
  }
  const result = await db.query(`SELECT nextval('public.${sequence}') AS seq`)
  const seq = String(result.rows[0]?.seq ?? "0")
  const year = new Date().getUTCFullYear()
  return `${prefix}-${year}-${seq.padStart(8, "0")}`
}

export function setDOStatus(db: DBClient, companyId: number, doId: number, status: DOStatus) {
  return db.query(
    `UPDATE do_header
     SET status = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
       AND company_id = $3`,
    [status, doId, companyId]
  )
}