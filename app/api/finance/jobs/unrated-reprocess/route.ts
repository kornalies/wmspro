import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { stageChargeTransaction } from "@/lib/billing-service"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

type UnratedRow = {
  id: number
  client_id: number
  warehouse_id: number | null
  charge_type:
    | "INBOUND_HANDLING"
    | "OUTBOUND_HANDLING"
    | "STORAGE"
    | "VAS"
    | "FIXED"
    | "MINIMUM"
    | "ADJUSTMENT"
  source_type: "GRN" | "DO" | "VAS" | "STORAGE" | "MANUAL"
  source_doc_id: number | null
  source_line_id: number | null
  source_ref_no: string | null
  event_date: string
  period_from: string | null
  period_to: string | null
  quantity: number
  uom: string | null
  remarks: string | null
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
      run_key?: string
      client_id?: number
      warehouse_id?: number
      date_from?: string
      date_to?: string
      limit?: number
    }

    const batchLimit = Math.max(1, Math.min(Number(body.limit || 200), 1000))
    const runKey =
      body.run_key ||
      `UNRATED-REPROCESS-${new Date().toISOString().replace(/[:.]/g, "-")}`
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = `finance.jobs.unrated-reprocess:${runKey}:${body.client_id || "all"}:${body.warehouse_id || "all"}:${body.date_from || "any"}:${body.date_to || "any"}:${batchLimit}`
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
       VALUES ($1, 'UNRATED_REPROCESS', $2, 'RUNNING', $3::jsonb, $4)
       ON CONFLICT (company_id, job_type, run_key)
       DO NOTHING`,
      [
        session.companyId,
        runKey,
        JSON.stringify({
          clientId: body.client_id || null,
          warehouseId: body.warehouse_id || null,
          dateFrom: body.date_from || null,
          dateTo: body.date_to || null,
          limit: batchLimit,
        }),
        session.userId,
      ]
    )

    const conditions: string[] = ["company_id = $1", "status = 'UNRATED'"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2
    if (body.client_id) {
      conditions.push(`client_id = $${idx++}`)
      params.push(Number(body.client_id))
    }
    if (body.warehouse_id) {
      conditions.push(`warehouse_id = $${idx++}`)
      params.push(Number(body.warehouse_id))
    }
    if (body.date_from) {
      conditions.push(`event_date >= $${idx++}::date`)
      params.push(body.date_from)
    }
    if (body.date_to) {
      conditions.push(`event_date <= $${idx++}::date`)
      params.push(body.date_to)
    }

    const unratedRes = await db.query(
      `SELECT
         id,
         client_id,
         warehouse_id,
         charge_type,
         source_type,
         source_doc_id,
         source_line_id,
         source_ref_no,
         event_date::text AS event_date,
         period_from::text AS period_from,
         period_to::text AS period_to,
         quantity,
         uom,
         remarks
       FROM billing_transactions
       WHERE ${conditions.join(" AND ")}
       ORDER BY event_date ASC, id ASC
       LIMIT $${idx}
       FOR UPDATE SKIP LOCKED`,
      [...params, batchLimit]
    )
    const rows = unratedRes.rows as UnratedRow[]
    const processedIds: number[] = []

    for (const tx of rows) {
      await stageChargeTransaction(db, {
        companyId: session.companyId,
        userId: session.userId,
        clientId: Number(tx.client_id),
        warehouseId: tx.warehouse_id == null ? null : Number(tx.warehouse_id),
        chargeType: tx.charge_type,
        sourceType: tx.source_type,
        sourceDocId: tx.source_doc_id == null ? null : Number(tx.source_doc_id),
        sourceLineId: tx.source_line_id == null ? null : Number(tx.source_line_id),
        sourceRefNo: tx.source_ref_no || undefined,
        eventDate: String(tx.event_date).slice(0, 10),
        periodFrom: tx.period_from ? String(tx.period_from).slice(0, 10) : String(tx.event_date).slice(0, 10),
        periodTo: tx.period_to ? String(tx.period_to).slice(0, 10) : String(tx.event_date).slice(0, 10),
        quantity: Number(tx.quantity || 0),
        uom: tx.uom || "UNIT",
        remarks: tx.remarks || "Auto reprocessed from unrated queue",
      })
      processedIds.push(Number(tx.id))
    }

    let movedToUnbilled = 0
    let stillUnrated = 0
    if (processedIds.length > 0) {
      const statusRes = await db.query(
        `SELECT status, COUNT(*)::int AS count
         FROM billing_transactions
         WHERE company_id = $1
           AND id = ANY($2::int[])
         GROUP BY status`,
        [session.companyId, processedIds]
      )
      for (const row of statusRes.rows as Array<{ status: string; count: number }>) {
        if (row.status === "UNBILLED") movedToUnbilled += Number(row.count || 0)
        if (row.status === "UNRATED") stillUnrated += Number(row.count || 0)
      }
    }

    const responseBody = {
      run_key: runKey,
      processed_count: processedIds.length,
      moved_to_unbilled: movedToUnbilled,
      still_unrated: stillUnrated,
      skipped_count: Math.max(rows.length - processedIds.length, 0),
      limit: batchLimit,
    }

    await db.query(
      `UPDATE billing_job_runs
       SET status = 'SUCCESS',
           finished_at = CURRENT_TIMESTAMP,
           details = COALESCE(details, '{}'::jsonb) || $1::jsonb
       WHERE company_id = $2
         AND job_type = 'UNRATED_REPROCESS'
         AND run_key = $3`,
      [JSON.stringify(responseBody), session.companyId, runKey]
    )

    await db.query("COMMIT")

    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }

    return ok(responseBody, "UNRATED reprocess job completed")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message =
      error instanceof Error ? error.message : "Failed to run UNRATED reprocess job"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}

