import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

type Params = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, { params }: Params) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const eventId = Number((await params).id || 0)
    if (!eventId) return fail("VALIDATION_ERROR", "Invalid event id", 400)

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const result = await db.query(
      `UPDATE integration_events
       SET status = 'QUEUED',
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE company_id = $1
         AND id = $2
         AND status IN ('DEAD_LETTER', 'RETRY')
       RETURNING id, connector_id, status`,
      [access.companyId, eventId]
    )
    if (!result.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Retry-eligible event not found", 404)
    }

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.event.retry",
        entityType: "integration_events",
        entityId: String(eventId),
        after: result.rows[0],
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(result.rows[0], "Event moved to queue")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to retry event"
    return fail("RETRY_FAILED", message, 400)
  } finally {
    db.release()
  }
}
