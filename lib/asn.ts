/**
 * Advance shipment notices: the client's half of inbound.
 *
 * An ASN is a claim, not a fact. The client says "six pallets of SKU-1180 are
 * coming Thursday"; the warehouse finds out what actually turned up when it
 * opens the truck. Everything here keeps that distinction: expected_quantity
 * lives on the request and never moves stock, and the GRN -- built from what was
 * counted on the dock -- is what the rest of the system believes.
 *
 * The link between the two is one nullable column (grn_header.asn_request_id).
 * That is on purpose. Receiving must never depend on an ASN existing: most
 * inbound arrives with no notice at all, and a GRN that required a request to
 * point at would break every one of those.
 */
import type { TokenPayload } from "@/lib/auth"

export const ASN_STATUSES = ["REQUESTED", "ACCEPTED", "REJECTED", "RECEIVED", "CANCELLED"] as const
export type AsnStatus = (typeof ASN_STATUSES)[number]

/** Requests still awaiting a decision from the warehouse. */
export const ASN_OPEN_STATUSES: AsnStatus[] = ["REQUESTED", "ACCEPTED"]

type DBClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type AsnLineInput = {
  item_id: number
  expected_quantity: number
  uom?: string
  batch_no?: string
  expiry_date?: string
  remarks?: string
}

export class AsnError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message)
    this.name = "AsnError"
  }
}

/**
 * Reserve the next ASNREQ- number for a company.
 *
 * The transaction-scoped advisory lock is what makes concurrent submissions
 * safe. Without it two clients posting at the same moment both read the same
 * MAX(...) and the second one dies on the unique constraint with a raw
 * duplicate-key error -- rare at today's volumes, and impossible to explain to
 * the client who hit it. Keyed on company so tenants never queue behind each
 * other. Must be called inside a transaction; pg_advisory_xact_lock releases on
 * COMMIT or ROLLBACK, so there is no leak path.
 */
export async function reserveAsnRequestNumber(db: DBClient, companyId: number): Promise<string> {
  await db.query("SELECT pg_advisory_xact_lock($1, $2)", [companyId, 8110])
  const seq = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(request_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
     FROM client_portal_asn_requests
     WHERE company_id = $1
       AND request_number LIKE 'ASNREQ-%'`,
    [companyId]
  )
  const next = Number(seq.rows[0]?.next_seq) || 1
  return `ASNREQ-${String(next).padStart(6, "0")}`
}

/**
 * Confirm every line references an item this company actually has, and return
 * each item's UOM.
 *
 * The client picks from the item master, so a bad item_id here means a stale
 * browser tab or a hand-rolled request -- either way it is rejected before it
 * can create a request whose lines cannot be turned into a GRN. UOM is resolved
 * from the master rather than trusted from the payload for the same reason the
 * GRN service does it: two spellings of the same unit reconcile as different
 * things.
 */
export async function resolveAsnLineItems(
  db: DBClient,
  companyId: number,
  lines: AsnLineInput[]
): Promise<Map<number, string>> {
  const itemIds = Array.from(new Set(lines.map((line) => Number(line.item_id))))
  if (!itemIds.length) {
    throw new AsnError("VALIDATION_ERROR", "At least one line item is required", 400)
  }

  const found = await db.query(
    `SELECT id, uom
     FROM items
     WHERE company_id = $1
       AND id = ANY($2::int[])
       AND is_active = true`,
    [companyId, itemIds]
  )

  const byId = new Map<number, string>()
  for (const row of found.rows) {
    byId.set(Number(row.id), String(row.uom))
  }

  const missing = itemIds.filter((id) => !byId.has(id))
  if (missing.length) {
    throw new AsnError(
      "UNKNOWN_ITEM",
      `Unknown or inactive item: ${missing.join(", ")}`,
      400
    )
  }

  return byId
}

/**
 * The request plus its lines, with each line's item spelled out.
 *
 * Shared by the portal (the client checking on their own request), the staff
 * queue, and the GRN prefill, so all three agree on what a request contains.
 * `receipts` carries any GRNs already raised against it -- a request can be
 * fulfilled by more than one, see migration 081.
 */
export type AsnRequestDetail = Record<string, unknown> & {
  id: number
  client_id: number
  status: AsnStatus
  lines: Array<Record<string, unknown>>
  receipts: Array<Record<string, unknown>>
}

export async function loadAsnRequest(
  db: DBClient,
  companyId: number,
  asnRequestId: number
): Promise<AsnRequestDetail | null> {
  const header = await db.query(
    `SELECT r.id, r.request_number, r.client_id, r.expected_date, r.remarks, r.status,
            r.requested_by, r.reviewed_by, r.reviewed_at, r.review_remarks,
            r.created_at, r.updated_at,
            c.client_name, c.client_code,
            requester.full_name AS requested_by_name,
            reviewer.full_name AS reviewed_by_name
     FROM client_portal_asn_requests r
     JOIN clients c ON c.id = r.client_id AND c.company_id = r.company_id
     LEFT JOIN users requester ON requester.id = r.requested_by AND requester.company_id = r.company_id
     LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by AND reviewer.company_id = r.company_id
     WHERE r.company_id = $1
       AND r.id = $2`,
    [companyId, asnRequestId]
  )
  if (!header.rows.length) return null

  const lines = await db.query(
    `SELECT l.id, l.line_number, l.item_id, l.expected_quantity, l.uom,
            l.batch_no, l.expiry_date, l.remarks,
            i.item_code, i.item_name
     FROM client_portal_asn_lines l
     JOIN items i ON i.id = l.item_id AND i.company_id = l.company_id
     WHERE l.company_id = $1
       AND l.asn_request_id = $2
     ORDER BY l.line_number ASC`,
    [companyId, asnRequestId]
  )

  const receipts = await db.query(
    `SELECT id, grn_number, grn_date, status, total_quantity
     FROM grn_header
     WHERE company_id = $1
       AND asn_request_id = $2
     ORDER BY created_at ASC`,
    [companyId, asnRequestId]
  )

  return {
    ...header.rows[0],
    lines: lines.rows,
    receipts: receipts.rows,
  } as unknown as AsnRequestDetail
}

/**
 * Record that a GRN was raised against a request.
 *
 * Only moves ACCEPTED -> RECEIVED. A second part-load against the same request
 * finds it already RECEIVED and changes nothing, which is why this is an UPDATE
 * with a status predicate rather than a read-then-write: it is idempotent, and
 * two GRNs committing concurrently cannot race each other into an odd state.
 * A request that was rejected or cancelled is deliberately left alone -- if
 * goods arrived anyway the GRN still records them, and the mismatch is
 * something the warehouse should see rather than have quietly tidied away.
 */
export async function markAsnReceived(db: DBClient, companyId: number, asnRequestId: number) {
  const updated = await db.query(
    `UPDATE client_portal_asn_requests
     SET status = 'RECEIVED', updated_at = CURRENT_TIMESTAMP
     WHERE company_id = $1
       AND id = $2
       AND status = 'ACCEPTED'
     RETURNING id`,
    [companyId, asnRequestId]
  )
  return updated.rows.length > 0
}

/** Staff-side visibility rule: only ADMINs see requests for every client. */
export function canReviewAsn(session: TokenPayload) {
  const role = String(session.role || "").toUpperCase()
  if (role === "SUPER_ADMIN" || role === "ADMIN") return true
  return Boolean(session.permissions?.includes("grn.manage"))
}
