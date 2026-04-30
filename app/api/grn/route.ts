import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { query, getClient, setTenantContext } from "@/lib/db"
import { grnHeaderSchema, grnLineItemSchema } from "@/lib/validations"
import { createGrnWithLineItems } from "@/lib/grn-service"
import { ensureGrnManualSchema, ensureStockPutawaySchema } from "@/lib/db-bootstrap"
import { fail, ok, paginated } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireScope } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as JsonRecord
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function toPositiveNumber(value: unknown): number | undefined {
  const n = toNumber(value)
  if (typeof n === "number" && n > 0) return n
  return undefined
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => toStringValue(entry))
      .filter((entry): entry is string => typeof entry === "string")
  }

  const single = toStringValue(value)
  if (!single) return []
  return single
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function getRecordValueByAliases(record: JsonRecord, aliases: string[]): unknown {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record)) {
    map.set(normalizeKey(key), value)
  }
  for (const alias of aliases) {
    const found = map.get(normalizeKey(alias))
    if (found !== undefined && found !== null) return found
  }
  return undefined
}

function looksLikeLineItem(record: JsonRecord): boolean {
  const itemCandidate = getRecordValueByAliases(record, [
    "item_id",
    "itemId",
    "id",
    "product_id",
    "productId",
    "sku_id",
    "skuId",
  ])
  const qtyCandidate = getRecordValueByAliases(record, [
    "quantity",
    "qty",
    "received_qty",
    "receivedQuantity",
    "invoice_qty",
    "invoiceQuantity",
  ])
  const serialCandidate = getRecordValueByAliases(record, [
    "serial_numbers",
    "serialNumbers",
    "serial_no",
    "serialNo",
    "serial",
  ])
  return (
    toNumber(itemCandidate) !== undefined ||
    toPositiveNumber(qtyCandidate) !== undefined ||
    toStringArray(serialCandidate).length > 0
  )
}

function extractLineItemCollection(candidate: unknown): unknown[] {
  if (Array.isArray(candidate)) return candidate
  const rec = asRecord(candidate)
  if (!rec) return []
  return Object.values(rec)
}

function findLineItemsDeep(root: unknown): unknown[] {
  const visited = new Set<unknown>()
  const queue: unknown[] = [root]
  let best: unknown[] = []

  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== "object") continue
    if (visited.has(current)) continue
    visited.add(current)

    const possibleCollection = extractLineItemCollection(current)
    if (possibleCollection.length) {
      const records = possibleCollection
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => entry !== null)
      if (records.length) {
        const score = records.filter((entry) => looksLikeLineItem(entry)).length
        const bestScore = best
          .map((entry) => asRecord(entry))
          .filter((entry): entry is JsonRecord => entry !== null)
          .filter((entry) => looksLikeLineItem(entry)).length
        if (score > bestScore && score > 0) {
          best = possibleCollection
        }
      }
    }

    if (Array.isArray(current)) {
      for (const entry of current) queue.push(entry)
    } else {
      for (const value of Object.values(current as JsonRecord)) queue.push(value)
    }
  }

  return best
}

