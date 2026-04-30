import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { resolveFreightShipmentId, toNullableTimestamp } from "@/lib/freight-service"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { freightLegCreateSchema } from "@/lib/validations/freight"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.view")

    const { id } = await context.params
    const shipmentId = await resolveFreightShipmentId(session.companyId, id)
    if (!shipmentId) return fail("NOT_FOUND", "Shipment not found", 404)

    const result = await query(
      `SELECT *
       FROM ff_shipment_legs
       WHERE company_id = $1
         AND shipment_id = $2
       ORDER BY leg_no ASC`,
      [session.companyId, shipmentId]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch shipment legs"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.manage")

    const { id } = await context.params
    const shipmentId = await resolveFreightShipmentId(session.companyId, id)
    if (!shipmentId) return fail("NOT_FOUND", "Shipment not found", 404)

    const payload = freightLegCreateSchema.parse(await request.json())
    const legNo =
      payload.leg_no ??
      Number(
        (
          await query(
            `SELECT COALESCE(MAX(leg_no), 0) + 1 AS next_leg_no
             FROM ff_shipment_legs
             WHERE company_id = $1
               AND shipment_id = $2`,
            [session.companyId, shipmentId]
          )
        ).rows[0]?.next_leg_no || 1
      )

    const inserted = await query(
      `INSERT INTO ff_shipment_legs (
         company_id, shipment_id, leg_no, transport_mode, carrier_name, vessel_or_flight, voyage_or_flight_no,
         from_location, to_location, etd, eta, atd, ata, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13::timestamptz,$14
       )
       RETURNING *`,
      [
        session.companyId,
        shipmentId,
        legNo,
        payload.transport_mode,
        payload.carrier_name || null,
        payload.vessel_or_flight || null,
        payload.voyage_or_flight_no || null,
        payload.from_location,
        payload.to_location,
        toNullableTimestamp(payload.etd),
        toNullableTimestamp(payload.eta),
        toNullableTimestamp(payload.atd),
        toNullableTimestamp(payload.ata),
        payload.status || "PLANNED",
      ]
    )

    return ok(inserted.rows[0], "Shipment leg added")
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to add shipment leg"
    return fail("CREATE_FAILED", message, 400)
  }
}
