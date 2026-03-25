import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

const createSchema = z.object({
  client_id: z.number().positive(),
  contract_code: z.string().min(2).max(50),
  effective_from: z.string().min(10),
  effective_to: z.string().optional().or(z.literal("")),
  storage_rate_per_unit: z.number().min(0),
  handling_rate_per_unit: z.number().min(0),
  minimum_guarantee_amount: z.number().min(0),
  billing_cycle: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  currency: z.string().min(3).max(10).optional(),
  notes: z.string().optional(),
  is_active: z.boolean().optional(),
})

const updateSchema = createSchema.extend({
  id: z.number().positive(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const { searchParams } = new URL(request.url)
    const clientId = Number(searchParams.get("client_id") || 0)
    const isActive = searchParams.get("is_active")

    const where: string[] = ["cc.company_id = $1"]
    const params: Array<number | boolean> = [session.companyId]

    if (clientId) {
      params.push(clientId)
      where.push(`cc.client_id = $${params.length}`)
    }
    if (isActive !== null) {
      params.push(isActive === "true")
      where.push(`cc.is_active = $${params.length}`)
    }

    const result = await query(
      `SELECT
         cc.*,
         c.client_name,
         c.client_code
       FROM client_contracts cc
       JOIN clients c ON c.id = cc.client_id
       WHERE ${where.join(" AND ")}
       ORDER BY cc.effective_from DESC, cc.created_at DESC`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch contracts"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const payload = createSchema.parse(await request.json())

    const result = await query(
      `INSERT INTO client_contracts (
         company_id, client_id, contract_code, effective_from, effective_to,
         storage_rate_per_unit, handling_rate_per_unit, minimum_guarantee_amount,
         billing_cycle, currency, notes, is_active, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
       )
       RETURNING *`,
      [
        session.companyId,
        payload.client_id,
        payload.contract_code.toUpperCase(),
        payload.effective_from,
        payload.effective_to || null,
        payload.storage_rate_per_unit,
        payload.handling_rate_per_unit,
        payload.minimum_guarantee_amount,
        payload.billing_cycle || "MONTHLY",
        (payload.currency || "INR").toUpperCase(),
        payload.notes || null,
        payload.is_active ?? true,
        session.userId,
      ]
    )

    return ok(result.rows[0], "Contract created successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create contract"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const payload = updateSchema.parse(await request.json())

    const result = await query(
      `UPDATE client_contracts
       SET client_id = $1,
           contract_code = $2,
           effective_from = $3,
           effective_to = $4,
           storage_rate_per_unit = $5,
           handling_rate_per_unit = $6,
           minimum_guarantee_amount = $7,
           billing_cycle = $8,
           currency = $9,
           notes = $10,
           is_active = $11,
           updated_by = $12,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $13 AND company_id = $14
       RETURNING *`,
      [
        payload.client_id,
        payload.contract_code.toUpperCase(),
        payload.effective_from,
        payload.effective_to || null,
        payload.storage_rate_per_unit,
        payload.handling_rate_per_unit,
        payload.minimum_guarantee_amount,
        payload.billing_cycle || "MONTHLY",
        (payload.currency || "INR").toUpperCase(),
        payload.notes || null,
        payload.is_active ?? true,
        session.userId,
        payload.id,
        session.companyId,
      ]
    )

    return ok(result.rows[0], "Contract updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update contract"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Contract id is required", 400)

    await query(
      `UPDATE client_contracts
       SET is_active = false, updated_by = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND company_id = $3`,
      [session.userId, id, session.companyId]
    )

    return ok({ id }, "Contract deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to deactivate contract"
    return fail("DELETE_FAILED", message, 400)
  }
}