function normalizeCreateGrnPayload(body: unknown) {
  const rawBody = asRecord(body) ?? {}
  const root = asRecord(rawBody.payload) ?? rawBody

  const headerSource =
    asRecord(root.header) ??
    asRecord(root.grn_header) ??
    asRecord(root.grnHeader) ??
    root

  const lineItemsSourceRaw = firstDefined(
    root.lineItems,
    root.lineitems,
    root.lineItem,
    root.lineitem,
    root.line_items,
    root.grn_line_items,
    root.grnLineItems,
    root.grnlineitems,
    root.items,
    root.products,
    root.productsData,
    root.product_data,
    root.lines,
    root.line_data,
    root.lineData,
    headerSource.lineItems,
    headerSource.lineitems,
    headerSource.lineItem,
    headerSource.lineitem,
    headerSource.line_items,
    headerSource.items,
    headerSource.products,
    rawBody.lineItems,
    rawBody.lineitems,
    rawBody.line_items
  )
  let lineItemsSource = lineItemsSourceRaw
  if (typeof lineItemsSourceRaw === "string") {
    try {
      lineItemsSource = JSON.parse(lineItemsSourceRaw)
    } catch {
      lineItemsSource = lineItemsSourceRaw
    }
  }
  const rawLineItems = Array.isArray(lineItemsSource)
    ? lineItemsSource
    : asRecord(lineItemsSource)
      ? Object.values(lineItemsSource as JsonRecord)
      : []
  const discoveredLineItems = rawLineItems.length ? rawLineItems : findLineItemsDeep(root)
  const validLineItems = rawLineItems.filter((item) => asRecord(item) !== null)
  const validatedDiscovered = discoveredLineItems.filter((item) => asRecord(item) !== null)
  const sourceItems = validLineItems.length ? validLineItems : validatedDiscovered

  const normalizedLineItems = sourceItems.map((item) => {
    const source = asRecord(item) ?? {}
    const nestedItem = asRecord(source.item) ?? asRecord(source.product) ?? {}
    const itemId = toNumber(
      firstDefined(
        source.item_id,
        source.itemId,
        source.id,
        source.product_id,
        source.productId,
        source.sku_id,
        source.skuId,
        nestedItem.item_id,
        nestedItem.itemId,
        nestedItem.id,
        nestedItem.product_id
      )
    )
    const parsedQuantity = toPositiveNumber(
      firstDefined(
        source.quantity,
        source.qty,
        source.received_qty,
        source.invoice_qty,
        source.receivedQuantity,
        source.receivedQty,
        source.invoiceQuantity,
        source.invoiceQty
      )
    )
    const rate = toNumber(firstDefined(source.rate, source.mrp, source.basic_price, source.price, source.unit_price))
    const zoneLayoutId = toNumber(firstDefined(source.zone_layout_id, source.zoneLayoutId))
    const serialNumbers = toStringArray(
      firstDefined(
        source.serial_numbers,
        source.serialNumbers,
        source.serial_no,
        source.serialNo,
        source.serial,
        source.serial_no_list,
        source.serialList
      )
    )
    const quantity = parsedQuantity ?? (serialNumbers.length > 0 ? serialNumbers.length : undefined)

    return {
      item_id: itemId,
      quantity,
      rate,
      zone_layout_id: zoneLayoutId,
      serial_numbers: serialNumbers,
    }
  })

  if (!normalizedLineItems.length) {
    const rootSingleItem = toNumber(
      firstDefined(
        root.item_id,
        root.itemId,
        root.product_id,
        root.productId,
        headerSource.item_id,
        headerSource.itemId,
        headerSource.product_id,
        headerSource.productId
      )
    )
    const rootSerials = toStringArray(
      firstDefined(
        root.serial_numbers,
        root.serialNumbers,
        root.serial_no,
        root.serialNo,
        root.serial,
        headerSource.serial_numbers,
        headerSource.serialNumbers,
        headerSource.serial_no,
        headerSource.serialNo,
        headerSource.serial
      )
    )
    const rootQty =
      toPositiveNumber(
        firstDefined(
          root.quantity,
          root.qty,
          root.received_qty,
          root.receivedQuantity,
          headerSource.quantity,
          headerSource.qty,
          headerSource.received_qty,
          headerSource.receivedQuantity
        )
      ) ?? (rootSerials.length > 0 ? rootSerials.length : undefined)
    if (rootSingleItem && rootQty) {
      normalizedLineItems.push({
        item_id: rootSingleItem,
        quantity: rootQty,
        rate: toNumber(firstDefined(root.rate, root.mrp, headerSource.rate, headerSource.mrp)),
        zone_layout_id: toNumber(firstDefined(root.zone_layout_id, root.zoneLayoutId)),
        serial_numbers: rootSerials,
      })
    }
  }

  const computedTotalQuantity = normalizedLineItems.reduce(
    (sum, item) => sum + (typeof item.quantity === "number" ? item.quantity : 0),
    0
  )
  const computedTotalValue = normalizedLineItems.reduce(
    (sum, item) =>
      sum +
      (typeof item.quantity === "number" ? item.quantity : 0) *
        (typeof item.rate === "number" ? item.rate : 0),
    0
  )

  const fallbackTotalQuantity = toPositiveNumber(
    firstDefined(
      headerSource.total_quantity,
      headerSource.totalQuantity,
      headerSource.total_qty,
      headerSource.totalQty,
      headerSource.received_quantity,
      headerSource.receivedQuantity,
      headerSource.received_qty,
      headerSource.receivedQty,
      headerSource.invoice_quantity,
      headerSource.invoiceQuantity,
      headerSource.invoice_qty,
      headerSource.invoiceQty,
      headerSource.quantity,
      headerSource.qty,
      root.total_quantity,
      root.totalQuantity,
      root.total_qty,
      root.totalQty,
      root.received_quantity,
      root.receivedQuantity,
      root.received_qty,
      root.receivedQty,
      root.invoice_quantity,
      root.invoiceQuantity,
      root.invoice_qty,
      root.invoiceQty,
      root.quantity,
      root.qty
    )
  )

  const fallbackTotalItems = toPositiveNumber(
    firstDefined(
      headerSource.total_items,
      headerSource.totalItems,
      headerSource.item_count,
      headerSource.itemCount,
      headerSource.line_count,
      headerSource.lineCount,
      headerSource.sku_count,
      headerSource.skuCount,
      root.total_items,
      root.totalItems,
      root.item_count,
      root.itemCount
    )
  )

  const resolvedTotalQuantity = fallbackTotalQuantity ?? computedTotalQuantity
  const resolvedTotalItems =
    fallbackTotalItems ?? (normalizedLineItems.length > 0 ? normalizedLineItems.length : resolvedTotalQuantity > 0 ? 1 : 0)

  const normalizedHeader = {
    ...headerSource,
    client_id: toNumber(headerSource.client_id ?? headerSource.clientId),
    warehouse_id: toNumber(headerSource.warehouse_id ?? headerSource.warehouseId),
    invoice_number: toStringValue(
      firstDefined(
        headerSource.invoice_number,
        headerSource.invoiceNumber,
        headerSource.invoice_no,
        headerSource.invoiceNo,
        root.invoice_number,
        root.invoiceNumber,
        root.invoice_no,
        root.invoiceNo
      )
    ),
    invoice_date: toStringValue(
      firstDefined(
        headerSource.invoice_date,
        headerSource.invoiceDate,
        headerSource.date,
        headerSource.receipt_date,
        root.invoice_date,
        root.invoiceDate,
        root.date
      )
    ),
    total_items:
      resolvedTotalItems,
    total_quantity:
      resolvedTotalQuantity,
    total_value:
      toNumber(headerSource.total_value ?? headerSource.totalValue ?? headerSource.grn_value) ??
      computedTotalValue,
    basic_price: toNumber(headerSource.basic_price ?? headerSource.basicPrice),
    invoice_quantity: toNumber(headerSource.invoice_quantity ?? headerSource.invoiceQuantity),
    received_quantity: toNumber(headerSource.received_quantity ?? headerSource.receivedQuantity),
    quantity_difference: toNumber(headerSource.quantity_difference ?? headerSource.quantityDifference),
    damage_quantity: toNumber(headerSource.damage_quantity ?? headerSource.damageQuantity),
    case_count: toNumber(headerSource.case_count ?? headerSource.caseCount),
    pallet_count: toNumber(headerSource.pallet_count ?? headerSource.palletCount),
    weight_kg: toNumber(headerSource.weight_kg ?? headerSource.weightKg),
    source_channel:
      (typeof root.source_channel === "string" ? root.source_channel : undefined) ??
      (typeof headerSource.source_channel === "string" ? headerSource.source_channel : undefined) ??
      "MOBILE_OCR",
  }

  return {
    header: normalizedHeader,
    lineItems: normalizedLineItems,
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "grn.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get("page") || "1", 10)
    const limit = parseInt(searchParams.get("limit") || "20", 10)
    const clientId = searchParams.get("client_id")
    const warehouseId = searchParams.get("warehouse_id")
    const status = searchParams.get("status")
    const search = searchParams.get("search")
    const dateFrom = searchParams.get("date_from")
    const dateTo = searchParams.get("date_to")

    const offset = (page - 1) * limit

    const whereConditions: string[] = ["gh.company_id = $1"]
    const params: Array<string | number | number[]> = [session.companyId]
    let paramIndex = 2

    if (clientId) {
      whereConditions.push(`gh.client_id = $${paramIndex}`)
      params.push(parseInt(clientId, 10))
      paramIndex++
    }

    if (warehouseId) {
      requireScope(policy, "warehouse", parseInt(warehouseId, 10))
      whereConditions.push(`gh.warehouse_id = $${paramIndex}`)
      params.push(parseInt(warehouseId, 10))
      paramIndex++
    } else {
      const allowedWarehouseIds = Array.from(
        new Set(
          policy.scopes.warehouseIds
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      )
      if (allowedWarehouseIds.length > 0) {
        whereConditions.push(`gh.warehouse_id = ANY($${paramIndex}::int[])`)
        params.push(allowedWarehouseIds)
        paramIndex++
      }
    }

    if (status) {
      whereConditions.push(`gh.status = $${paramIndex}`)
      params.push(status)
      paramIndex++
    }

    if (search) {
      whereConditions.push(
        `(gh.grn_number ILIKE $${paramIndex} OR gh.invoice_number ILIKE $${paramIndex})`
      )
      params.push(`%${search}%`)
      paramIndex++
    }

    if (dateFrom) {
      whereConditions.push(`gh.grn_date >= $${paramIndex}`)
      params.push(dateFrom)
      paramIndex++
    }

    if (dateTo) {
      whereConditions.push(`gh.grn_date <= $${paramIndex}`)
      params.push(dateTo)
      paramIndex++
    }

    const whereClause =
      whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : ""

    const countResult = await query(
      `SELECT COUNT(*) FROM grn_header gh ${whereClause}`,
      params
    )
    const total = parseInt(countResult.rows[0].count, 10)

    const dataParams = [...params, limit, offset]
    const dataResult = await query(
      `SELECT 
        gh.*,
        c.client_name,
        w.warehouse_name,
        u.full_name as created_by_name,
        (SELECT COUNT(*) FROM grn_line_items gli WHERE gli.grn_header_id = gh.id AND gli.company_id = gh.company_id) as line_items_count
      FROM grn_header gh
      JOIN clients c ON gh.client_id = c.id AND c.company_id = gh.company_id
      JOIN warehouses w ON gh.warehouse_id = w.id AND w.company_id = gh.company_id
      LEFT JOIN users u ON gh.created_by = u.id AND u.company_id = gh.company_id
      ${whereClause}
      ORDER BY gh.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    )

    return paginated(dataResult.rows, {
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
    console.error("GRN list error:", error)
    const message = error instanceof Error ? error.message : "Failed to fetch GRNs"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const client = await getClient()

  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }

    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "grn.manage")

    const body = await request.json()
    const normalized = normalizeCreateGrnPayload(body)
    const headerData = grnHeaderSchema.parse(normalized.header)
    const parsedLineItems = Array.isArray(normalized.lineItems) ? normalized.lineItems : []
    const lineItems = parsedLineItems.map((item: unknown) => grnLineItemSchema.parse(item))

    await ensureGrnManualSchema(client)
    await ensureStockPutawaySchema(client)

    await client.query("BEGIN")
    await setTenantContext(client, session.companyId)

    const created = await createGrnWithLineItems(client, {
      header: headerData,
      lineItems,
      createdBy: session.userId,
    })

    await client.query("COMMIT")

    return ok(created, "GRN created successfully")
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    console.error("GRN creation error:", error)
    const message = error instanceof Error ? error.message : "Failed to create GRN"
    return fail("VALIDATION_OR_CREATE_ERROR", message, 400)
  } finally {
    client.release()
  }
}
