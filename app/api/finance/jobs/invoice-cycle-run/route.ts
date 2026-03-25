import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { generateInvoiceDraftsByBillingCycle } from "@/lib/billing-service"

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const body = (await request.json().catch(() => ({}))) as {
      run_date?: string
      run_key?: string
      client_id?: number
    }
    const runDate = body.run_date || new Date().toISOString().slice(0, 10)
    const runKey = body.run_key || `INVOICE-CYCLE-RUN-${runDate}`

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    await db.query(
      `INSERT INTO billing_job_runs (company_id, job_type, run_key, status, details, created_by)
       VALUES ($1, 'INVOICE_CYCLE_RUN', $2, 'RUNNING', $3::jsonb, $4)
       ON CONFLICT (company_id, job_type, run_key)
       DO NOTHING`,
      [session.companyId, runKey, JSON.stringify({ runDate, clientId: body.client_id || null }), session.userId]
    )

    const summary = await generateInvoiceDraftsByBillingCycle(db, {
      companyId: session.companyId,
      userId: session.userId,
      runDate,
      runKeyPrefix: runKey,
      clientId: body.client_id || null,
    })

    await db.query(
      `UPDATE billing_job_runs
       SET status = 'SUCCESS',
           finished_at = CURRENT_TIMESTAMP,
           details = COALESCE(details, '{}'::jsonb) || $1::jsonb
       WHERE company_id = $2
         AND job_type = 'INVOICE_CYCLE_RUN'
         AND run_key = $3`,
      [JSON.stringify(summary), session.companyId, runKey]
    )

    await db.query("COMMIT")
    return ok(
      {
        run_date: runDate,
        run_key: runKey,
        generated_count: summary.generatedCount,
        due_client_count: summary.dueClientCount,
        profile_count: summary.profileCount,
        skipped_count: summary.skippedCount,
      },
      "Invoice cycle run completed"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to run invoice cycle job"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}

