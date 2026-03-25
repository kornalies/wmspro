import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const queued = await db.query(
      `SELECT
         e.id,
         e.connector_id,
         e.attempt_count,
         c.retry_limit,
         c.retry_backoff_seconds,
         c.dead_letter_after
       FROM integration_events e
       JOIN integration_connectors c ON c.id = e.connector_id AND c.company_id = e.company_id
       WHERE e.company_id = $1
         AND e.status IN ('QUEUED', 'RETRY')
         AND (e.next_retry_at IS NULL OR e.next_retry_at <= NOW())
       ORDER BY e.created_at ASC
       LIMIT 100`,
      [access.companyId]
    )

    let successCount = 0
    let retryCount = 0
    let deadLetterCount = 0

    for (const row of queued.rows as Array<{
      id: number
      attempt_count: number
      retry_limit: number
      retry_backoff_seconds: number
      dead_letter_after: number
    }>) {
      const nextAttempt = Number(row.attempt_count || 0) + 1
      const shouldSucceed = nextAttempt % 3 !== 0

      if (shouldSucceed) {
        await db.query(
          `UPDATE integration_events
           SET status = 'SUCCESS',
               attempt_count = $1,
               response_payload = jsonb_build_object('ok', true, 'processed_at', NOW()),
               processed_at = NOW(),
               next_retry_at = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [nextAttempt, access.companyId, row.id]
        )
        successCount += 1
      } else if (nextAttempt >= Number(row.dead_letter_after || 5)) {
        await db.query(
          `UPDATE integration_events
           SET status = 'DEAD_LETTER',
               attempt_count = $1,
               last_error = 'Connector delivery failed in processor simulation',
               next_retry_at = NULL,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [nextAttempt, access.companyId, row.id]
        )
        deadLetterCount += 1
      } else {
        const cappedBackoff = Math.max(5, Math.min(Number(row.retry_backoff_seconds || 60), 86400))
        await db.query(
          `UPDATE integration_events
           SET status = 'RETRY',
               attempt_count = $1,
               last_error = 'Connector delivery failed in processor simulation',
               next_retry_at = NOW() + ($4::text || ' seconds')::interval,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [nextAttempt, access.companyId, row.id, String(cappedBackoff)]
        )
        retryCount += 1
      }
    }

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.processor.run",
        entityType: "integration_events",
        after: {
          processed: queued.rows.length,
          success: successCount,
          retry: retryCount,
          dead_letter: deadLetterCount,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({
      processed: queued.rows.length,
      success: successCount,
      retry: retryCount,
      dead_letter: deadLetterCount,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to process integration queue"
    return fail("PROCESS_FAILED", message, 400)
  } finally {
    db.release()
  }
}
