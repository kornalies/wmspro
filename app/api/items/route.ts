import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { itemSchema } from "@/lib/validations"
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
      SELECT id, item_code, item_name, category_id, hsn_code, uom, standard_mrp, min_stock_alert, is_active
      FROM items
      WHERE company_id = $1
    `
    params.push(session.companyId)

    if (isActive !== null) {
      params.push(isActive === "true")
      sql += ` AND is_active = $2`
    }

    sql += ` ORDER BY item_name ASC`

    const result = await query(sql, params)

    return ok(result.rows)
  } catch (error: unknown) {
    console.error("Items fetch error:", error)
    const message = error instanceof Error ? error.message : "Failed to fetch items"
    return fail("SERVER_ERROR", message, 500)
  }
}

const itemUpdateSchema = itemSchema.extend({
  id: z.number().positive(),
  is_active: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = itemSchema.parse(await request.json())
    const result = await query(
      `INSERT INTO items (
        company_id, item_code, item_name, category_id, hsn_code, uom, standard_mrp, min_stock_alert, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
      RETURNING *`,
      [
        session.companyId,
        payload.item_code,
        payload.item_name,
        payload.category_id || null,
        payload.hsn_code || null,
        payload.uom,
        payload.standard_mrp || null,
        payload.min_stock_alert || null,
      ]
    )

    return ok(result.rows[0], "Item created successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create item"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = itemUpdateSchema.parse(await request.json())
    const result = await query(
      `UPDATE items SET
        item_code = $1,
        item_name = $2,
        category_id = $3,
        hsn_code = $4,
        uom = $5,
        standard_mrp = $6,
        min_stock_alert = $7,
        is_active = $8
      WHERE id = $9 AND company_id = $10
      RETURNING *`,
      [
        payload.item_code,
        payload.item_name,
        payload.category_id || null,
        payload.hsn_code || null,
        payload.uom,
        payload.standard_mrp || null,
        payload.min_stock_alert || null,
        payload.is_active ?? true,
        payload.id,
        session.companyId,
      ]
    )

    return ok(result.rows[0], "Item updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update item"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Item id is required", 400)

    await query("UPDATE items SET is_active = false WHERE id = $1 AND company_id = $2", [
      id,
      session.companyId,
    ])
    return ok({ id }, "Item deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete item"
    return fail("DELETE_FAILED", message, 400)
  }
}
