import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import {
  allocatableStockPredicate,
  allocationOrderBy,
  describeAllocationRule,
  normalizeAllocationRule,
} from "@/lib/allocation"

type RouteContext = {
  params: Promise<{ id: string }>
}

type FifoRow = {
  do_id: number
  do_number: string
  line_item_id: number
  item_id: number
  item_name: string
  item_code: string
  quantity_requested: number
  quantity_dispatched: number
  quantity_remaining: number
  stock_id: number | null
  serial_number: string | null
  stock_status: "IN_STOCK" | "RESERVED" | null
  received_date: string | null
  age_days: number | null
  bin_location: string | null
  batch_number: string | null
  expiry_date: string | null
  days_to_expiry: number | null
}

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { id } = await context.params
    const rawRef = decodeURIComponent(id).trim()
    const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
    const doNumber = numericId ? null : rawRef
    if (!numericId && !doNumber) return fail("VALIDATION_ERROR", "Invalid delivery order reference", 400)

    // The DO's allocation rule decides the suggestion order, so it has to be
    // known before the query is built. Resolving it separately keeps the rule
    // out of the ORDER BY as a parameter, which Postgres would not accept.
    const ruleResult = await query(
      `SELECT allocation_rule
       FROM do_header
       WHERE company_id = $1
         AND (
           ($2::int IS NOT NULL AND id = $2)
           OR ($3::text IS NOT NULL AND do_number ILIKE $3)
         )
       LIMIT 1`,
      [session.companyId, numericId, doNumber]
    )
    if (!ruleResult.rows.length) return fail("NOT_FOUND", "Delivery Order not found", 404)
    const rule = normalizeAllocationRule(ruleResult.rows[0].allocation_rule)

    const rowsResult = await query(
      `SELECT
        dh.id AS do_id,
        dh.do_number,
        dli.id AS line_item_id,
        dli.item_id,
        i.item_name,
        i.item_code,
        dli.quantity_requested,
        dli.quantity_dispatched,
        GREATEST(dli.quantity_requested - dli.quantity_dispatched, 0) AS quantity_remaining,
        ssn.id AS stock_id,
        ssn.serial_number,
        ssn.status AS stock_status,
        ssn.received_date,
        ssn.batch_number,
        ssn.expiry_date,
        (ssn.expiry_date - CURRENT_DATE) AS days_to_expiry,
        dh.allocation_rule,
        (CURRENT_DATE - ssn.received_date::date) AS age_days,
        COALESCE(ssn.bin_location, CONCAT(zl.zone_code, '/', zl.rack_code, '/', zl.bin_code), 'Unassigned') AS bin_location
      FROM do_header dh
      JOIN do_line_items dli ON dli.do_header_id = dh.id AND dli.company_id = dh.company_id
      JOIN items i ON i.id = dli.item_id AND i.company_id = dh.company_id
      LEFT JOIN stock_serial_numbers ssn
        ON ssn.item_id = dli.item_id
       AND ssn.company_id = dh.company_id
       AND ssn.client_id = dh.client_id
       AND ssn.warehouse_id = dh.warehouse_id
       AND (
         (ssn.status = 'RESERVED' AND ssn.do_line_item_id = dli.id)
         OR (ssn.status = 'IN_STOCK' AND ssn.do_line_item_id IS NULL)
       )
       AND ${allocatableStockPredicate("ssn", "i")}
      LEFT JOIN warehouse_zone_layouts zl ON zl.id = ssn.zone_layout_id AND zl.company_id = dh.company_id
      WHERE dh.company_id = $1
        AND (
          ($2::int IS NOT NULL AND dh.id = $2)
          OR ($3::text IS NOT NULL AND dh.do_number ILIKE $3)
        )
      ORDER BY i.item_name ASC, ${allocationOrderBy(rule, "ssn")}`,
      [session.companyId, numericId, doNumber]
    )

    const rows = rowsResult.rows as FifoRow[]
    if (!rows.length) return fail("NOT_FOUND", "Delivery Order not found", 404)

    const lineMap = new Map<
      number,
      {
        line_item_id: number
        item_id: number
        item_name: string
        item_code: string
        quantity_requested: number
        quantity_dispatched: number
        quantity_remaining: number
        fifo_stock: Array<{
          stock_id: number
          serial_number: string
          stock_status: "IN_STOCK" | "RESERVED"
          received_date: string
          age_days: number
          bin_location: string
          batch_number: string | null
          expiry_date: string | null
          days_to_expiry: number | null
        }>
      }
    >()

    for (const row of rows) {
      if (!lineMap.has(row.line_item_id)) {
        lineMap.set(row.line_item_id, {
          line_item_id: row.line_item_id,
          item_id: row.item_id,
          item_name: row.item_name,
          item_code: row.item_code,
          quantity_requested: Number(row.quantity_requested),
          quantity_dispatched: Number(row.quantity_dispatched),
          quantity_remaining: Number(row.quantity_remaining),
          fifo_stock: [],
        })
      }

      if (row.stock_id && row.serial_number && row.received_date) {
        lineMap.get(row.line_item_id)?.fifo_stock.push({
          stock_id: Number(row.stock_id),
          serial_number: row.serial_number,
          stock_status: row.stock_status === "RESERVED" ? "RESERVED" : "IN_STOCK",
          received_date: row.received_date,
          age_days: Number(row.age_days || 0),
          bin_location: row.bin_location || "Unassigned",
          batch_number: row.batch_number ?? null,
          expiry_date: row.expiry_date ?? null,
          days_to_expiry: row.days_to_expiry === null ? null : Number(row.days_to_expiry),
        })
      }
    }

    return ok({
      do_id: Number(rows[0].do_id),
      do_number: String(rows[0].do_number || rawRef),
      // Callers render the suggestion order, so they need to know which rule
      // produced it — and, for a rule that is not yet distinct, that it did not.
      allocation_rule: rule,
      allocation_note: describeAllocationRule(rule),
      excludes_expired: true,
      lines: Array.from(lineMap.values()),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch FIFO stock"
    return fail("SERVER_ERROR", message, 500)
  }
}
