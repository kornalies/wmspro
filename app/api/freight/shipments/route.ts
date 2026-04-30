import { NextRequest } from "next/server"

import { fail, ok, paginated } from "@/lib/api-response"
import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { generateFreightShipmentNumber, toNullableTimestamp } from "@/lib/freight-service"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"
import { freightShipmentCreateSchema } from "@/lib/validations/freight"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.view")

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get("page") || "1"))
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || "20")))
    const offset = (page - 1) * limit
    const search = (searchParams.get("search") || "").trim()
    const status = (searchParams.get("status") || "").trim().toUpperCase()
    const mode = (searchParams.get("mode") || "").trim().toUpperCase()

    const where: string[] = ["s.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2

    if (search) {
      where.push(`(s.shipment_no ILIKE $${idx} OR s.origin ILIKE $${idx} OR s.destination ILIKE $${idx} OR COALESCE(c.client_name, '') ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (status) {
      where.push(`s.status = $${idx++}`)
      params.push(status)
    }
    if (mode) {
      where.push(`s.mode = $${idx++}`)
      params.push(mode)
    }

    const whereClause = `WHERE ${where.join(" AND ")}`
    const countResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM ff_shipments s
       LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
       ${whereClause}`,
      params
    )
    const total = Number(countResult.rows[0]?.count || 0)

    const result = await query(
      `SELECT
         s.id,
         s.shipment_no,
         s.mode,
         s.direction,
         s.status,
         s.origin,
         s.destination,
         s.etd,
         s.eta,
         s.created_at,
         s.updated_at,
         s.client_id,
         c.client_name
       FROM ff_shipments s
       LEFT JOIN clients c ON c.id = s.client_id AND c.company_id = s.company_id
       ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    return paginated(result.rows, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error: unknown) {
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch shipments"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "FF")
    requirePermission(session, "freight.manage")

    const payload = freightShipmentCreateSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const shipmentNo = await generateFreightShipmentNumber(db, session.companyId)
    const inserted = await db.query(
      `INSERT INTO ff_shipments (
         company_id, shipment_no, mode, direction, status, client_id, shipper_name, consignee_name,
         incoterm, origin, destination, etd, eta, remarks, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14,$15,$15
       )
       RETURNING *`,
      [
        session.companyId,
        shipmentNo,
        payload.mode,
        payload.direction || "EXPORT",
        payload.status || "DRAFT",
        payload.client_id ?? null,
        payload.shipper_name || null,
        payload.consignee_name || null,
        payload.incoterm || null,
        payload.origin,
        payload.destination,
        toNullableTimestamp(payload.etd),
        toNullableTimestamp(payload.eta),
        payload.remarks || null,
        session.userId,
      ]
    )

    await db.query("COMMIT")
    return ok(inserted.rows[0], "Shipment created successfully")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardProductError(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to create shipment"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
