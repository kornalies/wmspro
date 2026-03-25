import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function PATCH(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "gate.in.create")

    const { id } = await context.params
    const gateInId = Number(id)
    if (!gateInId) return fail("VALIDATION_ERROR", "Invalid gate-in id", 400)

    const result = await query(
      `UPDATE gate_in
       SET departure_datetime = CURRENT_TIMESTAMP,
           status = CASE WHEN status = 'PENDING' THEN 'COMPLETED' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, gate_in_number, departure_datetime, status`,
      [gateInId]
    )

    if (!result.rows.length) return fail("NOT_FOUND", "Gate In record not found", 404)
    return ok(result.rows[0], "Out time recorded")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to record out time"
    return fail("UPDATE_FAILED", message, 400)
  }
}
