import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { stageChargeTransaction } from "@/lib/billing-service"
import { writeAudit } from "@/lib/audit"
import { getDOStatusErrorMessage, isDOStatus, normalizeDOStatus } from "@/lib/do-status"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  enforceWorkflow,
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

const dispatchSchema = z.object({
  vehicle_number: z.string().min(3).optional(),
  vehicleNumber: z.string().min(3).optional(),
  driver_name: z.string().min(2).optional(),
  driverName: z.string().min(2).optional(),
  driver_phone: z.string().min(3).optional(),
  driverPhone: z.string().min(3).optional(),
  seal_number: z.string().optional(),
  sealNumber: z.string().optional(),
  dispatch_date: z.string().optional(),
  dispatchDate: z.string().optional(),
  dispatch_time: z.string().optional(),
  dispatchTime: z.string().optional(),
  remarks: z.string().optional(),
  outwardRemarks: z.string().optional(),
  supplierName: z.string().optional(),
  invoiceNo: z.string().optional(),
  invoiceDate: z.string().optional(),
  modelNo: z.string().optional(),
  serialNo: z.string().optional(),
  materialDescription: z.string().optional(),
  dateOfManufacturing: z.string().optional(),
  basicPrice: z.number().optional(),
  invoiceQty: z.number().int().optional(),
  dispatchedQty: z.number().int().optional(),
  difference: z.number().int().optional(),
  noOfCases: z.number().int().optional(),
  noOfPallets: z.number().int().optional(),
  weight: z.number().optional(),
  handlingType: z.string().optional(),
  machineType: z.string().optional(),
  machineFromTime: z.string().optional(),
  machineToTime: z.string().optional(),
  doNo: z.string().optional(),
  clientName: z.string().optional(),
  items: z
    .array(
      z.object({
        item_id: z.number().positive(),
        quantity: z.number().int().min(0),
      })
    )
    .default([]),
})

type ParsedDispatch = z.infer<typeof dispatchSchema>

function normalizePayload(payload: ParsedDispatch) {
  const handlingRaw = payload.handlingType?.trim().toUpperCase()
  const normalizedHandling =
    handlingRaw === "MACHINE HANDLING" || handlingRaw === "MACHINE"
      ? "MACHINE"
      : handlingRaw === "MANUAL HANDLING" || handlingRaw === "MANUAL"
        ? "MANUAL"
        : null

  return {
    vehicleNumber: payload.vehicle_number ?? payload.vehicleNumber ?? null,
    driverName: payload.driver_name ?? payload.driverName ?? null,
    driverPhone: payload.driver_phone ?? payload.driverPhone ?? null,
    sealNumber: payload.seal_number ?? payload.sealNumber ?? null,
    dispatchDate: payload.dispatch_date ?? payload.dispatchDate ?? null,
    dispatchTime: payload.dispatch_time ?? payload.dispatchTime ?? null,
    remarks: payload.remarks ?? null,
    outwardRemarks: payload.outwardRemarks ?? payload.remarks ?? null,
    supplierName: payload.supplierName ?? null,
    invoiceNo: payload.invoiceNo ?? null,
    invoiceDate: payload.invoiceDate ?? null,
    modelNo: payload.modelNo ?? null,
    serialNo: payload.serialNo ?? null,
    materialDescription: payload.materialDescription ?? null,
    dateOfManufacturing: payload.dateOfManufacturing ?? null,
    basicPrice: payload.basicPrice ?? null,
    invoiceQty: payload.invoiceQty ?? null,
    dispatchedQty: payload.dispatchedQty ?? null,
    noOfCases: payload.noOfCases ?? null,
    noOfPallets: payload.noOfPallets ?? null,
    weightKg: payload.weight ?? null,
    handlingType: normalizedHandling,
    machineType: payload.machineType ?? null,
    machineFromTime: payload.machineFromTime ?? null,
    machineToTime: payload.machineToTime ?? null,
    mobilePayload: payload,
    items: payload.items,
  }
}

const itemSchema = z.object({
  item_id: z.number().positive(),
  quantity: z.number().int().min(0),
})

