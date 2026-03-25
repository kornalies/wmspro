import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { normalizeDOStatus } from "@/lib/do-status"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { id } = await context.params
    const rawRef = decodeURIComponent(id).trim()
    const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
    const doNumber = numericId ? null : rawRef

    const header = await query(
      `SELECT
        dh.*,
        c.client_name,
        w.warehouse_name
      FROM do_header dh
      JOIN clients c ON c.id = dh.client_id AND c.company_id = dh.company_id
      JOIN warehouses w ON w.id = dh.warehouse_id AND w.company_id = dh.company_id
      WHERE dh.company_id = $1
        AND (
          ($2::int IS NOT NULL AND dh.id = $2)
          OR ($3::text IS NOT NULL AND dh.do_number ILIKE $3)
        )
      LIMIT 1`,
      [session.companyId, numericId, doNumber]
    )

    if (header.rows.length === 0) return fail("NOT_FOUND", "Delivery Order not found", 404)
    const doId = Number(header.rows[0].id)

    const lines = await query(
      `SELECT
        dli.id,
        dli.item_id,
        i.item_name,
        i.item_code,
        dli.quantity_requested,
        dli.quantity_dispatched,
        COALESCE(reserved.reserved_qty, 0) AS quantity_reserved,
        COALESCE(availability.available_qty, 0) AS available_inventory,
        GREATEST(dli.quantity_requested - dli.quantity_dispatched, 0) AS quantity_remaining,
        i.uom AS unit
      FROM do_line_items dli
      JOIN do_header dh ON dh.id = dli.do_header_id AND dh.company_id = dli.company_id
      JOIN items i ON i.id = dli.item_id AND i.company_id = dh.company_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS reserved_qty
        FROM stock_serial_numbers ssn
        WHERE ssn.company_id = dh.company_id
          AND ssn.do_line_item_id = dli.id
          AND ssn.status = 'RESERVED'
      ) reserved ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS available_qty
        FROM stock_serial_numbers ssn
        WHERE ssn.company_id = dh.company_id
          AND ssn.client_id = dh.client_id
          AND ssn.warehouse_id = dh.warehouse_id
          AND ssn.item_id = dli.item_id
          AND (
            (ssn.status = 'RESERVED' AND ssn.do_line_item_id = dli.id)
            OR (ssn.status = 'IN_STOCK' AND ssn.do_line_item_id IS NULL)
          )
      ) availability ON true
      WHERE dli.do_header_id = $1
        AND dh.company_id = $2
      ORDER BY dli.id`,
      [doId, session.companyId]
    )

    const row = header.rows[0]
    return ok({
      ...row,
      status: normalizeDOStatus(row.status) || row.status,
      items: lines.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch DO"
    return fail("SERVER_ERROR", message, 500)
  }
}
