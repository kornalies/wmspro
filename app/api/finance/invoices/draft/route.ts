import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { generateInvoiceDrafts, generateInvoiceDraftsByBillingCycle } from "@/lib/billing-service"
import { writeAudit } from "@/lib/audit"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

type InvoiceConflict = {
  clientId: number
  invoiceId: number
  invoiceNumber: string
  status: string
  periodFrom: string
  periodTo: string
}

type DraftSummary = {
  generatedCount: number
  conflicts: InvoiceConflict[]
}

type CycleSummary = DraftSummary & {
  dueClientCount: number
  profileCount: number
  skippedCount: number
}

function isCycleSummary(value: DraftSummary | CycleSummary): value is CycleSummary {
  return (
    "dueClientCount" in value &&
    "profileCount" in value &&
    "skippedCount" in value
  )
}

function getMonthRange(period: string) {
  const [y, m] = period.split("-").map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1))
  const to = new Date(Date.UTC(y, m, 0))
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "billing")
    if (policy.permissions.includes("billing.generate_invoice")) {
      requirePolicyPermission(policy, "billing.generate_invoice")
    } else {
      requirePolicyPermission(policy, "finance.view")
    }

    const body = (await request.json().catch(() => ({}))) as {
      period?: string
      period_from?: string
      period_to?: string
      client_id?: number
      run_key?: string
      auto_cycle?: boolean
      run_date?: string
    }

    // An explicit window is honoured as given. With none supplied we must NOT fall back to the
    // calendar month: a client on a WEEKLY profile then gets a month-long invoice whose period
    // straddles the weekly invoices its own cycle produces. Deriving the window per client from
    // client_billing_profile is what the cycle path already does, so default to it.
    const monthPeriod = body.period && /^\d{4}-\d{2}$/.test(body.period) ? body.period : null
    const month = monthPeriod ? getMonthRange(monthPeriod) : null
    const explicitPeriod = !!monthPeriod || !!body.period_from || !!body.period_to
    const periodFrom = body.period_from || month?.from || ""
    const periodTo = body.period_to || month?.to || ""
    const autoCycle = body.auto_cycle === true || !explicitPeriod
    // A half-specified window used to be silently completed from the calendar month, which
    // invented an end date the caller never asked to invoice through.
    if (!autoCycle && (!periodFrom || !periodTo)) {
      return fail("VALIDATION_ERROR", "period_from and period_to must both be supplied", 400)
    }
    const runDate = body.run_date || new Date().toISOString().slice(0, 10)
    const runKey = body.run_key || (autoCycle ? `INV-CYCLE-${runDate}` : `INV-DRAFT-${periodFrom}-${periodTo}`)
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = autoCycle
      ? `finance.invoices.draft.cycle:${runDate}:${body.client_id || "all"}`
      : `finance.invoices.draft:${periodFrom}:${periodTo}:${body.client_id || "all"}`
    if (idempotencyKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
      })
      if (cached) {
        return ok(cached.body as Record<string, unknown>, "Idempotent replay")
      }
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    await db.query(
      `INSERT INTO billing_job_runs (company_id, job_type, run_key, status, details, created_by)
       VALUES ($1, 'INVOICE_DRAFT', $2, 'RUNNING', $3::jsonb, $4)
       ON CONFLICT (company_id, job_type, run_key)
       DO NOTHING`,
      [
        session.companyId,
        runKey,
        JSON.stringify(autoCycle ? { runDate, clientId: body.client_id || null, mode: "CYCLE" } : { periodFrom, periodTo, clientId: body.client_id || null }),
        session.userId,
      ]
    )

    const summary: DraftSummary | CycleSummary = autoCycle
      ? await generateInvoiceDraftsByBillingCycle(db, {
          companyId: session.companyId,
          userId: session.userId,
          runDate,
          runKeyPrefix: runKey,
          clientId: body.client_id || null,
        })
      : await generateInvoiceDrafts(db, {
          companyId: session.companyId,
          userId: session.userId,
          periodFrom,
          periodTo,
          clientId: body.client_id || null,
          runKey,
        })

    await db.query(
      `UPDATE billing_job_runs
       SET status = 'SUCCESS',
           finished_at = CURRENT_TIMESTAMP,
           details = COALESCE(details, '{}'::jsonb) || $1::jsonb
       WHERE company_id = $2
         AND job_type = 'INVOICE_DRAFT'
         AND run_key = $3`,
      [
        JSON.stringify(
          autoCycle
            ? summary
            : {
                generatedCount: summary.generatedCount,
                conflictCount: summary.conflicts.length,
                conflicts: summary.conflicts,
              }
        ),
        session.companyId,
        runKey,
      ]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "billing.generate_invoice",
        entityType: "billing_job_runs",
        entityId: runKey,
        after: {
          ...(autoCycle ? { runDate, mode: "CYCLE" } : { periodFrom, periodTo }),
          generatedCount: summary.generatedCount,
          conflictCount: summary.conflicts.length,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    const responseBody = {
      run_key: runKey,
      // A cycle run has no single window — each client got its own — so reporting one would be a
      // fiction, and reporting "" reads as a window that failed to resolve.
      ...(autoCycle ? { run_date: runDate, mode: "CYCLE" } : { period_from: periodFrom, period_to: periodTo }),
      generated_count: summary.generatedCount,
      // Clients skipped because the requested window overlaps an invoice they already have.
      // Reported rather than thrown so one misconfigured client cannot abort the run for the rest.
      conflict_count: summary.conflicts.length,
      conflicts: summary.conflicts.map((c) => ({
        client_id: c.clientId,
        invoice_id: c.invoiceId,
        invoice_number: c.invoiceNumber,
        status: c.status,
        period_from: c.periodFrom,
        period_to: c.periodTo,
      })),
      ...(autoCycle && isCycleSummary(summary)
        ? {
            due_client_count: summary.dueClientCount,
            profile_count: summary.profileCount,
            skipped_count: summary.skippedCount,
          }
        : {}),
    }
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Invoice drafts generated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to generate invoice drafts"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}


