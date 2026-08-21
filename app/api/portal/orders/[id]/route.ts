import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { DO_STATUS_TRANSITIONS, normalizeDOStatus, type DOStatus } from "@/lib/do-status"
import { getOutboundPathClaim } from "@/lib/outbound-path"

import {
  guardPortalProductError,
  hasPortalFeaturePermission,
  parseAndAuthorizeClientId,
} from "@/app/api/portal/_utils"

/**
 * One order, with its lines and where it has actually got to.
 *
 * The list screen could say an order went out short but never which line was
 * short, so "why is my order incomplete?" was a phone call every time. Both
 * halves are here: the per-line requested-vs-dispatched split, and a timeline
 * assembled from the timestamps the outbound chain already writes.
 *
 * Every timeline step is read from a real column. Nothing is inferred from the
 * status, because a status tells you where an order is now and not when it got
 * there -- and a fabricated timestamp on a client-facing screen is worse than an
 * absent one.
 *
 * Two things a naive timeline would get wrong here:
 *
 * 1. THERE ARE TWO OUTBOUND PATHS. An order goes out either through dispatch or
 *    through the packed tail (pack unit / goods issue / delivery note), never
 *    both -- see lib/outbound-path.ts. So a completed dispatch-path order has no
 *    picking and no packing, and rendering those steps as "not yet" on an order
 *    that already shipped is simply false. Steps carry a `state` of done,
 *    pending or not_applicable, decided by the path the order actually took.
 *
 *    The same reasoning applies once an order is TERMINAL. COMPLETED and
 *    CANCELLED have no onward transitions, so a step with no timestamp on such
 *    an order did not happen and never will -- calling it "pending" promises the
 *    client something that is not coming. Only an order still in flight has
 *    pending steps.
 *
 * 2. PRECISION VARIES. `created_at` and `confirmed_at` are timestamps, while
 *    `request_date` and `dispatch_date` are DATEs -- midnight local, which
 *    renders as the previous evening in UTC and invents a dispatch time that
 *    never happened. Each step declares its own precision so the UI can show a
 *    day as a day.
 */

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.orders.view"))) {
      return fail("FORBIDDEN", "No portal orders permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const orderId = Number((await context.params).id)
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return fail("VALIDATION_ERROR", "Invalid order id", 400)
    }

    // client_id in the WHERE, not just in the gate: the gate proves the caller
    // may read THIS client, and this proves the order belongs to it. Without the
    // second check a portal user could read another client's order by its id.
    const headerRes = await query(
      `SELECT
         h.id,
         h.do_number,
         h.request_date,
         h.expected_dispatch_date,
         h.dispatch_date,
         h.status,
         h.remarks,
         h.total_items,
         h.total_quantity_requested,
         h.total_quantity_dispatched,
         h.created_at,
         h.confirmed_at,
         w.warehouse_name,
         w.warehouse_code
       FROM do_header h
       LEFT JOIN warehouses w ON w.id = h.warehouse_id
       WHERE h.id = $1 AND h.client_id = $2
       LIMIT 1`,
      [orderId, clientIdCheck.clientId]
    )
    if (!headerRes.rows.length) return fail("NOT_FOUND", "Order not found", 404)
    const header = headerRes.rows[0] as Record<string, unknown>

    const linesRes = await query(
      `SELECT
         l.id,
         l.line_number,
         l.quantity_requested,
         l.quantity_dispatched,
         COALESCE(l.uom, i.uom) AS uom,
         l.remarks,
         i.item_code,
         i.item_name
       FROM do_line_items l
       JOIN items i ON i.id = l.item_id
       WHERE l.do_header_id = $1
       ORDER BY l.line_number ASC`,
      [orderId]
    )

    // Picking and packing have no column on the header, so they are derived from
    // the work itself: the last task to finish is when picking finished. MIN of
    // started_at rather than MAX, because picking began when the first picker did.
    const progressRes = await query(
      `SELECT
         (SELECT MIN(started_at) FROM do_pick_tasks WHERE do_header_id = $1) AS picking_started_at,
         (SELECT MAX(completed_at) FROM do_pick_tasks WHERE do_header_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM do_pick_tasks t2
             WHERE t2.do_header_id = $1 AND t2.completed_at IS NULL
           )) AS picked_at,
         (SELECT MAX(closed_at) FROM do_pack_units WHERE do_header_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM do_pack_units p2
             WHERE p2.do_header_id = $1 AND p2.closed_at IS NULL
           )) AS packed_at,
         (SELECT COUNT(*) FROM do_pack_units WHERE do_header_id = $1)::int AS pack_count`,
      [orderId]
    )
    const progress = (progressRes.rows[0] ?? {}) as Record<string, unknown>

    // Which path this order took, using the same rule the outbound guards use.
    // A dedicated connection with tenant context, because the helper reads
    // do_pack_unit_serials, which is behind RLS.
    const pathDb = await getClient()
    let path: string | null = null
    try {
      await pathDb.query("BEGIN")
      await setTenantContext(pathDb, session.companyId)
      const claim = await getOutboundPathClaim(pathDb, session.companyId, orderId)
      path = claim?.path ?? null
      await pathDb.query("COMMIT")
    } catch {
      await pathDb.query("ROLLBACK")
    } finally {
      pathDb.release()
    }

    const status = (normalizeDOStatus(header.status as string) || header.status) as DOStatus
    // Terminal means the status machine offers no onward transition.
    const isTerminal = (DO_STATUS_TRANSITIONS[status]?.length ?? 0) === 0

    // An unclaimed order that is still moving has both paths open, so its packed
    // steps are legitimately pending.
    const packedPathSteps = path === "DISPATCH" || isTerminal ? "not_applicable" : "pending"
    const stepState = (at: unknown, whenMissing: string) =>
      at ? "done" : isTerminal ? "not_applicable" : whenMissing

    return ok({
      ...header,
      status,
      lines: linesRes.rows,
      // Ordered as the goods move. `at: null` means "has not happened", which the
      // UI renders as a pending step rather than inventing a date for it.
      outbound_path: path,
      timeline: [
        {
          key: "PLACED",
          label: "Order placed",
          at: header.created_at ?? header.request_date ?? null,
          precision: header.created_at ? "time" : "day",
          state: stepState(header.created_at ?? header.request_date, "pending"),
        },
        {
          key: "CONFIRMED",
          label: "Confirmed by warehouse",
          at: header.confirmed_at ?? null,
          precision: "time",
          state: stepState(header.confirmed_at, "pending"),
        },
        {
          key: "PICKING",
          label: "Picking started",
          at: progress.picking_started_at ?? null,
          precision: "time",
          state: stepState(progress.picking_started_at, packedPathSteps),
        },
        {
          key: "PICKED",
          label: "Picked",
          at: progress.picked_at ?? null,
          precision: "time",
          state: stepState(progress.picked_at, packedPathSteps),
        },
        {
          key: "PACKED",
          label: "Packed",
          at: progress.packed_at ?? null,
          precision: "time",
          state: stepState(progress.packed_at, packedPathSteps),
        },
        {
          key: "DISPATCHED",
          label: "Dispatched",
          at: header.dispatch_date ?? null,
          // A DATE column: day precision only. Showing a time here would invent one.
          precision: "day",
          state: stepState(header.dispatch_date, "pending"),
        },
      ],
      pack_count: progress.pack_count ?? 0,
    })
  } catch (error: unknown) {
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch order"
    return fail("SERVER_ERROR", message, 500)
  }
}
