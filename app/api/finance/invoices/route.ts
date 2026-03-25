import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { generateInvoiceDrafts, generateInvoiceDraftsByBillingCycle } from "@/lib/billing-service"
import { syncInvoiceLedger } from "@/lib/finance-ledger"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

type InvoiceItem = {
  description: string
  quantity: number
  rate: number
  amount: number
}

type InvoiceRow = {
  id: number
  invoice_number: string
  created_at?: string
  created_by_name?: string | null
  client_id: number
  client_name: string
  client_gstin: string | null
  place_of_supply: string | null
  supply_type: "INTRA_STATE" | "INTER_STATE"
  billing_period: string
  invoice_date: string
  due_date: string
  taxable_amount: number
  gst_rate: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  total_tax_amount: number
  grand_total: number
  total_amount: number
  paid_amount: number
  balance: number
  status: "DRAFT" | "FINALIZED" | "SENT" | "PAID" | "OVERDUE" | "VOID"
  items: InvoiceItem[]
  payments?: Array<{
    id: number
    payment_date: string
    amount: number
    payment_mode?: string | null
    reference_no?: string | null
    notes?: string | null
  }>
  supplier_name?: string
  supplier_gstin?: string
  supplier_pan?: string
  supplier_address?: string
  supplier_state?: string
  supplier_state_code?: string
}

type TrailBalanceRow = {
  client_id: number
  client_name: string
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
}

