import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

const payloadSchema = z.object({
  query: z.string().trim().min(1, "query is required"),
  limit: z.number().int().min(1).max(100).optional(),
})

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = payloadSchema.parse(await request.json())
    const limit = payload.limit || 25

    const result = await query(
      `SELECT id, item_code, item_name, uom, is_active
       FROM items
       WHERE is_active = true
         AND (item_code ILIKE $1 OR item_name ILIKE $1)
       ORDER BY item_name ASC
       LIMIT $2`,
      [`%${payload.query}%`, limit]
    )

    return ok({
      query: payload.query,
      count: result.rowCount || 0,
      items: result.rows,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to lookup items"
    return fail("LOOKUP_FAILED", message, 400)
  }
}

