import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { id } = await params
    const gateInId = Number(id)
    if (!gateInId) return fail("VALIDATION_ERROR", "Invalid gate-in id", 400)

    const result = await query(
      `SELECT
        gi.id,
        gi.gate_in_number,
        gi.gate_in_datetime,
        gi.arrival_datetime,
        gi.departure_datetime,
        gi.truck_number AS vehicle_number,
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
        gi.status,
        gi.created_at,
        c.client_name,
        w.warehouse_name
      FROM gate_in gi
      JOIN clients c ON c.id = gi.client_id
      JOIN warehouses w ON w.id = gi.warehouse_id
      WHERE gi.id = $1
      LIMIT 1`,
      [gateInId]
    )

    if (!result.rows.length) return fail("NOT_FOUND", "Gate In record not found", 404)

    return ok(result.rows[0])
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch gate-in record"
    return fail("SERVER_ERROR", message, 500)
  }
}
