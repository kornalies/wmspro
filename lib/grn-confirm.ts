import { stageChargeTransaction } from "@/lib/billing-service"

type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

type DraftLineRow = {
  id: number
  item_id: number
  quantity: number
  zone_layout_id: number | null
  serial_numbers_json: string[]
}

/**
 * Carries a stable error code + HTTP status so both the web confirm route and the
 * mobile approval route can preserve their existing API error contracts (NOT_FOUND,
 * INVALID_STATUS, VALIDATION_ERROR) instead of collapsing everything to a generic 400.
 */
export class GrnConfirmError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = "GrnConfirmError"
    this.code = code
    this.status = status
  }
}

function toDateOnly(value: unknown) {
  if (!value) return new Date().toISOString().slice(0, 10)
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10)
  }
  return parsed.toISOString().slice(0, 10)
}

/**
 * Confirms a DRAFT GRN: materialises LP-linked stock serials and stages the
 * INBOUND_HANDLING client charge, then flips the header to CONFIRMED.
 *
 * This is the single source of truth for GRN confirmation side-effects, shared by
 * the web confirm route and the mobile approval route so both channels get identical
 * billing AND identical LP traceability (previously the mobile path wrote serials with
 * no lp_record_id and never staged a charge at all).
 *
 * The caller is responsible for the surrounding transaction: it must have already run
 * BEGIN and setTenantContext, and must COMMIT on success / ROLLBACK on throw. Validation
 * failures throw GrnConfirmError; the caller maps code/status to its API response.
 */
