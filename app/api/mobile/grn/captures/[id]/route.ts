import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMobileGrnCaptureSchema } from "@/lib/db-bootstrap"
import { fail, ok } from "@/lib/api-response"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(_: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    await ensureMobileGrnCaptureSchema()
    const { id } = await context.params

    const result = await query(
      `SELECT
        id, capture_ref, status, notes, approved_grn_id, created_at, updated_at, payload
      FROM mobile_grn_captures
      WHERE id = $1`,
      [id]
    )

    if (!result.rows.length) return fail("NOT_FOUND", "Capture not found", 404)
    return ok(result.rows[0])
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch mobile GRN capture"
    return fail("SERVER_ERROR", message, 500)
  }
}
