import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { createStorageSnapshot } from "@/lib/billing-service"

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const body = (await request.json().catch(() => ({}))) as { snapshot_date?: string; run_key?: string }
    const snapshotDate = body.snapshot_date || new Date().toISOString().slice(0, 10)
    const runKey = body.run_key || `STORAGE-SNAPSHOT-${snapshotDate}`

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    await db.query(
      `INSERT INTO billing_job_runs (company_id, job_type, run_key, status, details, created_by)
       VALUES ($1, 'STORAGE_SNAPSHOT', $2, 'RUNNING', $3::jsonb, $4)
       ON CONFLICT (company_id, job_type, run_key)
       DO NOTHING`,
      [session.companyId, runKey, JSON.stringify({ snapshotDate }), session.userId]
    )

    await createStorageSnapshot(db, {
      companyId: session.companyId,
      snapshotDate,
      userId: session.userId,
      runKey,
    })

    await db.query(
      `UPDATE billing_job_runs
       SET status = 'SUCCESS',
           finished_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND job_type = 'STORAGE_SNAPSHOT'
         AND run_key = $2`,
      [session.companyId, runKey]
    )

    await db.query("COMMIT")
    return ok({ snapshot_date: snapshotDate, run_key: runKey }, "Storage snapshot completed")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to run storage snapshot"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}


