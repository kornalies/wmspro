import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireScope } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

const gateOutSchema = z.object({
  warehouse_id: z.number().positive(),
  do_number: z.string().min(1),
  vehicle_number: z.string().min(3),
  driver_name: z.string().min(2),
  driver_phone: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "gate.out.create")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    const { searchParams } = new URL(request.url)
    const search = String(searchParams.get("search") || "").trim()
    const explicitWarehouseId = Number(searchParams.get("warehouse_id") || 0)
    const warehouseId = explicitWarehouseId || session.warehouseId || 0
    if (warehouseId) requireScope(policy, "warehouse", warehouseId)

    const where: string[] = ["c.company_id = $1", "w.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2
    if (warehouseId) {
      where.push(`go.warehouse_id = $${idx++}`)
      params.push(warehouseId)
    }
    if (search) {
      where.push(`(go.gate_out_number ILIKE $${idx} OR go.truck_number ILIKE $${idx} OR dh.do_number ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }

    const result = await query(
      `SELECT
        go.id,
        go.gate_out_number,
        go.gate_out_datetime,
        go.truck_number as vehicle_number,
        go.driver_name,
        go.driver_phone,
        dh.do_number,
        c.client_name,
        w.warehouse_name
      FROM gate_out go
      LEFT JOIN do_header dh ON dh.id = go.do_header_id
      JOIN clients c ON c.id = go.client_id
      JOIN warehouses w ON w.id = go.warehouse_id
      WHERE ${where.join(" AND ")}
      ORDER BY go.gate_out_datetime DESC
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
    const message = error instanceof Error ? error.message : "Failed to fetch gate-out logs"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    requirePermission(session, "gate.out.create")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )

    const payload = gateOutSchema.parse(await request.json())
    requireScope(policy, "warehouse", payload.warehouse_id)

    const doResult = await query(
      "SELECT id, client_id, warehouse_id FROM do_header WHERE do_number = $1 AND company_id = $2 LIMIT 1",
      [payload.do_number, session.companyId]
    )
    if (doResult.rows.length === 0) {
      return fail("DO_NOT_FOUND", "Delivery Order not found", 404)
    }

    const doHeader = doResult.rows[0]
    if (Number(doHeader.warehouse_id) !== Number(payload.warehouse_id)) {
      return fail("VALIDATION_ERROR", "DO does not belong to selected warehouse", 400)
    }
    requireScope(policy, "client", Number(doHeader.client_id))
    const result = await query(
      `INSERT INTO gate_out (
        gate_out_number, gate_out_datetime, warehouse_id, client_id, do_header_id,
        truck_number, driver_name, driver_phone, created_by
      )
      VALUES (
        CONCAT('GOUT-', TO_CHAR(CURRENT_DATE, 'YYYYMMDD'), '-', LPAD(CAST(FLOOR(RANDOM() * 99999)::INT AS TEXT), 5, '0')),
        CURRENT_TIMESTAMP, $1, $2, $3, $4, $5, $6, $7
      )
      RETURNING *`,
      [
        payload.warehouse_id,
        doHeader.client_id,
        doHeader.id,
        payload.vehicle_number,
        payload.driver_name,
        payload.driver_phone || null,
        session.userId,
      ]
    )

    return ok(result.rows[0], "Gate Out recorded successfully")
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to record gate-out"
    return fail("CREATE_FAILED", message, 400)
  }
}
