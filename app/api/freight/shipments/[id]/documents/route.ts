import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { resolveFreightShipmentId } from "@/lib/freight-service"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { freightDocumentCreateSchema } from "@/lib/validations/freight"

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
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch documents"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.docs.manage")

    const { id } = await context.params
    const shipmentId = await resolveFreightShipmentId(session.companyId, id)
    if (!shipmentId) return fail("NOT_FOUND", "Shipment not found", 404)

    const payload = freightDocumentCreateSchema.parse(await request.json())
    if (payload.attachment_id) {
      const attachment = await query(
        `SELECT id
         FROM attachments
         WHERE company_id = $1
           AND id = $2
         LIMIT 1`,
        [session.companyId, payload.attachment_id]
      )
      if (!attachment.rows.length) {
        return fail("VALIDATION_ERROR", "Attachment not found for this tenant", 400)
      }
    }

    const inserted = await query(
      `INSERT INTO ff_documents (
         company_id, shipment_id, doc_type, doc_no, issue_date, attachment_id, is_master, metadata_json
       ) VALUES (
         $1,$2,$3,$4,$5::date,$6,$7,$8::jsonb
       )
       RETURNING *`,
      [
        session.companyId,
        shipmentId,
        payload.doc_type,
        payload.doc_no,
        payload.issue_date || null,
        payload.attachment_id ?? null,
        payload.is_master ?? false,
        JSON.stringify(payload.metadata_json || {}),
      ]
    )
    return ok(inserted.rows[0], "Document added")
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to add document"
    return fail("CREATE_FAILED", message, 400)
  }
}
