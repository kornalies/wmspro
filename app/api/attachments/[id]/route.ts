import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail } from "@/lib/api-response"
import { query } from "@/lib/db"

type RouteContext = {
  params: Promise<{ id: string }>
}

function safeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { id } = await context.params
    const attachmentId = Number(id)
    if (!attachmentId) return fail("VALIDATION_ERROR", "Invalid attachment id", 400)

    const result = await query(
      `SELECT file_name, content_type, file_data
       FROM attachments
       WHERE id = $1 AND company_id = $2
       LIMIT 1`,
      [attachmentId, session.companyId]
    )

    if (!result.rows.length) return fail("NOT_FOUND", "Attachment not found", 404)
    const row = result.rows[0] as {
      file_name: string
      content_type: string | null
      file_data: Buffer | null
    }

    if (!row.file_data) return fail("NOT_FOUND", "Attachment file content not found", 404)

    return new Response(new Uint8Array(row.file_data), {
      status: 200,
      headers: {
        "content-type": row.content_type || "application/octet-stream",
        "content-disposition": `attachment; filename="${safeFilename(row.file_name || "attachment.bin")}"`,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to download attachment"
    return fail("SERVER_ERROR", message, 500)
  }
}