type DraftSummary = {
  generatedCount: number
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

function currentMonthRange() {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export async function GET(request: NextRequest) {
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
    if (policy.permissions.includes("billing.view")) {
      requirePolicyPermission(policy, "billing.view")
    } else {
      requirePolicyPermission(policy, "finance.view")
    }
    await syncInvoiceLedger(session.companyId, session.userId)

    const normalized = await query(`SELECT to_regclass('public.invoice_header') AS table_name`)
    if (!normalized.rows[0]?.table_name) {
      return ok({
        invoices: [],
        summary: {
          totalRevenue: 0,
          totalPaid: 0,
          totalOutstanding: 0,
          totalTax: 0,
          totalInvoiceValue: 0,
          overdueCount: 0,
        },
        aging: { current: 0, bucket_1_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0 },
        trailBalance: {
          rows: [],
          totals: {
            opening_debit: 0,
            opening_credit: 0,
            period_debit: 0,
            period_credit: 0,
            closing_debit: 0,
            closing_credit: 0,
          },
        },
      })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const search = searchParams.get("search")
    const warehouseIdRaw = searchParams.get("warehouse_id")
    const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null

    const rows = await query(
       `SELECT
         ih.id,
         ih.invoice_number,
         ih.created_at::text AS created_at,
         creator.full_name AS created_by_name,
         ih.client_id,
         c.client_name,
         c.gst_number AS client_gstin,
         COALESCE(c.state, '') AS place_of_supply,
         CASE
           WHEN COALESCE(ih.igst_amount, 0) > 0 THEN 'INTER_STATE'
           ELSE 'INTRA_STATE'
         END AS supply_type,
         COALESCE(ih.billing_period, TO_CHAR(ih.invoice_date, 'Mon YYYY')) AS billing_period,
         ih.invoice_date::text,
         ih.due_date::text,
         COALESCE(ih.taxable_amount, 0)::numeric AS taxable_amount,
         CASE
           WHEN COALESCE(ih.taxable_amount, 0) = 0 THEN 0::numeric
           ELSE ROUND((COALESCE(ih.total_tax_amount, 0) / NULLIF(COALESCE(ih.taxable_amount, 0), 0)) * 100, 3)::numeric
         END AS gst_rate,
         COALESCE(ih.cgst_amount, 0)::numeric AS cgst_amount,
         COALESCE(ih.sgst_amount, 0)::numeric AS sgst_amount,
         COALESCE(ih.igst_amount, 0)::numeric AS igst_amount,
         COALESCE(ih.total_tax_amount, 0)::numeric AS total_tax_amount,
         COALESCE(ih.grand_total, 0)::numeric AS grand_total,
         COALESCE(ih.taxable_amount, 0)::numeric AS total_amount,
         COALESCE(ih.paid_amount, 0)::numeric AS paid_amount,
         COALESCE(ih.balance_amount, 0)::numeric AS balance,
         CASE
           WHEN ih.status = 'PAID' THEN 'PAID'
           WHEN ih.status = 'DRAFT' THEN 'DRAFT'
           WHEN ih.status = 'VOID' THEN 'VOID'
           WHEN COALESCE(ih.balance_amount, 0) <= 0 THEN 'PAID'
           WHEN ih.due_date < CURRENT_DATE THEN 'OVERDUE'
           WHEN ih.status = 'FINALIZED' THEN 'SENT'
           ELSE ih.status
         END AS status,
         co.company_name AS tenant_company_name,
         co.company_code AS tenant_company_code,
         ts.ui_branding,
         COALESCE(items.items, '[]'::json) AS items,
         COALESCE(payments.payments, '[]'::json) AS payments
       FROM invoice_header ih
       JOIN clients c
         ON c.id = ih.client_id
        AND c.company_id = ih.company_id
       LEFT JOIN users creator
         ON creator.id = ih.created_by
        AND creator.company_id = ih.company_id
       LEFT JOIN companies co
         ON co.id = ih.company_id
       LEFT JOIN tenant_settings ts
         ON ts.company_id = ih.company_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           json_agg(
              json_build_object(
                'invoice_line_id', il.id,
                'description', il.description,
                'quantity', il.quantity,
                'rate', il.rate,
                'amount', il.amount
              )
             ORDER BY il.line_no
           ),
           '[]'::json
         ) AS items
         FROM invoice_lines il
         WHERE il.company_id = ih.company_id
           AND il.invoice_id = ih.id
       ) items ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           json_agg(
             json_build_object(
               'id', ip.id,
               'payment_date', ip.payment_date::text,
               'amount', ip.amount,
               'payment_mode', ip.payment_mode,
               'reference_no', ip.reference_no,
               'notes', ip.notes
             )
             ORDER BY ip.payment_date DESC, ip.id DESC
           ),
           '[]'::json
         ) AS payments
         FROM invoice_payments ip
         WHERE ip.company_id = ih.company_id
           AND ip.invoice_id = ih.id
       ) payments ON true
       WHERE ih.company_id = $1
         AND ($2::text IS NULL OR (
           CASE
             WHEN ih.status = 'PAID' THEN 'PAID'
             WHEN ih.status = 'DRAFT' THEN 'DRAFT'
             WHEN ih.status = 'VOID' THEN 'VOID'
             WHEN COALESCE(ih.balance_amount, 0) <= 0 THEN 'PAID'
             WHEN ih.due_date < CURRENT_DATE THEN 'OVERDUE'
             WHEN ih.status = 'FINALIZED' THEN 'SENT'
             ELSE ih.status
           END
         ) = $2::text)
         AND ($3::text IS NULL OR ih.invoice_number ILIKE $3::text OR c.client_name ILIKE $3::text)
         AND (
           $4::int IS NULL
           OR EXISTS (
             SELECT 1
             FROM billing_transactions bt
             WHERE bt.company_id = ih.company_id
               AND bt.invoice_id = ih.id
               AND bt.warehouse_id = $4::int
           )
         )
       ORDER BY ih.invoice_date DESC, ih.id DESC`,
      [session.companyId, status && status !== "all" ? status : null, search ? `%${search}%` : null, warehouseId]
    )

    const invoices = (rows.rows as Array<Record<string, unknown>>).map((row) => {
      const brandingRaw =
        typeof row.ui_branding === "string"
          ? (() => {
              try {
                return JSON.parse(row.ui_branding)
              } catch {
                return {}
              }
            })()
          : (row.ui_branding as Record<string, unknown> | null) || {}
      const labels = ((brandingRaw as { labels?: unknown }).labels as Record<string, unknown>) || {}
      const supplierName = String(
        labels.supplier_legal_name || labels.supplier_name || row.tenant_company_name || "WMS Pro"
      )
      const supplierGstin = String(labels.supplier_gstin || labels.gstin || "")
      const supplierPan = String(labels.supplier_pan || labels.pan || "")
      const supplierAddress = String(labels.supplier_address || labels.address || "")
      const supplierState = String(labels.supplier_state || "")
      const supplierStateCode = String(labels.supplier_state_code || "")

      return {
        ...(row as InvoiceRow),
        supplier_name: supplierName,
        supplier_gstin: supplierGstin,
        supplier_pan: supplierPan,
        supplier_address: supplierAddress,
        supplier_state: supplierState,
        supplier_state_code: supplierStateCode,
      } as InvoiceRow
    })
    const trailMap = new Map<number, TrailBalanceRow>()
    for (const inv of invoices) {
      const existing =
        trailMap.get(inv.client_id) ??
        {
          client_id: inv.client_id,
          client_name: inv.client_name,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: 0,
          period_credit: 0,
          closing_debit: 0,
          closing_credit: 0,
        }

      existing.period_debit += Number(inv.grand_total)
      existing.period_credit += Number(inv.paid_amount)
      const net = existing.opening_debit - existing.opening_credit + existing.period_debit - existing.period_credit
      existing.closing_debit = net > 0 ? net : 0
      existing.closing_credit = net < 0 ? Math.abs(net) : 0
      trailMap.set(inv.client_id, existing)
    }

    const trailBalanceRows = Array.from(trailMap.values()).sort((a, b) =>
      a.client_name.localeCompare(b.client_name)
    )
    const trailBalanceTotals = trailBalanceRows.reduce(
      (acc, row) => {
        acc.opening_debit += row.opening_debit
        acc.opening_credit += row.opening_credit
        acc.period_debit += row.period_debit
        acc.period_credit += row.period_credit
        acc.closing_debit += row.closing_debit
        acc.closing_credit += row.closing_credit
        return acc
      },
      {
        opening_debit: 0,
        opening_credit: 0,
        period_debit: 0,
        period_credit: 0,
        closing_debit: 0,
        closing_credit: 0,
      }
    )

    const summary = {
      totalRevenue: invoices.reduce((sum, inv) => sum + Number(inv.total_amount), 0),
      totalPaid: invoices.reduce((sum, inv) => sum + Number(inv.paid_amount), 0),
      totalOutstanding: invoices.reduce((sum, inv) => sum + Number(inv.balance), 0),
      totalTax: invoices.reduce((sum, inv) => sum + Number(inv.total_tax_amount), 0),
      totalInvoiceValue: invoices.reduce((sum, inv) => sum + Number(inv.grand_total), 0),
      overdueCount: invoices.filter((inv) => inv.status === "OVERDUE").length,
    }

    const aging = invoices.reduce(
      (acc, inv) => {
        const bal = Number(inv.balance || 0)
        if (bal <= 0) return acc
        const due = new Date(inv.due_date)
        const days = Math.floor((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24))
        if (days <= 0) acc.current += bal
        else if (days <= 30) acc.bucket_1_30 += bal
        else if (days <= 60) acc.bucket_31_60 += bal
        else if (days <= 90) acc.bucket_61_90 += bal
        else acc.bucket_90_plus += bal
        return acc
      },
      { current: 0, bucket_1_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0 }
    )

    return ok({
      invoices,
      summary,
      aging,
      trailBalance: {
        rows: trailBalanceRows,
        totals: trailBalanceTotals,
      },
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch invoices"
    return fail("SERVER_ERROR", message, 500)
  }
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
    const month = currentMonthRange()
    const periodFrom = body.period_from || month.from
    const periodTo = body.period_to || month.to
    const autoCycle = body.auto_cycle === true
    const runDate = body.run_date || new Date().toISOString().slice(0, 10)
    const runKey = body.run_key || (autoCycle ? `INV-CYCLE-${runDate}` : `INV-DRAFT-${periodFrom}-${periodTo}`)
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const routeKey = autoCycle
      ? `finance.invoices.generate.cycle:${runDate}:${body.client_id || "all"}`
      : `finance.invoices.generate:${periodFrom}:${periodTo}:${body.client_id || "all"}`
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
    const result: DraftSummary | CycleSummary = autoCycle
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
          generatedCount: result.generatedCount,
        },
        req: request,
      },
      db
    )
    await db.query("COMMIT")
    await syncInvoiceLedger(session.companyId, session.userId)
    const responseBody = {
      generated_count: result.generatedCount,
      period_from: periodFrom,
      period_to: periodTo,
      ...(autoCycle ? { run_date: runDate, mode: "CYCLE" } : {}),
      run_key: runKey,
      ...(autoCycle && isCycleSummary(result)
        ? {
            due_client_count: result.dueClientCount,
            profile_count: result.profileCount,
            skipped_count: result.skippedCount,
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
    return ok(
      responseBody,
      `Invoice drafts generated: ${result.generatedCount}`
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to generate invoices"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}


