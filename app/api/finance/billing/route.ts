import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
} from "@/lib/policy/guards"

type InvoiceRow = {
  id: number
  invoice_number: string
  client_id: number
  client_name: string
  billing_period: string
  invoice_date: string
  due_date: string
  total_amount: number
  paid_amount: number
  balance: number
  status: "PAID" | "PENDING" | "OVERDUE"
}

type ChargeMixRow = {
  charge_type: string
  amount: number
}

type SourceMixRow = {
  source_type: string
  amount: number
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
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

    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get("date_from")
    const dateTo = searchParams.get("date_to")
    const clientId = searchParams.get("client_id")
    const warehouseId = searchParams.get("warehouse_id")

    const normalizedTable = await query(`SELECT to_regclass('public.invoice_header') AS table_name`)
    const invoicesTable = await query(`SELECT to_regclass('public.invoices') AS table_name`)
    let rows: InvoiceRow[] = []

    if (normalizedTable.rows[0]?.table_name) {
      const conditions: string[] = ["ih.company_id = $1"]
      const params: Array<string | number> = [session.companyId]
      let idx = 2

      if (dateFrom) {
        conditions.push(`ih.invoice_date >= $${idx++}::date`)
        params.push(dateFrom)
      }
      if (dateTo) {
        conditions.push(`ih.invoice_date <= $${idx++}::date`)
        params.push(dateTo)
      }
      if (clientId && clientId !== "all") {
        conditions.push(`ih.client_id = $${idx++}`)
        params.push(Number(clientId))
      }
      if (warehouseId && warehouseId !== "all") {
        conditions.push(`EXISTS (
          SELECT 1
          FROM billing_transactions bt
          WHERE bt.company_id = ih.company_id
            AND bt.invoice_id = ih.id
            AND bt.warehouse_id = $${idx++}
        )`)
        params.push(Number(warehouseId))
      }

      const result = await query(
        `SELECT
          ih.id,
          ih.invoice_number,
          ih.client_id,
          c.client_name,
          COALESCE(ih.billing_period, TO_CHAR(ih.invoice_date, 'Mon YYYY')) AS billing_period,
          ih.invoice_date::date AS invoice_date,
          ih.due_date::date AS due_date,
          COALESCE(ih.taxable_amount, 0)::numeric AS total_amount,
          COALESCE(ih.paid_amount, 0)::numeric AS paid_amount,
          COALESCE(ih.balance_amount, 0)::numeric AS balance,
          CASE
            WHEN COALESCE(ih.balance_amount, 0) <= 0 THEN 'PAID'
            WHEN ih.due_date::date < CURRENT_DATE THEN 'OVERDUE'
            ELSE 'PENDING'
          END AS status
        FROM invoice_header ih
        JOIN clients c
          ON c.id = ih.client_id
         AND c.company_id = ih.company_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY ih.invoice_date DESC`,
        params
      )
      rows = result.rows as InvoiceRow[]
    } else if (invoicesTable.rows[0]?.table_name) {
      const conditions: string[] = ["i.company_id = $1"]
      const params: Array<string | number> = [session.companyId]
      let idx = 2

      if (dateFrom) {
        conditions.push(`i.invoice_date >= $${idx++}::date`)
        params.push(dateFrom)
      }
      if (dateTo) {
        conditions.push(`i.invoice_date <= $${idx++}::date`)
        params.push(dateTo)
      }
      if (clientId && clientId !== "all") {
        conditions.push(`i.client_id = $${idx++}`)
        params.push(Number(clientId))
      }
      if (warehouseId && warehouseId !== "all") {
        conditions.push(`EXISTS (
          SELECT 1
          FROM billing_transactions bt
          WHERE bt.company_id = i.company_id
            AND bt.invoice_id = i.id
            AND bt.warehouse_id = $${idx++}
        )`)
        params.push(Number(warehouseId))
      }

      const result = await query(
        `SELECT
          i.id,
          i.invoice_number,
          i.client_id,
          c.client_name,
          COALESCE(i.billing_period, TO_CHAR(i.invoice_date, 'Mon YYYY')) AS billing_period,
          i.invoice_date::date AS invoice_date,
          i.due_date::date AS due_date,
          COALESCE(i.total_amount, 0)::numeric AS total_amount,
          COALESCE(i.paid_amount, 0)::numeric AS paid_amount,
          COALESCE(i.balance, COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0))::numeric AS balance,
          CASE
            WHEN COALESCE(i.balance, COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0)) <= 0 THEN 'PAID'
            WHEN i.due_date::date < CURRENT_DATE THEN 'OVERDUE'
            ELSE 'PENDING'
          END AS status
        FROM invoices i
        JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY i.invoice_date DESC`,
        params
      )
      rows = result.rows as InvoiceRow[]
    }

    const totalRevenue = rows.reduce((sum, row) => sum + Number(row.total_amount), 0)
    const totalPaid = rows.reduce((sum, row) => sum + Number(row.paid_amount), 0)
    const totalPending = rows.reduce((sum, row) => sum + Number(row.balance), 0)
    const overdueBalance = rows
      .filter((row) => row.status === "OVERDUE")
      .reduce((sum, row) => sum + Number(row.balance), 0)
    const activeClients = new Set(rows.map((row) => Number(row.client_id))).size

    const txConditions: string[] = ["bt.company_id = $1", "bt.status <> 'VOID'", "bt.status <> 'UNRATED'"]
    const txParams: Array<string | number> = [session.companyId]
    let txIdx = 2
    if (dateFrom) {
      txConditions.push(`bt.event_date >= $${txIdx++}::date`)
      txParams.push(dateFrom)
    }
    if (dateTo) {
      txConditions.push(`bt.event_date <= $${txIdx++}::date`)
      txParams.push(dateTo)
    }
    if (clientId && clientId !== "all") {
      txConditions.push(`bt.client_id = $${txIdx++}`)
      txParams.push(Number(clientId))
    }
    if (warehouseId && warehouseId !== "all") {
      txConditions.push(`bt.warehouse_id = $${txIdx++}`)
      txParams.push(Number(warehouseId))
    }

    const chargeMixResult = await query(
      `SELECT bt.charge_type, COALESCE(SUM(bt.amount), 0)::numeric AS amount
       FROM billing_transactions bt
       WHERE ${txConditions.join(" AND ")}
       GROUP BY bt.charge_type
       ORDER BY amount DESC`,
      txParams
    )
    const sourceMixResult = await query(
      `SELECT bt.source_type, COALESCE(SUM(bt.amount), 0)::numeric AS amount
       FROM billing_transactions bt
       WHERE ${txConditions.join(" AND ")}
       GROUP BY bt.source_type
       ORDER BY amount DESC`,
      txParams
    )
    const unratedResult = await query(
      `SELECT COUNT(*)::int AS unrated_count
       FROM billing_transactions bt
       WHERE bt.company_id = $1
         AND bt.status = 'UNRATED'`,
      [session.companyId]
    )

    const grnConditions: string[] = ["gh.company_id = $1", "gh.status = 'CONFIRMED'"]
    const grnParams: Array<string | number> = [session.companyId]
    let grnIdx = 2
    if (dateFrom) {
      grnConditions.push(`gh.grn_date >= $${grnIdx++}::date`)
      grnParams.push(dateFrom)
    }
    if (dateTo) {
      grnConditions.push(`gh.grn_date <= $${grnIdx++}::date`)
      grnParams.push(dateTo)
    }
    if (clientId && clientId !== "all") {
      grnConditions.push(`gh.client_id = $${grnIdx++}`)
      grnParams.push(Number(clientId))
    }
    if (warehouseId && warehouseId !== "all") {
      grnConditions.push(`gh.warehouse_id = $${grnIdx++}`)
      grnParams.push(Number(warehouseId))
    }
    const grnKpiResult = await query(
      `SELECT COUNT(*)::int AS inbound_grn_docs
       FROM grn_header gh
       WHERE ${grnConditions.join(" AND ")}`,
      grnParams
    )

    const doConditions: string[] = ["dh.company_id = $1"]
    const doParams: Array<string | number> = [session.companyId]
    let doIdx = 2
    if (dateFrom) {
      doConditions.push(`dh.request_date >= $${doIdx++}::date`)
      doParams.push(dateFrom)
    }
    if (dateTo) {
      doConditions.push(`dh.request_date <= $${doIdx++}::date`)
      doParams.push(dateTo)
    }
    if (clientId && clientId !== "all") {
      doConditions.push(`dh.client_id = $${doIdx++}`)
      doParams.push(Number(clientId))
    }
    if (warehouseId && warehouseId !== "all") {
      doConditions.push(`dh.warehouse_id = $${doIdx++}`)
      doParams.push(Number(warehouseId))
    }
    const doKpiResult = await query(
      `SELECT COUNT(*)::int AS outbound_do_docs
       FROM do_header dh
       WHERE ${doConditions.join(" AND ")}`,
      doParams
    )

    const chargeMix = (chargeMixResult.rows as ChargeMixRow[]).map((row) => ({
      charge_type: row.charge_type,
      amount: Number(row.amount || 0),
    }))
    const sourceMix = (sourceMixResult.rows as SourceMixRow[]).map((row) => ({
      source_type: row.source_type,
      amount: Number(row.amount || 0),
    }))

    return ok({
      invoices: rows,
      summary: {
        totalRevenue,
        totalPaid,
        totalPending,
        invoiceCount: rows.length,
      },
      insights: {
        collectionEfficiencyPct: totalRevenue > 0 ? (totalPaid / totalRevenue) * 100 : 0,
        overdueSharePct: totalPending > 0 ? (overdueBalance / totalPending) * 100 : 0,
        avgInvoiceValue: rows.length > 0 ? totalRevenue / rows.length : 0,
        activeClients,
        inboundGrnDocs: Number(grnKpiResult.rows[0]?.inbound_grn_docs || 0),
        outboundDoDocs: Number(doKpiResult.rows[0]?.outbound_do_docs || 0),
        unratedTransactionCount: Number(unratedResult.rows[0]?.unrated_count || 0),
        chargeMix,
        sourceMix,
      },
    })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch billing data"
    return fail("SERVER_ERROR", message, 500)
  }
}
