import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { resolveFreightShipmentId, toNullableTimestamp } from "@/lib/freight-service"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { freightMilestoneCreateSchema } from "@/lib/validations/freight"

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
       FROM ff_milestones
       WHERE company_id = $1
         AND shipment_id = $2
       ORDER BY COALESCE(planned_at, created_at) ASC, id ASC`,
      [session.companyId, shipmentId]
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch milestones"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.milestone.update")

    const { id } = await context.params
    const shipmentId = await resolveFreightShipmentId(session.companyId, id)
    if (!shipmentId) return fail("NOT_FOUND", "Shipment not found", 404)

    const payload = freightMilestoneCreateSchema.parse(await request.json())
    const inserted = await query(
      `INSERT INTO ff_milestones (
         company_id, shipment_id, code, planned_at, actual_at, status, remarks
       ) VALUES (
         $1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7
       )
       RETURNING *`,
      [
        session.companyId,
        shipmentId,
        payload.code.toUpperCase(),
        toNullableTimestamp(payload.planned_at),
        toNullableTimestamp(payload.actual_at),
        payload.status || "PENDING",
        payload.remarks || null,
      ]
    )
    return ok(inserted.rows[0], "Milestone added")
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to add milestone"
    return fail("CREATE_FAILED", message, 400)
  }
}