export async function confirmGrnInTransaction(
  db: DBClient,
  args: { companyId: number; userId?: number; grnId: number }
): Promise<{ id: number; status: "CONFIRMED"; totalQty: number }> {
  const { companyId, userId, grnId } = args

  const headerRes = await db.query(
    `SELECT *
     FROM grn_header
     WHERE id = $1
       AND company_id = $2
     FOR UPDATE`,
    [grnId, companyId]
  )
  if (!headerRes.rows.length) {
    throw new GrnConfirmError("NOT_FOUND", "GRN not found", 404)
  }

  const header = headerRes.rows[0]
  if (header.status !== "DRAFT") {
    throw new GrnConfirmError("INVALID_STATUS", "Only draft GRN can be confirmed", 400)
  }

  const linesRes = await db.query(
    `SELECT id, item_id, quantity, zone_layout_id, COALESCE(serial_numbers_json, '[]'::jsonb) AS serial_numbers_json
     FROM grn_line_items
     WHERE grn_header_id = $1
       AND company_id = $2
     ORDER BY line_number ASC, id ASC`,
    [grnId, companyId]
  )
  const lines = linesRes.rows as unknown as DraftLineRow[]
  if (!lines.length) {
    throw new GrnConfirmError("VALIDATION_ERROR", "Draft has no line items", 400)
  }

  const totalQty = lines.reduce((sum: number, row: DraftLineRow) => sum + Number(row.quantity || 0), 0)
  if (Number(header.total_quantity || 0) !== totalQty) {
    throw new GrnConfirmError(
      "VALIDATION_ERROR",
      "Header total quantity does not match line item total",
      400
    )
  }
  if (header.received_quantity !== null && Number(header.received_quantity) !== totalQty) {
    throw new GrnConfirmError(
      "VALIDATION_ERROR",
      "Received quantity must match line item total",
      400
    )
  }

  for (const line of lines) {
    let serialNumbers = Array.isArray(line.serial_numbers_json) ? line.serial_numbers_json : []

    // Resolve the mobile LP(s) (dock pallet receipts) this line's stock came from, matched by
    // gate_in + client + item. We need these in BOTH receiving styles, because the LP->stock link
    // must survive regardless of how the serials were captured:
    //   - Mobile LP receipt: the line has no serials, so we synthesise one per unit ("<lp_code>-<n>").
    //   - Web desk confirm: the line already carries the REAL Mfg serials a clerk typed in.
    // Web GRNs with no gate_in (no LP stage) simply resolve to no LP rows and are unaffected.
    let lpRows: Array<{
      id: string
      lp_code: string
      quantity: number
      batch_lot: string | null
      expiry_date: string | null
    }> = []
    if (Number(line.quantity || 0) > 0 && header.gate_in_id) {
      const lpRes = await db.query(
        // batch_lot/expiry_date come along because the pallet is the only place they
        // were ever captured -- the scanner types them at LP create, grn_line_items has
        // no column for them, and a serial that does not inherit them is invisible to
        // Lot Master, recall, expiry and FEFO.
        //
        // expiry_date is timestamptz on the mobile table and date on the serial. It is
        // narrowed to ::date::text here so the calendar day never passes through a JS
        // Date: node-postgres hands a date back as local midnight, and re-serialising
        // that as UTC silently moves the expiry a day earlier east of Greenwich.
        `SELECT lp.id, lp.lp_code, lp.quantity,
                NULLIF(TRIM(lp.batch_lot), '') AS batch_lot,
                lp.expiry_date::date::text AS expiry_date
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
      lpRows = lpRes.rows.map((lp: Record<string, unknown>) => ({
        id: String(lp.id),
        lp_code: String(lp.lp_code),
        quantity: Math.max(0, Number(lp.quantity || 0)),
        batch_lot: lp.batch_lot === null || lp.batch_lot === undefined ? null : String(lp.batch_lot),
        expiry_date:
          lp.expiry_date === null || lp.expiry_date === undefined ? null : String(lp.expiry_date),
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
      throw new GrnConfirmError(
        "VALIDATION_ERROR",
        "Serial count must match line item quantity for all items",
        400
      )
    }

    // Stamp each serial with the LP it belongs to, by walking the pallets in receipt order and
    // consuming their quantities. Synthetic serials were built in exactly this order; real
    // desk-entered serials are assigned to pallets positionally (the best linkage available
    // without per-unit LP scanning at the desk). Serials beyond the LPs' combined quantity
    // (e.g. a pure web GRN) stay unlinked (null).
    // The whole LP row travels rather than just its id: the serial inherits the
    // pallet's batch and expiry as well as its identity, and those must come from the
    // SAME pallet the walk assigned -- pulling them from anywhere else would attach one
    // pallet's batch to another pallet's units, which is worse than no batch at all.
    const lpBySerialIndex: Array<(typeof lpRows)[number] | null> = new Array(
      serialNumbers.length
    ).fill(null)
    let lpCursor = 0
    for (const lp of lpRows) {
      for (let n = 0; n < lp.quantity && lpCursor < lpBySerialIndex.length; n++) {
        lpBySerialIndex[lpCursor++] = lp
      }
    }

    let zoneLayoutId: number | null = null
    let binLocation: string | null = null
    if (line.zone_layout_id) {
      const layoutRes = await db.query(
        `SELECT id, warehouse_id, zone_code, rack_code, bin_code
         FROM warehouse_zone_layouts
         WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [line.zone_layout_id, companyId]
      )
      if (!layoutRes.rows.length) {
        throw new GrnConfirmError("VALIDATION_ERROR", `Zone layout not found for line ${line.id}`, 400)
      }
      const layout = layoutRes.rows[0]
      if (Number(layout.warehouse_id) !== Number(header.warehouse_id)) {
        throw new GrnConfirmError(
          "VALIDATION_ERROR",
          "Draft line has zone layout from different warehouse",
          400
        )
      }
      zoneLayoutId = Number(layout.id)
      binLocation = `${layout.zone_code}/${layout.rack_code}/${layout.bin_code}`
    }

    for (let s = 0; s < serialNumbers.length; s++) {
      const lp = lpBySerialIndex[s]
      await db.query(
        `INSERT INTO stock_serial_numbers (
          company_id, serial_number, item_id, client_id, warehouse_id,
          status, received_date, grn_line_item_id, zone_layout_id, bin_location, lp_record_id,
          batch_number, expiry_date
        ) VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6, $7, $8, $9, $10, $11::date)
        ON CONFLICT (serial_number, item_id, client_id) DO NOTHING`,
        [
          companyId,
          String(serialNumbers[s]),
          Number(line.item_id),
          Number(header.client_id),
          Number(header.warehouse_id),
          Number(line.id),
          zoneLayoutId,
          binLocation,
          lp?.id ?? null,
          lp?.batch_lot ?? null,
          lp?.expiry_date ?? null,
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
    [grnId, companyId]
  )

  const eventDate = toDateOnly(header.grn_date)
  await stageChargeTransaction(db, {
    companyId,
    userId,
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

  return { id: grnId, status: "CONFIRMED", totalQty }
}
