import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { clientSchema } from "@/lib/validations"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }

    const { searchParams } = new URL(request.url)
    const isActive = searchParams.get("is_active")
    const params: Array<string | boolean | number> = []

    let sql = `
      SELECT
        c.id,
        c.client_code,
        c.client_name,
        c.contact_person,
        c.contact_email,
        c.contact_phone,
        c.registered_address AS address,
        c.city,
        c.state,
        c.pincode,
        c.gst_number,
        c.pan_number,
        c.is_active,
        cc.contract_code,
        cc.effective_from,
        cc.effective_to,
        cc.storage_rate_per_unit,
        cc.handling_rate_per_unit,
        cc.minimum_guarantee_amount,
        cc.billing_cycle AS billing_terms,
        cc.currency AS contract_currency
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT
          contract_code,
          effective_from,
          effective_to,
          storage_rate_per_unit,
          handling_rate_per_unit,
          minimum_guarantee_amount,
          billing_cycle,
          currency
        FROM client_contracts
        WHERE company_id = c.company_id
          AND client_id = c.id
          AND is_active = true
        ORDER BY effective_from DESC, created_at DESC
        LIMIT 1
      ) cc ON true
      WHERE c.company_id = $1
    `
    params.push(session.companyId)

    if (isActive !== null) {
      params.push(isActive === "true")
      sql += ` AND c.is_active = $2`
    }

    sql += ` ORDER BY c.client_name ASC`

    const result = await query(sql, params)

    return ok(result.rows)
  } catch (error: unknown) {
    console.error("Clients fetch error:", error)
    const message = error instanceof Error ? error.message : "Failed to fetch clients"
    return fail("SERVER_ERROR", message, 500)
  }
}

const clientUpdateSchema = clientSchema.extend({
  id: z.number().positive(),
  is_active: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = clientSchema.parse(await request.json())

    const result = await query(
      `INSERT INTO clients (
        company_id, client_code, client_name, company_legal_name,
        contact_person, contact_email, contact_phone,
        gst_number, pan_number, registered_address, city, state, pincode, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
      RETURNING *`,
      [
        session.companyId,
        payload.client_code,
        payload.client_name,
        payload.client_name,
        payload.contact_person || null,
        payload.contact_email || null,
        payload.contact_phone || null,
        payload.gst_number || null,
        payload.pan_number || null,
        payload.address || null,
        payload.city || null,
        payload.state || null,
        payload.pincode || null,
      ]
    )

    return ok(result.rows[0], "Client created successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create client"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = clientUpdateSchema.parse(await request.json())

    const result = await query(
      `UPDATE clients SET
        client_code = $1,
        client_name = $2,
        company_legal_name = $3,
        contact_person = $4,
        contact_email = $5,
        contact_phone = $6,
        gst_number = $7,
        pan_number = $8,
        registered_address = $9,
        city = $10,
        state = $11,
        pincode = $12,
        is_active = $13
      WHERE id = $14 AND company_id = $15
      RETURNING *`,
      [
        payload.client_code,
        payload.client_name,
        payload.client_name,
        payload.contact_person || null,
        payload.contact_email || null,
        payload.contact_phone || null,
        payload.gst_number || null,
        payload.pan_number || null,
        payload.address || null,
        payload.city || null,
        payload.state || null,
        payload.pincode || null,
        payload.is_active ?? true,
        payload.id,
        session.companyId,
      ]
    )

    return ok(result.rows[0], "Client updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update client"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Client id is required", 400)

    await query("UPDATE clients SET is_active = false WHERE id = $1 AND company_id = $2", [
      id,
      session.companyId,
    ])
    return ok({ id }, "Client deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete client"
    return fail("DELETE_FAILED", message, 400)
  }
}
