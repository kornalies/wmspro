import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMobileGrnCaptureSchema } from "@/lib/db-bootstrap"
import { mobileGrnCaptureSchema } from "@/lib/validations/mobile-grn"
import { fail, ok } from "@/lib/api-response"

function captureRef() {
  return `MGRN-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "grn.mobile.approve")

    await ensureMobileGrnCaptureSchema()

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || "PENDING"

    const result = await query(
      `SELECT
        id,
        capture_ref,
        status,
        notes,
        approved_grn_id,
        created_at,
        updated_at,
        payload->'header'->>'invoice_number' AS invoice_number,
        payload->'header'->>'supplier_name' AS supplier_name
      FROM mobile_grn_captures
      WHERE ($1 = 'ALL' OR status = $1)
      ORDER BY created_at DESC`,
      [status]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch mobile GRN captures"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    requirePermission(session, "grn.mobile.approve")

    await ensureMobileGrnCaptureSchema()

    const body = await request.json()
    const parsed = mobileGrnCaptureSchema.parse(body)
    const ref = captureRef()

    const result = await query(
      `INSERT INTO mobile_grn_captures (capture_ref, payload, notes, created_by)
       VALUES ($1, $2::jsonb, $3, $4)
       RETURNING id, capture_ref, status, created_at`,
      [ref, JSON.stringify(parsed), parsed.notes || null, session.userId]
    )

    return ok(result.rows[0], "Mobile GRN captured successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to capture mobile GRN"
    return fail("VALIDATION_OR_CREATE_ERROR", message, 400)
  }
}
