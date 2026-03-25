import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { normalizeDOStatus } from "@/lib/do-status"

const payloadSchema = z.object({
  barcode: z.string().trim().min(1, "barcode is required"),
})

function inferBarcodeKind(value: string): "DO_NUMBER" | "SERIAL" | "UNKNOWN" {
  const upper = value.toUpperCase()
  if (upper.startsWith("DO-")) return "DO_NUMBER"
  if (upper.startsWith("SER-")) return "SERIAL"
  return "UNKNOWN"
}

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = payloadSchema.parse(await request.json())
    const barcode = payload.barcode.trim()
    const kind = inferBarcodeKind(barcode)

    const doResult = await query(
      `SELECT
         id,
         do_number,
         client_id,
         warehouse_id,
         request_date,
         dispatch_date,
         status,
         total_items,
         total_quantity_requested,
         total_quantity_dispatched
       FROM do_header
       WHERE company_id = $1
         AND (do_number = $2 OR do_number ILIKE $3)
       ORDER BY id DESC
       LIMIT 1`,
      [session.companyId, barcode, `%${barcode}%`]
    )

    const doHeader = doResult.rows[0]
    return ok({
      barcode,
      parsed: {
        kind,
        value: barcode,
      },
      do_header: doHeader
        ? {
            ...doHeader,
            status: normalizeDOStatus(doHeader.status) || doHeader.status,
          }
        : null,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to parse DO barcode"
    return fail("PARSE_FAILED", message, 400)
  }
}
