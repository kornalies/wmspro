import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

function isPermissionError(error: unknown) {
  return (
    error instanceof Error &&
    /permission denied|insufficient privilege|must be owner of (table|relation|function|schema)/i.test(
      error.message
    )
  )
}

async function ensureAttachmentsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        attachment_type VARCHAR(80) NOT NULL,
        reference_type VARCHAR(80) NOT NULL,
        reference_no VARCHAR(120) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        content_type VARCHAR(120),
        file_size_bytes BIGINT,
        file_data BYTEA,
        remarks TEXT,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await query(
      "CREATE INDEX IF NOT EXISTS idx_attachments_company_reference ON attachments(company_id, reference_type, reference_no)"
    )
  } catch (error) {
    // Runtime role should still work when DDL is pre-provisioned by migrator role.
    if (!isPermissionError(error)) throw error
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    await ensureAttachmentsTable()
    const { searchParams } = new URL(request.url)
    const referenceType = searchParams.get("referenceType")
    const referenceNo = searchParams.get("referenceNo")

    const conditions: string[] = []
    const params: Array<string | number> = []
    let idx = 1
    if (referenceType) {
      conditions.push(`reference_type = $${idx++}`)
      params.push(referenceType)
    }
    if (referenceNo) {
      conditions.push(`reference_no = $${idx++}`)
      params.push(referenceNo)
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const result = await query(
      `SELECT id, attachment_type, reference_type, reference_no, file_name, content_type, file_size_bytes, remarks, created_at
       FROM attachments
       ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch attachments"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    await ensureAttachmentsTable()
    const idemKey = request.headers.get("x-idempotency-key")
    if (idemKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idemKey,
        routeKey: "attachments.create",
      })
      if (cached) {
        return ok(cached.body as Record<string, unknown>, "Idempotent replay")
      }
    }
    const formData = await request.formData()

    const file = formData.get("file")
    if (!(file instanceof File)) {
      return fail("VALIDATION_ERROR", "file is required", 400)
    }
    if (file.size <= 0) {
      return fail("VALIDATION_ERROR", "file must not be empty", 400)
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return fail("VALIDATION_ERROR", "file size exceeds 10 MB limit", 400)
    }

    const attachmentType = String(formData.get("attachmentType") || "").trim()
    const referenceType = String(formData.get("referenceType") || "").trim()
    const referenceNo = String(formData.get("referenceNo") || "").trim()
    const remarks = String(formData.get("remarks") || "").trim()

    if (!attachmentType || !referenceType || !referenceNo) {
      return fail(
        "VALIDATION_ERROR",
        "attachmentType, referenceType, and referenceNo are required",
        400
      )
    }

    const bytes = Buffer.from(await file.arrayBuffer())

    const result = await query(
      `INSERT INTO attachments (
        company_id, attachment_type, reference_type, reference_no, file_name,
        content_type, file_size_bytes, file_data, remarks, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, attachment_type, reference_type, reference_no, file_name, content_type, file_size_bytes, remarks, created_at`,
      [
        session.companyId,
        attachmentType,
        referenceType,
        referenceNo,
        file.name,
        file.type || null,
        file.size,
        bytes,
        remarks || null,
        session.userId,
      ]
    )

    const responseBody = result.rows[0]
    if (idemKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idemKey,
        routeKey: "attachments.create",
        responseBody,
      })
    }
    return ok(responseBody, "Attachment metadata saved")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Attachment upload failed"
    return fail("UPLOAD_FAILED", message, 400)
  }
}
