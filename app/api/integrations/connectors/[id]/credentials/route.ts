import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { encryptSecret } from "@/lib/secret-box"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

const credentialSchema = z.object({
  credential_key: z.string().trim().min(2).max(80),
  credential_value: z.string().min(1).max(4000),
})

type Params = {
  params: Promise<{ id: string }>
}

export async function GET(_: NextRequest, { params }: Params) {
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const connectorId = Number((await params).id || 0)
    if (!connectorId) return fail("VALIDATION_ERROR", "Invalid connector id", 400)

    const result = await query(
      `SELECT
         id,
         connector_id,
         credential_key,
         is_active,
         last_rotated_at,
         created_at,
         updated_at
       FROM integration_connector_credentials
       WHERE company_id = $1
         AND connector_id = $2
       ORDER BY credential_key ASC`,
      [access.companyId, connectorId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch connector credentials"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const connectorId = Number((await params).id || 0)
    if (!connectorId) return fail("VALIDATION_ERROR", "Invalid connector id", 400)

    const payload = credentialSchema.parse(await request.json())
    const encrypted = encryptSecret(payload.credential_value)

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const exists = await db.query(
      `SELECT id
       FROM integration_connectors
       WHERE company_id = $1
         AND id = $2
       LIMIT 1`,
      [access.companyId, connectorId]
    )
    if (!exists.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Connector not found", 404)
    }

    const result = await db.query(
      `INSERT INTO integration_connector_credentials (
         company_id,
         connector_id,
         credential_key,
         credential_value_encrypted,
         is_active,
         last_rotated_at,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,true,NOW(),$5,$5)
       ON CONFLICT (company_id, connector_id, credential_key)
       DO UPDATE SET
         credential_value_encrypted = EXCLUDED.credential_value_encrypted,
         is_active = true,
         last_rotated_at = NOW(),
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, connector_id, credential_key, is_active, last_rotated_at`,
      [access.companyId, connectorId, payload.credential_key.toUpperCase(), encrypted, access.userId]
    )

    const row = result.rows[0]
    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.credential.rotate",
        entityType: "integration_connector_credentials",
        entityId: String(row.id),
        after: { connector_id: row.connector_id, credential_key: row.credential_key },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(row, "Credential saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save credential"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
