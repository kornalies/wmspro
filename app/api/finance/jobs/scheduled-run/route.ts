import { timingSafeEqual } from "node:crypto"
import { NextRequest } from "next/server"

import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import {
  createStorageSnapshot,
  generateInvoiceDraftsByBillingCycle,
  normalizeShard,
  type BillingShard,
} from "@/lib/billing-service"

// System entry point for the billing schedule. Every other job route in this
// folder is session-scoped to the caller's own tenant, which is why nothing was
// ever scheduled: a cron has no session and no tenant. This route authenticates
// with a shared secret instead and fans out over every active company.
//
// It deliberately does NOT run under a user session, so it cannot rely on
// requirePermission. The secret is the whole authorisation boundary -- treat it
// like a deploy key.

type JobName = "storage-snapshot" | "invoice-cycle-run"

const ALL_JOBS: JobName[] = ["storage-snapshot", "invoice-cycle-run"]

function isAuthorised(request: NextRequest) {
  const configured = process.env.BILLING_CRON_SECRET
  if (!configured || !configured.trim()) return "disabled" as const

  const presented = request.headers.get("x-cron-secret") || ""
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(configured, "utf8")
  // timingSafeEqual throws on length mismatch, and the length itself is not
  // secret enough to be worth padding for -- reject and move on.
  if (a.length !== b.length) return "denied" as const
  return timingSafeEqual(a, b) ? ("ok" as const) : ("denied" as const)
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}

