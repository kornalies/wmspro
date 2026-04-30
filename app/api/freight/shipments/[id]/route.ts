import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { resolveFreightShipmentId, toNullableTimestamp } from "@/lib/freight-service"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { freightShipmentUpdateSchema } from "@/lib/validations/freight"

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

    const [headerResult, legsResult, milestonesResult, documentsResult] = await Promise.all([
      query(
        `SELECT
           s.*,
           c.client_name,
           u.full_name AS created_by_name
         FROM ff_shipments s
         LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
         LEFT JOIN users u ON u.id = s.created_by AND u.company_id = s.company_id
         WHERE s.company_id = $1
           AND s.id = $2
         LIMIT 1`,
        [session.companyId, shipmentId]
      ),
      query(
        `SELECT *
         FROM ff_shipment_legs
         WHERE company_id = $1
           AND shipment_id = $2
         ORDER BY leg_no ASC`,
        [session.companyId, shipmentId]
      ),
      query(
        `SELECT *
         FROM ff_milestones
         WHERE company_id = $1
           AND shipment_id = $2
         ORDER BY COALESCE(planned_at, created_at) ASC, id ASC`,
        [session.companyId, shipmentId]
      ),
      query(
        `SELECT d.*,
                a.file_name AS attachment_file_name,
                a.content_type AS attachment_content_type
         FROM ff_documents d
         LEFT JOIN attachments a
           ON a.id = d.attachment_id
          AND a.company_id = d.company_id
         WHERE d.company_id = $1
           AND d.shipment_id = $2
         ORDER BY d.created_at DESC`,
        [session.companyId, shipmentId]
      ),
    ])

    if (!headerResult.rows.length) return fail("NOT_FOUND", "Shipment not found", 404)

    return ok({
      ...headerResult.rows[0],
      legs: legsResult.rows,
      milestones: milestonesResult.rows,
      documents: documentsResult.rows,
    })
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch shipment"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.manage")

    const { id } = await context.params
    const shipmentId = await resolveFreightShipmentId(session.companyId, id)
    if (!shipmentId) return fail("NOT_FOUND", "Shipment not found", 404)

    const payload = freightShipmentUpdateSchema.parse(await request.json())
    const updates: string[] = []
    const params: Array<string | number | null> = []
    let idx = 1

    const assign = (column: string, value: string | number | null) => {
      updates.push(`${column} = $${idx++}`)
      params.push(value)
    }

    if (payload.mode !== undefined) assign("mode", payload.mode)
    if (payload.direction !== undefined) assign("direction", payload.direction)
    if (payload.status !== undefined) assign("status", payload.status)
    if (payload.client_id !== undefined) assign("client_id", payload.client_id ?? null)
    if (payload.shipper_name !== undefined) assign("shipper_name", payload.shipper_name || null)
    if (payload.consignee_name !== undefined) assign("consignee_name", payload.consignee_name || null)
    if (payload.incoterm !== undefined) assign("incoterm", payload.incoterm || null)
    if (payload.origin !== undefined) assign("origin", payload.origin)
    if (payload.destination !== undefined) assign("destination", payload.destination)
    if (payload.etd !== undefined) assign("etd", toNullableTimestamp(payload.etd))
    if (payload.eta !== undefined) assign("eta", toNullableTimestamp(payload.eta))
    if (payload.remarks !== undefined) assign("remarks", payload.remarks || null)

    if (!updates.length) {
      return fail("VALIDATION_ERROR", "No fields provided for update", 400)
    }

    assign("updated_by", session.userId)
    updates.push("updated_at = NOW()")

    params.push(session.companyId, shipmentId)
    const updated = await query(
      `UPDATE ff_shipments
       SET ${updates.join(", ")}
       WHERE company_id = $${idx++}
         AND id = $${idx}
       RETURNING *`,
      params
    )

    if (!updated.rows.length) return fail("NOT_FOUND", "Shipment not found", 404)
    return ok(updated.rows[0], "Shipment updated")
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to update shipment"
    return fail("UPDATE_FAILED", message, 400)
  }
}
