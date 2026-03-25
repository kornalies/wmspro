type DBClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type CreateGrnHeaderPayload = {
  client_id: number
  warehouse_id: number
  invoice_number: string
  invoice_date: string
  supplier_name?: string
  supplier_gst?: string
  total_items: number
  total_quantity: number
  total_value?: number
  gate_in_number?: string
  model_number?: string
  material_description?: string
  receipt_date?: string
  manufacturing_date?: string
  basic_price?: number
  invoice_quantity?: number
  received_quantity?: number
  quantity_difference?: number
  damage_quantity?: number
  case_count?: number
  pallet_count?: number
  weight_kg?: number
  handling_type?: string
  source_channel?: string
  status?: "DRAFT" | "CONFIRMED"
}

export type CreateGrnLinePayload = {
  item_id: number
  quantity: number
  serial_numbers: string[]
  rate?: number
  zone_layout_id?: number
}

export async function createGrnWithLineItems(
  db: DBClient,
  payload: {
    header: CreateGrnHeaderPayload
    lineItems: CreateGrnLinePayload[]
    createdBy: number
  }
) {
  const { header, lineItems, createdBy } = payload
  const normalizedStatus = header.status || "CONFIRMED"
  const computedLineTotalQty = lineItems.reduce((sum, line) => sum + Number(line.quantity || 0), 0)

  if (normalizedStatus === "CONFIRMED") {
    if (header.total_items !== lineItems.length) {
      throw new Error(
        `Line item count mismatch: header total_items=${header.total_items}, actual=${lineItems.length}`
      )
    }

    if (header.total_quantity !== computedLineTotalQty) {
      throw new Error(
        `Total quantity mismatch: header total_quantity=${header.total_quantity}, actual=${computedLineTotalQty}`
      )
    }

    if (
      typeof header.received_quantity === "number" &&
      header.received_quantity !== computedLineTotalQty
    ) {
      const diff = header.received_quantity - computedLineTotalQty
      const discrepancy = diff > 0 ? "missing" : "excess"
      throw new Error(
        `Received quantity mismatch: received_qty=${header.received_quantity}, line_total=${computedLineTotalQty} (${Math.abs(
          diff
        )} ${discrepancy})`
      )
    }
  }

  const year = new Date().getFullYear()

  const seqResult = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(grn_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 as next_seq
     FROM grn_header
     WHERE grn_number LIKE 'GRN-%-${year}-%'`
  )

  const nextSeq = seqResult.rows[0].next_seq
  const warehouseCode = await db.query(
    "SELECT warehouse_code FROM warehouses WHERE id = $1",
    [header.warehouse_id]
  )

  if (!warehouseCode.rows.length) {
    throw new Error(`Warehouse not found for ID ${header.warehouse_id}`)
  }

  const grnNumber = `GRN-${warehouseCode.rows[0].warehouse_code}-${year}-${String(nextSeq).padStart(5, "0")}`

  const computedDifference =
    typeof header.invoice_quantity === "number" && typeof header.received_quantity === "number"
      ? header.invoice_quantity - header.received_quantity
      : header.quantity_difference ?? null

  const headerResult = await db.query(
    `INSERT INTO grn_header (
      grn_number, grn_date, client_id, warehouse_id, 
      invoice_number, invoice_date, supplier_name, supplier_gst,
      total_items, total_quantity, total_value, status, created_by,
      gate_in_number, model_number, material_description, receipt_date, manufacturing_date,
      basic_price, invoice_quantity, received_quantity, quantity_difference,
      damage_quantity, case_count, pallet_count, weight_kg, handling_type, source_channel
    ) VALUES (
      $1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
    )
    RETURNING *`,
    [
      grnNumber,
      header.client_id,
      header.warehouse_id,
      header.invoice_number,
      header.invoice_date,
      header.supplier_name || null,
      header.supplier_gst || null,
      header.total_items,
      header.total_quantity,
      header.total_value || 0,
      normalizedStatus,
      createdBy,
      header.gate_in_number || null,
      header.model_number || null,
      header.material_description || null,
      header.receipt_date || null,
      header.manufacturing_date || null,
      header.basic_price ?? null,
      header.invoice_quantity ?? null,
      header.received_quantity ?? null,
      computedDifference,
      header.damage_quantity ?? null,
      header.case_count ?? null,
      header.pallet_count ?? null,
      header.weight_kg ?? null,
      header.handling_type || null,
      header.source_channel || "WEB_MANUAL",
    ]
  )

  const grnId = headerResult.rows[0].id

  for (let i = 0; i < lineItems.length; i++) {
    const lineItem = lineItems[i]
    if (normalizedStatus === "CONFIRMED" && lineItem.serial_numbers.length !== lineItem.quantity) {
      throw new Error(
        `Serial mismatch for item ${lineItem.item_id}: quantity=${lineItem.quantity}, serials=${lineItem.serial_numbers.length}`
      )
    }

    const itemResult = await db.query("SELECT uom FROM items WHERE id = $1", [lineItem.item_id])
    if (itemResult.rows.length === 0) {
      throw new Error(`Item not found for ID ${lineItem.item_id}`)
    }

    const lineResult = await db.query(
      `INSERT INTO grn_line_items (
        grn_header_id, line_number, item_id, quantity, uom, mrp, zone_layout_id, serial_numbers_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id`,
      [
        grnId,
        i + 1,
        lineItem.item_id,
        lineItem.quantity,
        itemResult.rows[0].uom,
        lineItem.rate || 0,
        lineItem.zone_layout_id || null,
        JSON.stringify(lineItem.serial_numbers || []),
      ]
    )

    const lineItemId = lineResult.rows[0].id
    let zoneLayoutId: number | null = null
    let binLocation: string | null = null

    if (lineItem.zone_layout_id) {
      const zoneLayout = await db.query(
        `SELECT id, warehouse_id, zone_code, rack_code, bin_code
         FROM warehouse_zone_layouts
         WHERE id = $1 AND is_active = true`,
        [lineItem.zone_layout_id]
      )

      if (!zoneLayout.rows.length) {
        throw new Error(`Zone layout not found for ID ${lineItem.zone_layout_id}`)
      }

      const resolved = zoneLayout.rows[0]
      if (Number(resolved.warehouse_id) !== Number(header.warehouse_id)) {
        throw new Error("Selected zone layout does not belong to the selected warehouse")
      }

      zoneLayoutId = Number(resolved.id)
      binLocation = `${resolved.zone_code}/${resolved.rack_code}/${resolved.bin_code}`
    }

    if (normalizedStatus === "CONFIRMED") {
      for (const serialNumber of lineItem.serial_numbers) {
        await db.query(
          `INSERT INTO stock_serial_numbers (
            serial_number, item_id, client_id, warehouse_id,
            status, received_date, grn_line_item_id, zone_layout_id, bin_location
          ) VALUES ($1, $2, $3, $4, 'IN_STOCK', CURRENT_DATE, $5, $6, $7)`,
          [
            serialNumber,
            lineItem.item_id,
            header.client_id,
            header.warehouse_id,
            lineItemId,
            zoneLayoutId,
            binLocation,
          ]
        )
      }
    }
  }

  return headerResult.rows[0]
}