export async function POST(request: NextRequest) {
  const auth = isAuthorised(request)
  if (auth === "disabled") {
    return fail(
      "CRON_DISABLED",
      "Scheduled billing runs are not configured. Set BILLING_CRON_SECRET to enable them.",
      503
    )
  }
  if (auth === "denied") return fail("UNAUTHORIZED", "Unauthorized", 401)

  const body = (await request.json().catch(() => ({}))) as {
    run_date?: string
    jobs?: string[]
    company_id?: number
    shard?: { index?: number; count?: number }
  }

  const runDate = body.run_date || new Date().toISOString().slice(0, 10)
  if (!isIsoDate(runDate)) {
    return fail("VALIDATION_ERROR", "run_date must be YYYY-MM-DD", 400)
  }

  let shard: BillingShard | null = null
  try {
    shard = normalizeShard(body.shard)
  } catch (error: unknown) {
    return fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid shard", 400)
  }

  const requested = body.jobs?.length ? body.jobs : ALL_JOBS
  const unknown = requested.filter((job) => !ALL_JOBS.includes(job as JobName))
  if (unknown.length) {
    return fail("VALIDATION_ERROR", `Unknown job(s): ${unknown.join(", ")}`, 400)
  }
  // Snapshot before invoicing, always: storage charges for the day have to exist
  // as billing_transactions before the cycle run can sweep them onto an invoice.
  // Running these in the other order silently under-bills storage by one cycle.
  let jobs = ALL_JOBS.filter((job) => requested.includes(job))

  // The snapshot is one set-based statement per tenant covering all of its stock,
  // so it is not shardable and does not need to be. Running it in every shard
  // would repeat the same work N times; shard 0 owns it, and the other shards do
  // only the part that actually splits.
  if (shard && shard.index !== 0) {
    jobs = jobs.filter((job) => job !== "storage-snapshot")
  }

  const db = await getClient()
  const results: Array<{
    company_id: number
    company_code: string
    job: JobName
    status: "SUCCESS" | "FAILED"
    detail: unknown
  }> = []

  try {
    const companiesRes = await db.query(
      body.company_id
        ? `SELECT id, company_code FROM companies WHERE is_active = true AND id = $1 ORDER BY id`
        : `SELECT id, company_code FROM companies WHERE is_active = true ORDER BY id`,
      body.company_id ? [body.company_id] : []
    )

    for (const company of companiesRes.rows) {
      const companyId = Number(company.id)
      for (const job of jobs) {
        // One tenant's failure must not abort the fan-out -- a single tenant with
        // a broken rate card would otherwise stop every later tenant from being
        // invoiced at all, and the run would look like it had simply not happened.
        const outcome = await runJob(db, job, companyId, runDate, shard)
        results.push({
          company_id: companyId,
          company_code: String(company.company_code),
          job,
          status: outcome.ok ? "SUCCESS" : "FAILED",
          detail: outcome.ok ? outcome.summary : outcome.error,
        })
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Scheduled billing run failed"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }

  const failures = results.filter((r) => r.status === "FAILED")
  return ok(
    {
      run_date: runDate,
      jobs,
      shard,
      company_count: new Set(results.map((r) => r.company_id)).size,
      failed_count: failures.length,
      results,
    },
    failures.length
      ? `Scheduled billing run completed with ${failures.length} failure(s)`
      : "Scheduled billing run completed"
  )
}

type DbClient = Awaited<ReturnType<typeof getClient>>

async function runJob(
  db: DbClient,
  job: JobName,
  companyId: number,
  runDate: string,
  shard: BillingShard | null
) {
  const jobType = job === "storage-snapshot" ? "STORAGE_SNAPSHOT" : "INVOICE_CYCLE_RUN"
  // The shard is part of the run key. Without it, shard 1 would see shard 0's
  // billing_job_runs row for the day, conclude the job had already run, and the
  // audit trail would record one run where N happened.
  const runKey = shard
    ? `CRON-${jobType}-${runDate}-S${shard.index}of${shard.count}`
    : `CRON-${jobType}-${runDate}`

  // The RUNNING row is committed on its own so that a job which throws still
  // leaves a FAILED record behind. Recording it inside the job's transaction
  // would roll the evidence back together with the work.
  await withTransaction(db, companyId, async () => {
    await db.query(
      `INSERT INTO billing_job_runs (company_id, job_type, run_key, status, details, created_by)
       VALUES ($1, $2, $3, 'RUNNING', $4::jsonb, NULL)
       ON CONFLICT (company_id, job_type, run_key) DO NOTHING`,
      [companyId, jobType, runKey, JSON.stringify({ runDate, trigger: "cron", shard })]
    )
  })

  try {
    const summary = await withTransaction(db, companyId, async () => {
      if (job === "storage-snapshot") {
        await createStorageSnapshot(db, { companyId, snapshotDate: runDate, runKey })
        return { snapshot_date: runDate }
      }
      return await generateInvoiceDraftsByBillingCycle(db, {
        companyId,
        runDate,
        runKeyPrefix: runKey,
        clientId: null,
        shard,
      })
    })

    await withTransaction(db, companyId, async () => {
      await db.query(
        `UPDATE billing_job_runs
         SET status = 'SUCCESS',
             finished_at = CURRENT_TIMESTAMP,
             details = COALESCE(details, '{}'::jsonb) || $1::jsonb
         WHERE company_id = $2 AND job_type = $3 AND run_key = $4`,
        [JSON.stringify(summary), companyId, jobType, runKey]
      )
    })

    return { ok: true as const, summary }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Job failed"
    await withTransaction(db, companyId, async () => {
      await db.query(
        `UPDATE billing_job_runs
         SET status = 'FAILED',
             finished_at = CURRENT_TIMESTAMP,
             details = COALESCE(details, '{}'::jsonb) || $1::jsonb
         WHERE company_id = $2 AND job_type = $3 AND run_key = $4`,
        [JSON.stringify({ error: message }), companyId, jobType, runKey]
      )
    }).catch(() => {
      // The failure is still reported in the HTTP response; losing the audit
      // row must not turn one tenant's problem into a 500 for the whole run.
    })
    return { ok: false as const, error: message }
  }
}

async function withTransaction<T>(db: DbClient, companyId: number, work: () => Promise<T>) {
  await db.query("BEGIN")
  try {
    // Tenant context is transaction-scoped (set_config with is_local = true), so
    // it must be re-applied inside every transaction, not once per connection.
    await setTenantContext(db, companyId)
    const result = await work()
    await db.query("COMMIT")
    return result
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  }
}
