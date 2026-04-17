import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureGrnManualSchema, ensureStockPutawaySchema } from "@/lib/db-bootstrap"
import { grnHeaderSchema, grnLineItemSchema } from "@/lib/validations"

type RouteContext = {
  params: Promise<{ id: string }>
}

type ParsedGrnLine = {
  item_id: number
  quantity: number
  serial_numbers: string[]
  rate?: number
  zone_layout_id?: number
}

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }

    const { id: grnId } = await context.params

    const headerResult = await query(
      `SELECT 
        gh.*,
        c.client_name, c.client_code,
        w.warehouse_name, w.warehouse_code,
        u.full_name as created_by_name
      FROM grn_header gh
      JOIN clients c ON gh.client_id = c.id AND c.company_id = gh.company_id
      JOIN warehouses w ON gh.warehouse_id = w.id AND w.company_id = gh.company_id
      LEFT JOIN users u ON gh.created_by = u.id AND u.company_id = gh.company_id
      WHERE gh.id = $1
        AND gh.company_id = $2`,
      [grnId, session.companyId]
    )

    if (headerResult.rows.length === 0) {
      return fail("NOT_FOUND", "GRN not found", 404)
    }

    const lineItemsResult = await query(
      `SELECT 
        gli.*,
        i.item_code, i.item_name, i.uom,
        (SELECT MAX(bin_location)
         FROM stock_serial_numbers
         WHERE grn_line_item_id = gli.id) as bin_location,
        COALESCE(
          (SELECT array_agg(serial_number ORDER BY serial_number)
           FROM stock_serial_numbers
           WHERE grn_line_item_id = gli.id),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(gli.serial_numbers_json, '[]'::jsonb)))
        ) as serial_numbers,
        COALESCE(
          (SELECT MAX(bin_location)
           FROM stock_serial_numbers
           WHERE grn_line_item_id = gli.id),
          CONCAT(zl.zone_code, '/', zl.rack_code, '/', zl.bin_code)
        ) as effective_bin_location
      FROM grn_line_items gli
      JOIN grn_header gh ON gh.id = gli.grn_header_id
      JOIN items i ON gli.item_id = i.id AND i.company_id = gh.company_id
      LEFT JOIN warehouse_zone_layouts zl ON zl.id = gli.zone_layout_id AND zl.company_id = gh.company_id
      WHERE gli.grn_header_id = $1
        AND gh.company_id = $2
      ORDER BY gli.id`,
      [grnId, session.companyId]
    )

    return ok({
      header: headerResult.rows[0],
      lineItems: lineItemsResult.rows,
    })
  } catch (error: unknown) {
    console.error("GRN fetch error:", error)
    const message = error instanceof Error ? error.message : "Failed to fetch GRN"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    await ensureGrnManualSchema(db)
    await ensureStockPutawaySchema(db)

    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.manage")

    const { id: grnId } = await context.params
    const body = await request.json()
    const header = grnHeaderSchema.parse(body.header)
    const lineItems: ParsedGrnLine[] = (Array.isArray(body.lineItems) ? body.lineItems : []).map((item: unknown) =>
      grnLineItemSchema.parse(item)
    )

    const targetStatus = header.status || "DRAFT"
    const computedLineQty = lineItems.reduce(
      (sum: number, item: { quantity: number }) => sum + Number(item.quantity || 0),
      0
    )

    if (targetStatus === "CONFIRMED") {
      if (header.total_quantity !== computedLineQty) {
        return fail("VALIDATION_ERROR", "Header and line quantities do not match", 400)
      }
      if (typeof header.received_quantity === "number" && header.received_quantity !== computedLineQty) {
        return fail("VALIDATION_ERROR", "Received quantity must match line total quantity", 400)
      }
      const mismatch = lineItems.find((item: ParsedGrnLine) => item.serial_numbers.length !== item.quantity)
      if (mismatch) {
        return fail("VALIDATION_ERROR", "Serial count must match quantity for all line items", 400)
      }
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const grnRow = await db.query(
      "SELECT id, status FROM grn_header WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [grnId, session.companyId]
    )
    if (!grnRow.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "GRN not found", 404)
    }
    if (grnRow.rows[0].status === "CANCELLED") {
      await db.query("ROLLBACK")
      return fail("INVALID_STATUS", "Cancelled GRN cannot be edited", 400)
    }

    await db.query(
      `UPDATE grn_header
       SET client_id = $1,
           warehouse_id = $2,
           invoice_number = $3,
           invoice_date = $4,
           supplier_name = $5,
           supplier_gst = $6,
           total_items = $7,
           total_quantity = $8,
           total_value = $9,
           gate_in_number = $10,
           model_number = $11,
           material_description = $12,
           receipt_date = $13,
           manufacturing_date = $14,
           basic_price = $15,
           invoice_quantity = $16,
           received_quantity = $17,
           quantity_difference = $18,
           damage_quantity = $19,
           case_count = $20,
           pallet_count = $21,
           weight_kg = $22,
           handling_type = $23,
           source_channel = $24,
           status = $25,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $26
         AND company_id = $27`,
      [
        header.client_id,
        header.warehouse_id,
        header.invoice_number,
        header.invoice_date,
        header.supplier_name || null,
        header.supplier_gst || null,
        header.total_items,
        header.total_quantity,
        header.total_value || 0,
        header.gate_in_number || null,
        header.model_number || null,
        header.material_description || null,
        header.receipt_date || null,
        header.manufacturing_date || null,
        header.basic_price ?? null,
        header.invoice_quantity ?? null,
        header.received_quantity ?? null,
        header.quantity_difference ?? null,
        header.damage_quantity ?? null,
        header.case_count ?? null,
        header.pallet_count ?? null,
        header.weight_kg ?? null,
        header.handling_type || null,
        header.source_channel || "WEB_MANUAL",
        targetStatus,
        grnId,
        session.companyId,
      ]
    )

    const existingLines = await db.query("SELECT id FROM grn_line_items WHERE grn_header_id = $1", [grnId])
    const existingLineIds = existingLines.rows.map((row: { id: number }) => Number(row.id))
    if (existingLineIds.length) {
      await db.query("DELETE FROM stock_serial_numbers WHERE grn_line_item_id = ANY($1::int[])", [existingLineIds])
      await db.query("DELETE FROM grn_line_items WHERE grn_header_id = $1", [grnId])
    }

    for (let i = 0; i < lineItems.length; i++) {
      const line = lineItems[i]
      const itemRes = await db.query("SELECT uom FROM items WHERE id = $1 AND company_id = $2", [
        line.item_id,
        session.companyId,
      ])
      if (!itemRes.rows.length) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", `Item not found for ID ${line.item_id}`, 400)
      }

      let zoneLayoutId: number | null = null
      let binLocation: string | null = null
      if (line.zone_layout_id) {
        const layoutRes = await db.query(
          `SELECT id, warehouse_id, zone_code, rack_code, bin_code
           FROM warehouse_zone_layouts
           WHERE id = $1 AND company_id = $2 AND is_active = true`,
          [line.zone_layout_id, session.companyId]
        )
        if (!layoutRes.rows.length) {
          await db.query("ROLLBACK")
          return fail("VALIDATION_ERROR", `Zone layout not found for ID ${line.zone_layout_id}`, 400)
        }
        const layout = layoutRes.rows[0]
        if (Number(layout.warehouse_id) !== Number(header.warehouse_id)) {
          await db.query("ROLLBACK")
          return fail("VALIDATION_ERROR", "Selected zone layout does not belong to the selected warehouse", 400)
        }
        zoneLayoutId = Number(layout.id)
        binLocation = `${layout.zone_code}/${layout.rack_code}/${layout.bin_code}`
      }

      const lineRes = await db.query(
        `INSERT INTO grn_line_items (
          company_id, grn_header_id, line_number, item_id, quantity, uom, mrp, zone_layout_id, serial_numbers_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING id`,
        [
          session.companyId,
          grnId,
          i + 1,
          line.item_id,
          line.quantity,
          itemRes.rows[0].uom,
          line.rate || 0,
          zoneLayoutId,
          JSON.stringify(line.serial_numbers || []),
        ]
      )

      if (targetStatus === "CONFIRMED") {
        const grnLineId = lineRes.rows[0].id
        for (const serialNumber of line.serial_numbers) {
          await db.query(
            `INSERT INTO stock_serial_numbers (
              company_id, serial_number, item_id, client_id, warehouse_id,
              status, received_date, grn_line_item_id, zone_layout_id, bin_location
            ) VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6, $7, $8)`,
            [
              session.companyId,
              serialNumber,
              line.item_id,
              header.client_id,
              header.warehouse_id,
              grnLineId,
              zoneLayoutId,
              binLocation,
            ]
          )
        }
      }
    }

    await db.query("COMMIT")
    return ok({ id: Number(grnId), status: targetStatus }, targetStatus === "DRAFT" ? "Draft updated" : "GRN confirmed")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to update GRN"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function DELETE(_: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }
    requirePermission(session, "grn.manage")

    const { id: grnId } = await context.params

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const headerRes = await db.query(
      `SELECT id, grn_number, status
       FROM grn_header
       WHERE id = $1
         AND company_id = $2
       FOR UPDATE`,
      [grnId, session.companyId]
    )
    if (!headerRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "GRN not found", 404)
    }

    const header = headerRes.rows[0] as { status: string; grn_number: string }
    const currentStatus = String(header.status || "").toUpperCase()

    if (currentStatus === "CANCELLED") {
      await db.query("ROLLBACK")
      return ok(
        {
          id: Number(grnId),
          status: "CANCELLED",
          reversed_stock_count: 0,
          voided_billing_tx_count: 0,
        },
        "GRN is already cancelled"
      )
    }

    if (!["DRAFT", "CONFIRMED", "COMPLETED"].includes(currentStatus)) {
      await db.query("ROLLBACK")
      return fail("INVALID_STATUS", `GRN in status ${currentStatus} cannot be cancelled`, 409)
    }

    const billedRes = await db.query(
      `SELECT DISTINCT
         ih.id AS invoice_id,
         ih.invoice_number
       FROM billing_transactions bt
       LEFT JOIN invoice_header ih
         ON ih.id = bt.invoice_id
        AND ih.company_id = bt.company_id
       WHERE bt.company_id = $1
         AND bt.source_type = 'GRN'
         AND bt.source_doc_id = $2
         AND bt.status = 'BILLED'
       ORDER BY ih.id DESC`,
      [session.companyId, grnId]
    )
    if (billedRes.rows.length > 0) {
      const invoiceNumbers = billedRes.rows
        .map((row: { invoice_id: number | null; invoice_number: string | null }) =>
          String(row.invoice_number || row.invoice_id)
        )
        .filter(Boolean)
      await db.query("ROLLBACK")
      return fail(
        "GRN_BILLED",
        `GRN ${header.grn_number} is already billed in invoice(s): ${invoiceNumbers.join(", ")}. Reverse the invoice first (credit note/unbill), then retry GRN cancellation.`,
        409
      )
    }

    const lineRes = await db.query(
      `SELECT id
       FROM grn_line_items
       WHERE company_id = $1
         AND grn_header_id = $2
       FOR UPDATE`,
      [session.companyId, grnId]
    )
    const lineIds = lineRes.rows.map((row: { id: number }) => Number(row.id)).filter(Boolean)

    let reversedStockCount = 0
    if (lineIds.length > 0) {
      const blockedStock = await db.query(
        `SELECT id, serial_number, status, do_line_item_id
         FROM stock_serial_numbers
         WHERE company_id = $1
           AND grn_line_item_id = ANY($2::int[])
           AND (
             do_line_item_id IS NOT NULL
             OR status IN ('RESERVED', 'DISPATCHED')
           )
         ORDER BY id
         LIMIT 5`,
        [session.companyId, lineIds]
      )

      if (blockedStock.rows.length > 0) {
        const preview = blockedStock.rows
          .map((row: { serial_number: string; status: string }) => `${row.serial_number}(${row.status})`)
          .join(", ")
        await db.query("ROLLBACK")
        return fail(
          "GRN_STOCK_IN_USE",
          `Cannot cancel GRN because received stock is already allocated/dispatched: ${preview}. Reverse related DO activity first.`,
          409
        )
      }

      const deleteStockRes = await db.query(
        `DELETE FROM stock_serial_numbers
         WHERE company_id = $1
           AND grn_line_item_id = ANY($2::int[])`,
        [session.companyId, lineIds]
      )
      reversedStockCount = deleteStockRes.rowCount || 0
    }

    const voidBillingRes = await db.query(
      `UPDATE billing_transactions
       SET status = 'VOID',
           invoice_id = NULL,
           billed_at = NULL,
           billed_by = NULL,
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND source_type = 'GRN'
         AND source_doc_id = $3
         AND status IN ('UNRATED', 'UNBILLED')
       RETURNING id`,
      [session.userId ?? null, session.companyId, grnId]
    )
    const voidedBillingCount = voidBillingRes.rowCount || 0

    await db.query(
      `UPDATE grn_header
       SET status = 'CANCELLED',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND company_id = $2`,
      [grnId, session.companyId]
    )

    await db.query("COMMIT")
    return ok(
      {
        id: Number(grnId),
        status: "CANCELLED",
        reversed_stock_count: reversedStockCount,
        voided_billing_tx_count: voidedBillingCount,
      },
      "GRN cancelled and reversed successfully"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to cancel GRN"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}

