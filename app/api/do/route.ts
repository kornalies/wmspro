import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { doHeaderSchema, doLineItemSchema } from "@/lib/validations"
import { fail, ok, paginated } from "@/lib/api-response"
import { getDOStatusErrorMessage, normalizeDOStatus } from "@/lib/do-status"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireScope } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "do.manage")

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get("page") || "1", 10)
    const limit = parseInt(searchParams.get("limit") || "20", 10)
    const statusFilter = searchParams.get("status")
    const search = searchParams.get("search")
    const warehouseParam = searchParams.get("warehouse_id")
    const clientParam = searchParams.get("client_id")
    const dateFrom = searchParams.get("date_from")
    const dateTo = searchParams.get("date_to")
    const requestedWarehouseId =
      warehouseParam && warehouseParam !== "all" ? Number(warehouseParam) : 0
    const requestedClientId =
      clientParam && clientParam !== "all" ? Number(clientParam) : 0
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    const offset = (page - 1) * limit

    const where: string[] = ["dh.company_id = $1"]
    const params: Array<string | number | number[]> = [session.companyId]
    let idx = 2
    if (requestedWarehouseId) {
      requireScope(policy, "warehouse", requestedWarehouseId)
      where.push(`dh.warehouse_id = $${idx++}`)
      params.push(requestedWarehouseId)
    } else {
      const allowedWarehouseIds = Array.from(
        new Set(
          policy.scopes.warehouseIds
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      )
      if (allowedWarehouseIds.length > 0) {
        where.push(`dh.warehouse_id = ANY($${idx++}::int[])`)
        params.push(allowedWarehouseIds)
      }
    }

    if (statusFilter) {
      const normalizedStatus = normalizeDOStatus(statusFilter)
      if (!normalizedStatus) {
        return fail("VALIDATION_ERROR", getDOStatusErrorMessage(statusFilter), 400)
      }
      where.push(`dh.status = $${idx++}`)
      params.push(normalizedStatus)
    }
    if (requestedClientId) {
      requireScope(policy, "client", requestedClientId)
      where.push(`dh.client_id = $${idx++}`)
      params.push(requestedClientId)
    }
    if (dateFrom) {
      where.push(`dh.request_date >= $${idx++}::date`)
      params.push(dateFrom)
    }
    if (dateTo) {
      where.push(`dh.request_date <= $${idx++}::date`)
      params.push(dateTo)
    }
    if (search) {
      where.push(`(dh.do_number ILIKE $${idx} OR c.client_name ILIKE $${idx} OR dh.invoice_no ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const countResult = await query(
      `SELECT COUNT(*) FROM do_header dh
       JOIN clients c ON c.id = dh.client_id AND c.company_id = dh.company_id
       ${whereClause}`,
      params
    )
    const total = parseInt(countResult.rows[0].count, 10)

    const result = await query(
      `SELECT
        dh.id,
        dh.do_number,
        dh.request_date,
        dh.created_at,
        dh.dispatch_date,
        dh.status,
        dh.supplier_name,
        dh.invoice_no,
        dh.invoice_date,
        dh.model_no,
        dh.serial_no,
        dh.material_description,
        dh.date_of_manufacturing,
        dh.basic_price,
        dh.invoice_qty,
        dh.dispatched_qty,
        dh.quantity_difference,
        dh.no_of_cases,
        dh.no_of_pallets,
        dh.weight_kg,
        dh.handling_type,
        dh.machine_type,
        dh.machine_from_time,
        dh.machine_to_time,
        dh.outward_remarks,
        dh.total_items,
        dh.total_quantity_requested,
        dh.total_quantity_dispatched,
        c.client_name,
        w.warehouse_name,
        u.full_name AS created_by_name
      FROM do_header dh
      JOIN clients c ON c.id = dh.client_id AND c.company_id = dh.company_id
      JOIN warehouses w ON w.id = dh.warehouse_id AND w.company_id = dh.company_id
      LEFT JOIN users u ON u.id = dh.created_by AND u.company_id = dh.company_id
      ${whereClause}
      ORDER BY dh.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const normalizedRows = result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      status: normalizeDOStatus(row.status) || row.status,
    }))

    return paginated(normalizedRows, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch DOs"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const dbClient = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "do.manage")

    const body = await request.json()
    const header = doHeaderSchema.parse(body.header)
    const lineItems = (body.lineItems || []).map((line: unknown) => doLineItemSchema.parse(line))
    const itemFrequency = new Map<number, number>()
    for (const line of lineItems as Array<{ item_id: number }>) {
      itemFrequency.set(line.item_id, (itemFrequency.get(line.item_id) || 0) + 1)
    }
    const duplicateItemIds = Array.from(itemFrequency)
      .filter(([, count]) => count > 1)
      .map(([itemId]) => itemId)

    if (duplicateItemIds.length > 0) {
      throw new Error(`Duplicate item lines are not allowed in one DO: ${duplicateItemIds.join(", ")}`)
    }

    await dbClient.query("BEGIN")
    await setTenantContext(dbClient, session.companyId)

    const year = new Date().getFullYear()
    const seq = await dbClient.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(do_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
       FROM do_header
       WHERE company_id = $1
         AND do_number LIKE 'DO-%-${year}-%'`,
      [session.companyId]
    )
    const warehouse = await dbClient.query("SELECT warehouse_code FROM warehouses WHERE id = $1 AND company_id = $2", [
      header.warehouse_id,
      session.companyId,
    ])
    const doNumber = `DO-${warehouse.rows[0].warehouse_code}-${year}-${String(seq.rows[0].next_seq).padStart(5, "0")}`

    const doHeader = await dbClient.query(
      `INSERT INTO do_header (
        company_id, do_number, request_date, client_id, warehouse_id, requested_by, remarks,
        dispatch_date, supplier_name, invoice_no, invoice_date, model_no, serial_no,
        material_description, date_of_manufacturing, basic_price, invoice_qty, dispatched_qty,
        quantity_difference, no_of_cases, no_of_pallets, weight_kg, handling_type,
        machine_type, machine_from_time, machine_to_time, outward_remarks,
        total_items, total_quantity_requested, total_quantity_dispatched, status, created_by
      ) VALUES (
        $1, $2, CURRENT_DATE, $3, $4, $5, $6,
        $7::date, $8, $9, $10::date, $11, $12,
        $13, $14::date, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24::timestamp, $25::timestamp, $26,
        $27, $28, 0, 'DRAFT', $29
      )
      RETURNING *`,
      [
        session.companyId,
        doNumber,
        header.client_id,
        header.warehouse_id,
        header.customer_name,
        [header.delivery_address, header.customer_phone].filter(Boolean).join(" | ") || null,
        header.dispatch_date || null,
        header.supplier_name || null,
        header.invoice_no || null,
        header.invoice_date || null,
        header.model_no || null,
        header.serial_no || null,
        header.material_description || null,
        header.date_of_manufacturing || null,
        header.basic_price ?? null,
        header.invoice_qty ?? null,
        header.dispatched_qty ?? null,
        header.quantity_difference ?? null,
        header.no_of_cases ?? null,
        header.no_of_pallets ?? null,
        header.weight_kg ?? null,
        header.handling_type || null,
        header.machine_type || null,
        header.machine_from_time || null,
        header.machine_to_time || null,
        header.outward_remarks || null,
        header.total_items,
        header.total_quantity_requested,
        session.userId,
      ]
    )

    const doId = Number(doHeader.rows[0].id)
    let totalReserved = 0

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i]
      const itemResult = await dbClient.query("SELECT uom FROM items WHERE id = $1 AND company_id = $2", [
        item.item_id,
        session.companyId,
      ])
      if (itemResult.rows.length === 0) {
        throw new Error(`Item not found for ID ${item.item_id}`)
      }

      const insertedLine = await dbClient.query(
        `INSERT INTO do_line_items (
          company_id, do_header_id, line_number, item_id, quantity_requested, quantity_dispatched, uom
        ) VALUES ($1, $2, $3, $4, $5, 0, $6)
        RETURNING id`,
        [session.companyId, doId, i + 1, item.item_id, item.quantity_requested, itemResult.rows[0].uom]
      )
      const lineId = Number(insertedLine.rows[0].id)

      const reserveRows = await dbClient.query(
        `SELECT id
         FROM stock_serial_numbers
         WHERE company_id = $1
           AND warehouse_id = $2
           AND client_id = $3
           AND item_id = $4
           AND status = 'IN_STOCK'
           AND do_line_item_id IS NULL
         ORDER BY received_date ASC, id ASC
         LIMIT $5
         FOR UPDATE SKIP LOCKED`,
        [session.companyId, header.warehouse_id, header.client_id, item.item_id, item.quantity_requested]
      )

      const stockIds = reserveRows.rows.map((row: { id: number }) => Number(row.id)).filter(Boolean)
      const reservedQty = stockIds.length
      totalReserved += reservedQty
      if (reservedQty < Number(item.quantity_requested)) {
        await dbClient.query("ROLLBACK")
        return fail(
          "INSUFFICIENT_STOCK",
          `Insufficient stock for item ${item.item_id}. Requested ${item.quantity_requested}, available ${reservedQty}.`,
          409,
          {
            item_id: item.item_id,
            requested_qty: Number(item.quantity_requested),
            available_qty: reservedQty,
          }
        )
      }

      if (stockIds.length > 0) {
        await dbClient.query(
          `UPDATE stock_serial_numbers
           SET status = 'RESERVED',
               do_line_item_id = $1
           WHERE company_id = $2
             AND id = ANY($3::int[])`,
          [lineId, session.companyId, stockIds]
        )
      }
    }

    await dbClient.query("COMMIT")
    return ok(
      {
        ...doHeader.rows[0],
        allocation: {
          reserved_quantity: totalReserved,
          requested_quantity: Number(header.total_quantity_requested || 0),
          is_fully_allocated: true,
        },
      },
      "Delivery Order created successfully"
    )
  } catch (error: unknown) {
    await dbClient.query("ROLLBACK")
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to create DO"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    dbClient.release()
  }
}

