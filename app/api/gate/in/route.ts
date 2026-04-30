import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { requireScope, guardToFailResponse } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

const gateInSchema = z.object({
  warehouse_id: z.number().positive().optional(),
  warehouseId: z.number().positive().optional(),
  client_id: z.number().positive().optional(),
  clientId: z.number().positive().optional(),
  vehicle_number: z.string().min(3).optional(),
  vehicleNo: z.string().min(3).optional(),
  driver_name: z.string().min(2).optional(),
  driver_phone: z.string().optional(),
  transporterName: z.string().optional(),
  vehicleInTime: z.string().optional(),
  lrNo: z.string().optional(),
  lrDate: z.string().optional(),
  eWayBillNo: z.string().optional(),
  eWayBillDate: z.string().optional(),
  fromLocation: z.string().optional(),
  toLocation: z.string().optional(),
  vehicleType: z.string().optional(),
  vehicleModel: z.string().optional(),
  transportedBy: z.string().optional(),
  vendorName: z.string().optional(),
  transportationRemarks: z.string().optional(),
  grn_reference: z.string().optional(),
  photo_url: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "gate.in.create")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )

    const { searchParams } = new URL(request.url)
    const search = String(searchParams.get("search") || "").trim()
    const date = String(searchParams.get("date") || "").trim()
    const explicitWarehouseId = Number(searchParams.get("warehouse_id") || 0)
    const warehouseId = explicitWarehouseId || session.warehouseId || 0
    if (warehouseId) requireScope(policy, "warehouse", warehouseId)

    const where: string[] = ["c.company_id = $1", "w.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2
    if (warehouseId) {
      where.push(`gi.warehouse_id = $${idx++}`)
      params.push(warehouseId)
    }
    if (search) {
      where.push(`(gi.gate_in_number ILIKE $${idx} OR gi.truck_number ILIKE $${idx} OR c.client_name ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (date) {
      where.push(`DATE(gi.gate_in_datetime) = $${idx}`)
      params.push(date)
      idx++
    }

    const result = await query(
      `SELECT
        gi.id,
        gi.gate_in_number,
        gi.gate_in_datetime,
        gi.departure_datetime,
        gi.truck_number as vehicle_number,
        gi.driver_name,
        gi.driver_phone,
        gi.transport_company,
        gi.lr_number,
        gi.lr_date,
        gi.e_way_bill_number,
        gi.e_way_bill_date,
        gi.from_location,
        gi.to_location,
        gi.vehicle_type,
        gi.vehicle_model,
        gi.transported_by,
        gi.vendor_name,
        gi.transportation_remarks,
        NULL::integer as grn_header_id,
        c.client_name,
        w.warehouse_name
      FROM gate_in gi
      JOIN clients c ON c.id = gi.client_id
      JOIN warehouses w ON w.id = gi.warehouse_id
      WHERE ${where.join(" AND ")}
      ORDER BY gi.gate_in_datetime DESC
      LIMIT 50`
      ,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch gate-in logs"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "gate.in.create")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )

    const payload = gateInSchema.parse(await request.json())
    const warehouseId = payload.warehouse_id ?? payload.warehouseId ?? session.warehouseId
    const clientId = payload.client_id ?? payload.clientId
    const vehicleNumber = (payload.vehicle_number ?? payload.vehicleNo)?.trim()
    const transporterName = payload.transporterName?.trim()
    const driverName = payload.driver_name?.trim() || transporterName || "N/A"
    const vehicleInTime = payload.vehicleInTime || new Date().toISOString()

    if (!warehouseId) return fail("VALIDATION_ERROR", "Warehouse is required", 400)
    if (!clientId) return fail("VALIDATION_ERROR", "Client is required", 400)
    if (!vehicleNumber) return fail("VALIDATION_ERROR", "Vehicle number is required", 400)
    requireScope(policy, "warehouse", warehouseId)
    requireScope(policy, "client", clientId)

    const result = await query(
      `INSERT INTO gate_in (
        gate_in_number, gate_in_datetime, arrival_datetime, warehouse_id, client_id,
        truck_number, driver_name, driver_phone, transport_company, lr_number, lr_date,
        e_way_bill_number, e_way_bill_date, from_location, to_location, vehicle_type,
        vehicle_model, transported_by, vendor_name, remarks, transportation_remarks,
        mobile_capture_payload, status, created_by
      )
      VALUES (
        CONCAT('GIN-', TO_CHAR(CURRENT_DATE, 'YYYYMMDD'), '-', LPAD(CAST(FLOOR(RANDOM() * 99999)::INT AS TEXT), 5, '0')),
        $1::timestamp, $1::timestamp, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11::date, $12,
        $13, $14, $15, $16, $17, $18, $19, $20::jsonb, 'PENDING', $21
      )
      RETURNING *`,
      [
        vehicleInTime,
        warehouseId,
        clientId,
        vehicleNumber.toUpperCase(),
        driverName,
        payload.driver_phone || null,
        transporterName || null,
        payload.lrNo || null,
        payload.lrDate || null,
        payload.eWayBillNo || null,
        payload.eWayBillDate || null,
        payload.fromLocation || null,
        payload.toLocation || null,
        payload.vehicleType || null,
        payload.vehicleModel || null,
        payload.transportedBy?.toUpperCase() || null,
        payload.vendorName || null,
        payload.transportationRemarks || payload.grn_reference || null,
        payload.transportationRemarks || null,
        JSON.stringify(payload),
        session.userId,
      ]
    )

    return ok(result.rows[0], "Gate In recorded successfully")
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to record gate-in"
    return fail("CREATE_FAILED", message, 400)
  }
}
