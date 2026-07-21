import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureGrnManualSchema, ensureStockPutawaySchema } from "@/lib/db-bootstrap"
import { stageChargeTransaction } from "@/lib/billing-service"

type RouteContext = {
  params: Promise<{ id: string }>
}

type DraftLineRow = {
  id: number
  item_id: number
  quantity: number
  zone_layout_id: number | null
  serial_numbers_json: string[]
}

function toDateOnly(value: unknown) {
  if (!value) return new Date().toISOString().slice(0, 10)
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10)
  }
  return parsed.toISOString().slice(0, 10)
}

export async function POST(_: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    await ensureGrnManualSchema(db)
    await ensureStockPutawaySchema(db)

    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.manage")

    const { id } = await context.params
    const grnId = Number(id)
    if (!grnId) return fail("VALIDATION_ERROR", "Invalid GRN id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const headerRes = await db.query(
      `SELECT *
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

    const header = headerRes.rows[0]
    if (header.status !== "DRAFT") {
      await db.query("ROLLBACK")
      return fail("INVALID_STATUS", "Only draft GRN can be confirmed", 400)
    }

    const linesRes = await db.query(
      `SELECT id, item_id, quantity, zone_layout_id, COALESCE(serial_numbers_json, '[]'::jsonb) AS serial_numbers_json
       FROM grn_line_items
       WHERE grn_header_id = $1
         AND company_id = $2
       ORDER BY line_number ASC, id ASC`,
      [grnId, session.companyId]
    )
    const lines = linesRes.rows as DraftLineRow[]
    if (!lines.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Draft has no line items", 400)
    }

    const totalQty = lines.reduce((sum: number, row: DraftLineRow) => sum + Number(row.quantity || 0), 0)
    if (Number(header.total_quantity || 0) !== totalQty) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Header total quantity does not match line item total", 400)
    }
    if (header.received_quantity !== null && Number(header.received_quantity) !== totalQty) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Received quantity must match line item total", 400)
    }

    for (const line of lines) {
      let serialNumbers = Array.isArray(line.serial_numbers_json) ? line.serial_numbers_json : []

      // Resolve the mobile LP(s) (dock pallet receipts) this line's stock came from, matched by
      // gate_in + client + item. We need these in BOTH receiving styles, because the LP->stock link
      // must survive regardless of how the serials were captured:
      //   - Mobile LP receipt: the line has no serials, so we synthesise one per unit ("<lp_code>-<n>").
      //   - Web desk confirm: the line already carries the REAL Mfg serials a clerk typed in.
      // Web GRNs with no gate_in (no LP stage) simply resolve to no LP rows and are unaffected.
      let lpRows: Array<{ id: string; lp_code: string; quantity: number }> = []
      if (Number(line.quantity || 0) > 0 && header.gate_in_id) {
        const lpRes = await db.query(
          `SELECT lp.id, lp.lp_code, lp.quantity
           FROM public.mobile_lp_records lp
           WHERE lp.gate_in_id = $1
             AND lp.client_id = $2
             AND EXISTS (
               SELECT 1 FROM items i
               WHERE i.id = $3
                 AND (UPPER(i.item_code) = UPPER(lp.sku) OR UPPER(i.item_name) LIKE UPPER('%' || lp.sku || '%'))
             )
           ORDER BY lp.created_at ASC`,
          [String(header.gate_in_id), String(header.client_id), Number(line.item_id)]
        )
        lpRows = lpRes.rows.map((lp: { id: unknown; lp_code: unknown; quantity: unknown }) => ({
          id: String(lp.id),
          lp_code: String(lp.lp_code),
          quantity: Math.max(0, Number(lp.quantity || 0)),
        }))
      }

      // Mobile LP receipt with no per-unit serials: materialise one synthetic serial per received
      // unit so the stock is approvable and put away later can move it.
      if (serialNumbers.length === 0 && Number(line.quantity || 0) > 0 && lpRows.length) {
        const derived: string[] = []
        for (const lp of lpRows) {
          for (let n = 1; n <= lp.quantity; n++) derived.push(`${lp.lp_code}-${n}`)
        }
        serialNumbers = derived
      }

      if (serialNumbers.length !== Number(line.quantity || 0)) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", "Serial count must match line item quantity for all items", 400)
      }

      // Stamp each serial with the LP it belongs to, by walking the pallets in receipt order and
      // consuming their quantities. Synthetic serials were built in exactly this order; real
      // desk-entered serials are assigned to pallets positionally (the best linkage available
      // without per-unit LP scanning at the desk). Serials beyond the LPs' combined quantity
      // (e.g. a pure web GRN) stay unlinked (null).
      const lpIdBySerialIndex: Array<string | null> = new Array(serialNumbers.length).fill(null)
      let lpCursor = 0
      for (const lp of lpRows) {
        for (let n = 0; n < lp.quantity && lpCursor < lpIdBySerialIndex.length; n++) {
          lpIdBySerialIndex[lpCursor++] = lp.id
        }
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
          return fail("VALIDATION_ERROR", `Zone layout not found for line ${line.id}`, 400)
        }
        const layout = layoutRes.rows[0]
        if (Number(layout.warehouse_id) !== Number(header.warehouse_id)) {
          await db.query("ROLLBACK")
          return fail("VALIDATION_ERROR", "Draft line has zone layout from different warehouse", 400)
        }
        zoneLayoutId = Number(layout.id)
        binLocation = `${layout.zone_code}/${layout.rack_code}/${layout.bin_code}`
      }

      for (let s = 0; s < serialNumbers.length; s++) {
        await db.query(
          `INSERT INTO stock_serial_numbers (
            company_id, serial_number, item_id, client_id, warehouse_id,
            status, received_date, grn_line_item_id, zone_layout_id, bin_location, lp_record_id
          ) VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6, $7, $8, $9)
          ON CONFLICT (serial_number, item_id, client_id) DO NOTHING`,
          [
            session.companyId,
            String(serialNumbers[s]),
            Number(line.item_id),
            Number(header.client_id),
            Number(header.warehouse_id),
            Number(line.id),
            zoneLayoutId,
            binLocation,
            lpIdBySerialIndex[s],
          ]
        )
      }
    }

    await db.query(
      `UPDATE grn_header
       SET status = 'CONFIRMED',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND company_id = $2`,
      [grnId, session.companyId]
    )

    const eventDate = toDateOnly(header.grn_date)
    await stageChargeTransaction(db, {
      companyId: session.companyId,
      userId: session.userId,
      clientId: Number(header.client_id),
      warehouseId: Number(header.warehouse_id),
      chargeType: "INBOUND_HANDLING",
      sourceType: "GRN",
      sourceDocId: grnId,
      sourceRefNo: String(header.grn_number || grnId),
      eventDate,
      periodFrom: eventDate,
      periodTo: eventDate,
      quantity: totalQty,
      uom: "UNIT",
      remarks: "Auto staged on GRN confirmation",
    })

    await db.query("COMMIT")
    return ok({ id: grnId, status: "CONFIRMED" }, "Draft GRN confirmed successfully")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to confirm draft GRN"
    return fail("CONFIRM_FAILED", message, 400)
  } finally {
    db.release()
  }
}