const normalizedDispatchSchema = dispatchSchema.superRefine((value, ctx) => {
  const normalizedItems = (value.items || []).map((item) => itemSchema.parse(item))
  const hasDispatchLines = normalizedItems.some((item) => item.quantity > 0)
  const vehicleNumber = value.vehicle_number ?? value.vehicleNumber
  const driverName = value.driver_name ?? value.driverName
  const driverPhone = value.driver_phone ?? value.driverPhone

  if (hasDispatchLines) {
    if (!vehicleNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vehicle number is required when dispatch quantity is provided",
        path: ["vehicle_number"],
      })
    }
    if (!driverName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Driver name is required when dispatch quantity is provided",
        path: ["driver_name"],
      })
    }
    if (!driverPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Driver phone is required when dispatch quantity is provided",
        path: ["driver_phone"],
      })
    }
  }
})

type RouteContext = {
  params: Promise<{ id: string }>
}

type DOLineRow = {
  id: number
  item_id: number
  quantity_requested: number
  quantity_dispatched: number
}

export async function POST(request: NextRequest, context: RouteContext) {
  const dbClient = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { id } = await context.params
    const rawRef = decodeURIComponent(id).trim()
    const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
    const doNumber = numericId ? null : rawRef
    const payload = normalizePayload(normalizedDispatchSchema.parse(await request.json()))

    await dbClient.query("BEGIN")
    await setTenantContext(dbClient, session.companyId)

    const doResult = await dbClient.query(
      `SELECT *
       FROM do_header
       WHERE company_id = $1
         AND (
           ($2::int IS NOT NULL AND id = $2)
           OR ($3::text IS NOT NULL AND do_number ILIKE $3)
         )
       FOR UPDATE`,
      [session.companyId, numericId, doNumber]
    )
    if (doResult.rows.length === 0) {
      await dbClient.query("ROLLBACK")
      return fail("NOT_FOUND", "Delivery Order not found", 404)
    }

    const doHeader = doResult.rows[0]
    const doId = Number(doHeader.id)
    const currentStatus = normalizeDOStatus(doHeader.status)
    if (!currentStatus) {
      await dbClient.query("ROLLBACK")
      return fail("DO_STATUS_INVALID", getDOStatusErrorMessage(doHeader.status), 409)
    }

    if (currentStatus === "CANCELLED") {
      await dbClient.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Cancelled delivery order cannot be dispatched", 409)
    }
    if (currentStatus === "COMPLETED") {
      await dbClient.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Completed delivery order cannot be dispatched again", 409)
    }

    requireScope(policy, "warehouse", doHeader.warehouse_id)
    requireScope(policy, "client", doHeader.client_id)
    enforceWorkflow(policy, "do.dispatch", payload, {
      qcApproved:
        doHeader.qc_approved === true ||
        String(doHeader.qc_status || "").toUpperCase() === "APPROVED",
      paymentHold: doHeader.payment_hold === true || doHeader.is_payment_hold === true,
    })

    const linesResult = await dbClient.query(
      `SELECT id, item_id, quantity_requested, quantity_dispatched
       FROM do_line_items
       WHERE do_header_id = $1
         AND company_id = $2
       FOR UPDATE`,
      [doId, session.companyId]
    )
    const lines = linesResult.rows as DOLineRow[]

    const requestedByItem = new Map<number, number>()
    for (const item of payload.items) {
      if (item.quantity <= 0) continue
      requestedByItem.set(item.item_id, (requestedByItem.get(item.item_id) || 0) + Number(item.quantity))
    }
    const requestedDispatchQty = Array.from(requestedByItem.values()).reduce((sum, qty) => sum + qty, 0)
    const providedInvoiceQty = payload.invoiceQty
    const providedDispatchedQty = payload.dispatchedQty
    if (providedInvoiceQty != null && Number(providedInvoiceQty) < 0) {
      await dbClient.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Invoice qty cannot be negative", 400)
    }
    if (providedDispatchedQty != null && Number(providedDispatchedQty) < 0) {
      await dbClient.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Dispatched qty cannot be negative", 400)
    }
    if (
      providedInvoiceQty != null &&
      providedDispatchedQty != null &&
      Number(providedDispatchedQty) > Number(providedInvoiceQty)
    ) {
      await dbClient.query("ROLLBACK")
      return fail("WORKFLOW_BLOCKED", "Dispatched qty cannot exceed invoice qty", 409)
    }

    const previouslyDispatched = Number(doHeader.total_quantity_dispatched || 0)
    if (requestedDispatchQty > 0 && previouslyDispatched <= 0 && currentStatus !== "STAGED") {
      await dbClient.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        `DO must be in STAGED status before first dispatch. Current status is ${currentStatus || "UNKNOWN"}.`,
        409
      )
    }

    let hasDispatchedAnyLine = false
    let dispatchedThisTxn = 0
    for (const [itemId, requestedQty] of requestedByItem.entries()) {
      const line = lines.find((row) => Number(row.item_id) === itemId)
      if (!line) {
        await dbClient.query("ROLLBACK")
        return fail("VALIDATION_ERROR", `Item ${itemId} does not exist in this delivery order`, 400)
      }

      const remaining = Number(line.quantity_requested) - Number(line.quantity_dispatched)
      if (requestedQty > remaining) {
        await dbClient.query("ROLLBACK")
        return fail(
          "INVENTORY_VALIDATION_FAILED",
          `Dispatch qty ${requestedQty} exceeds DO remaining qty ${remaining} for item ${itemId}`,
          409
        )
      }
      const dispatchQty = requestedQty
      if (dispatchQty <= 0) continue
      hasDispatchedAnyLine = true
      dispatchedThisTxn += dispatchQty

      const stockRows = await dbClient.query(
        `SELECT id
         FROM stock_serial_numbers
         WHERE warehouse_id = $1
           AND client_id = $2
           AND item_id = $3
           AND company_id = $4
           AND (
             (status = 'RESERVED' AND do_line_item_id = $5)
             OR (status = 'IN_STOCK' AND do_line_item_id IS NULL)
           )
         ORDER BY
           CASE WHEN status = 'RESERVED' THEN 0 ELSE 1 END,
           received_date ASC,
           id ASC
         LIMIT $6
         FOR UPDATE SKIP LOCKED`,
        [doHeader.warehouse_id, doHeader.client_id, itemId, session.companyId, line.id, dispatchQty]
      )

      const stockIds = stockRows.rows.map((stock: { id: number }) => Number(stock.id)).filter(Boolean)
      if (stockIds.length < dispatchQty) {
        await dbClient.query("ROLLBACK")
        return fail(
          "INVENTORY_VALIDATION_FAILED",
          `Insufficient inventory for item ${itemId}. Required ${dispatchQty}, available ${stockIds.length}.`,
          409
        )
      }

      await dbClient.query(
        `UPDATE do_line_items
         SET quantity_dispatched = quantity_dispatched + $1
         WHERE id = $2
           AND company_id = $3`,
        [dispatchQty, line.id, session.companyId]
      )

      await dbClient.query(
        `UPDATE stock_serial_numbers
         SET status = 'DISPATCHED',
             do_line_item_id = $1,
             dispatched_date = CURRENT_DATE
         WHERE company_id = $2
           AND id = ANY($3::int[])`,
        [line.id, session.companyId, stockIds]
      )
    }

    const totals = await dbClient.query(
      `SELECT
        COALESCE(SUM(quantity_requested), 0) AS total_requested,
        COALESCE(SUM(quantity_dispatched), 0) AS total_dispatched
      FROM do_line_items
      WHERE do_header_id = $1
        AND company_id = $2`,
      [doId, session.companyId]
    )

    const totalRequested = Number(totals.rows[0].total_requested)
    const totalDispatched = Number(totals.rows[0].total_dispatched)
    const headerInvoiceQty =
      providedInvoiceQty != null
        ? Number(providedInvoiceQty)
        : doHeader.invoice_qty != null
          ? Number(doHeader.invoice_qty)
          : null
    if (headerInvoiceQty != null && totalDispatched > headerInvoiceQty) {
      await dbClient.query("ROLLBACK")
      return fail(
        "WORKFLOW_BLOCKED",
        `Total dispatched qty ${totalDispatched} cannot exceed invoice qty ${headerInvoiceQty}`,
        409
      )
    }
    const headerDispatchedQty = totalDispatched
    const quantityDifference = headerInvoiceQty != null ? headerInvoiceQty - headerDispatchedQty : null

    const nextStatusCandidate =
      totalDispatched >= totalRequested && totalRequested > 0
        ? "COMPLETED"
      : totalDispatched > 0
          ? "PARTIALLY_FULFILLED"
          : currentStatus === "DRAFT"
            ? "PENDING"
            : currentStatus
    const nextStatus = isDOStatus(nextStatusCandidate) ? nextStatusCandidate : null
    if (!nextStatus) {
      await dbClient.query("ROLLBACK")
      return fail("DO_STATUS_INVALID", getDOStatusErrorMessage(nextStatusCandidate), 409)
    }

    await dbClient.query(
      `UPDATE do_header
       SET total_quantity_dispatched = $1,
           status = $2,
           dispatch_date = COALESCE($3::date, dispatch_date),
           supplier_name = COALESCE($4, supplier_name),
           invoice_no = COALESCE($5, invoice_no),
           invoice_date = COALESCE($6::date, invoice_date),
           model_no = COALESCE($7, model_no),
           serial_no = COALESCE($8, serial_no),
            material_description = COALESCE($9, material_description),
            date_of_manufacturing = COALESCE($10::date, date_of_manufacturing),
            basic_price = COALESCE($11, basic_price),
            invoice_qty = COALESCE($12, invoice_qty),
            dispatched_qty = $13,
            quantity_difference = $14,
           no_of_cases = COALESCE($15, no_of_cases),
           no_of_pallets = COALESCE($16, no_of_pallets),
           weight_kg = COALESCE($17, weight_kg),
           handling_type = COALESCE($18, handling_type),
           machine_type = COALESCE($19, machine_type),
           machine_from_time = COALESCE($20::timestamp, machine_from_time),
           machine_to_time = COALESCE($21::timestamp, machine_to_time),
           remarks = COALESCE($22, remarks),
           outward_remarks = COALESCE($23, outward_remarks),
           mobile_capture_payload = COALESCE($24::jsonb, mobile_capture_payload),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $25
         AND company_id = $26`,
      [
        totalDispatched,
        nextStatus,
        payload.dispatchDate,
        payload.supplierName,
        payload.invoiceNo,
        payload.invoiceDate,
        payload.modelNo,
        payload.serialNo,
        payload.materialDescription,
        payload.dateOfManufacturing,
        payload.basicPrice,
        headerInvoiceQty,
        headerDispatchedQty,
        quantityDifference,
        payload.noOfCases,
        payload.noOfPallets,
        payload.weightKg,
        payload.handlingType,
        payload.machineType,
        payload.machineFromTime,
        payload.machineToTime,
        payload.remarks,
        payload.outwardRemarks,
        JSON.stringify(payload.mobilePayload),
        doId,
        session.companyId,
      ]
    )

    if (dispatchedThisTxn > 0) {
      const eventDateRaw =
        payload.dispatchDate ||
        (doHeader.dispatch_date ? String(doHeader.dispatch_date).slice(0, 10) : null) ||
        new Date().toISOString().slice(0, 10)
      await stageChargeTransaction(dbClient, {
        companyId: session.companyId,
        userId: session.userId,
        clientId: Number(doHeader.client_id),
        warehouseId: Number(doHeader.warehouse_id),
        chargeType: "OUTBOUND_HANDLING",
        sourceType: "DO",
        sourceDocId: doId,
        sourceRefNo: String(doHeader.do_number || rawRef),
        eventDate: eventDateRaw,
        periodFrom: eventDateRaw,
        periodTo: eventDateRaw,
        quantity: dispatchedThisTxn,
        uom: "UNIT",
        remarks: "Auto staged on DO dispatch",
      })
    }

    if (hasDispatchedAnyLine && payload.vehicleNumber && payload.driverName && payload.driverPhone) {
      await dbClient.query(
        `INSERT INTO gate_out (
          company_id,
          gate_out_number, gate_out_datetime, warehouse_id, client_id, do_header_id,
          truck_number, driver_name, driver_phone, created_by
        )
        VALUES (
          $1,
          CONCAT('GOUT-', TO_CHAR(CURRENT_DATE, 'YYYYMMDD'), '-', LPAD(CAST(FLOOR(RANDOM() * 99999)::INT AS TEXT), 5, '0')),
          CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7, $8
        )`,
        [
          session.companyId,
          doHeader.warehouse_id,
          doHeader.client_id,
          doId,
          payload.vehicleNumber,
          payload.driverName,
          payload.driverPhone,
          session.userId,
        ]
      )
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.dispatch",
        entityType: "do_header",
        entityId: String(doId),
        before: {
          status: doHeader.status,
          total_quantity_dispatched: doHeader.total_quantity_dispatched,
        },
        after: {
          status: nextStatus,
          total_quantity_dispatched: totalDispatched,
        },
        req: request,
      },
      dbClient
    )

    await dbClient.query("COMMIT")
    return ok(
      {
        id: doId,
        status: nextStatus,
        doStatus: {
          status: nextStatus,
        },
      },
      "Dispatch completed"
    )
  } catch (error: unknown) {
    await dbClient.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to dispatch DO"
    return fail("DISPATCH_FAILED", message, 400)
  } finally {
    dbClient.release()
  }
}

