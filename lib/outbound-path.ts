/**
 * Per-DO outbound path exclusivity.
 *
 * A delivery order can leave the building two ways: the quantity-based dispatch
 * route, or the packed tail (pack unit -> goods issue -> load -> delivery note).
 * Both are supported and both are needed -- dispatch is the only path that
 * captures the outward register and the Job Card handling fields, and the only
 * one the mobile app can reach; the tail is the only one with serial-level
 * traceability. Tenants legitimately use both.
 *
 * What is NOT legitimate is one order using both, because the two paths record
 * fulfilment progress in different places -- dispatch moves quantity_dispatched,
 * the tail writes do_pack_unit_serials -- and the billing dedupe key in
 * lib/billing-service.ts includes event_date. So a DO fulfilled partly each way
 * either double-bills the client (paths ran on different dates, two rows) or
 * under-bills (same date, the ON CONFLICT upsert replaces the quantity instead
 * of summing it, silently dropping the first path's charge).
 *
 * The rule: whichever path touches an order first claims it. This is deliberately
 * per-order and not a tenant setting -- two users in one tenant are enough to
 * cause the damage, so a tenant-level flag would not prevent it, and changing
 * such a flag mid-order would strand work in progress.
 */

type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export type OutboundPath = "DISPATCH" | "TAIL"

export type OutboundPathClaim = {
  path: OutboundPath
  /** Live (non-cancelled) pack units on the order. */
  packUnits: number
  /** Dispatched quantity not accounted for by packed serials. */
  unpackedDispatched: number
}

/**
 * Which path, if any, has already claimed this DO. Null means unclaimed and
 * either path may take it.
 *
 * `total_quantity_dispatched > 0` on its own is NOT evidence of the dispatch
 * path: delivery-note finalize writes that same column at the end of the tail
 * (see app/api/do/delivery-notes/[id]/finalize/route.ts). A cleanly completed
 * tail order carries both markers. Only dispatched quantity *in excess of* the
 * order's packed serials can have come from the dispatch route.
 *
 * Cancelled pack units do not claim the order -- reversing a DO or voiding its
 * pack units is how an operator legitimately frees it to take the other path.
 */
export async function getOutboundPathClaim(
  db: DBClient,
  companyId: number,
  doId: number
): Promise<OutboundPathClaim | null> {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM do_pack_units u
         WHERE u.company_id = $1
           AND u.do_header_id = $2
           AND u.status <> 'CANCELLED') AS pack_units,
       GREATEST(
         COALESCE(dh.total_quantity_dispatched, 0) - (
           SELECT COUNT(*)::int
             FROM do_pack_unit_serials s
             JOIN do_line_items l
               ON l.id = s.do_line_item_id
              AND l.company_id = s.company_id
            WHERE s.company_id = $1
              AND l.do_header_id = $2
         ),
         0
       )::int AS unpacked_dispatched
     FROM do_header dh
     WHERE dh.company_id = $1
       AND dh.id = $2`,
    [companyId, doId]
  )

  if (!result.rows.length) return null

  const packUnits = Number(result.rows[0].pack_units ?? 0)
  const unpackedDispatched = Number(result.rows[0].unpacked_dispatched ?? 0)

  // Dispatch is checked first: if an order somehow carries both markers it is
  // already in the inconsistent state this guard exists to prevent, and the
  // honest response is to block the tail rather than let it compound.
  if (unpackedDispatched > 0) return { path: "DISPATCH", packUnits, unpackedDispatched }
  if (packUnits > 0) return { path: "TAIL", packUnits, unpackedDispatched }
  return null
}

const PATH_LABEL: Record<OutboundPath, string> = {
  DISPATCH: "dispatch",
  TAIL: "packed outbound (pack unit / goods issue / delivery note)",
}

/** Operator-facing explanation, including how to release the order. */
export function outboundPathConflictMessage(
  claim: OutboundPathClaim,
  attempted: OutboundPath
): string {
  const evidence =
    claim.path === "DISPATCH"
      ? `${claim.unpackedDispatched} unit(s) already dispatched directly`
      : `${claim.packUnits} pack unit(s) already built`
  const release =
    claim.path === "DISPATCH"
      ? "Reverse the delivery order to release it."
      : "Void the pack units, or reverse the delivery order, to release it."

  return (
    `This delivery order is already being fulfilled via ${PATH_LABEL[claim.path]} ` +
    `(${evidence}), so it cannot also use ${PATH_LABEL[attempted]}. ` +
    `Mixing both on one order corrupts its billing. ${release}`
  )
}
