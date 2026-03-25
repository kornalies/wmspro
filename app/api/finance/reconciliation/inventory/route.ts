import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { syncInvoiceLedger } from "@/lib/finance-ledger"

export const dynamic = "force-dynamic"
export const revalidate = 0

function toISODate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function getDefaultFinancialYearRange() {
  const now = new Date()
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  const from = new Date(Date.UTC(year, 3, 1)) // 1-Apr
  const to = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  return { from: toISODate(from), to: toISODate(to) }
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseTolerance(raw: string | null) {
  const value = raw ? Number(raw) : 0.01
  if (!Number.isFinite(value) || value < 0) return 0.01
  return value
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const defaultRange = getDefaultFinancialYearRange()
    const dateFromRaw = searchParams.get("date_from")
    const dateToRaw = searchParams.get("date_to")
    const dateFrom = dateFromRaw && isIsoDate(dateFromRaw) ? dateFromRaw : defaultRange.from
    const dateTo = dateToRaw && isIsoDate(dateToRaw) ? dateToRaw : defaultRange.to
    const tolerance = parseTolerance(searchParams.get("tolerance"))

    await syncInvoiceLedger(session.companyId, session.userId)

    const [dashboardValueResult, trialValueResult] = await Promise.all([
      query(
        `SELECT
           COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0)::numeric AS value
         FROM journal_lines jl
         JOIN journal_entries je
           ON je.id = jl.journal_entry_id
          AND je.company_id = jl.company_id
         JOIN chart_of_accounts coa
           ON coa.id = jl.account_id
          AND coa.company_id = jl.company_id
         WHERE jl.company_id = $1
           AND coa.account_code = '1200'
           AND je.entry_date <= $2::date`,
        [session.companyId, dateTo]
      ),
      query(
        `
        WITH inventory_lines AS (
          SELECT
            je.entry_date AS txn_date,
            COALESCE(jl.debit, 0)::numeric AS debit,
            COALESCE(jl.credit, 0)::numeric AS credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.journal_entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE jl.company_id = $1
            AND je.company_id = $1
            AND coa.company_id = $1
            AND coa.account_code = '1200'
        ),
        opening AS (
          SELECT
            COALESCE(SUM(debit), 0)::numeric AS opening_debit,
            COALESCE(SUM(credit), 0)::numeric AS opening_credit
          FROM inventory_lines
          WHERE txn_date < $2::date
        ),
        period AS (
          SELECT
            COALESCE(SUM(debit), 0)::numeric AS period_debit,
            COALESCE(SUM(credit), 0)::numeric AS period_credit
          FROM inventory_lines
          WHERE txn_date BETWEEN $2::date AND $3::date
        )
        SELECT
          GREATEST(
            COALESCE(o.opening_debit, 0) - COALESCE(o.opening_credit, 0) + COALESCE(p.period_debit, 0) - COALESCE(p.period_credit, 0),
            0
          )::numeric AS closing_debit,
          GREATEST(
            COALESCE(o.opening_credit, 0) - COALESCE(o.opening_debit, 0) + COALESCE(p.period_credit, 0) - COALESCE(p.period_debit, 0),
            0
          )::numeric AS closing_credit
        FROM opening o
        CROSS JOIN period p
        `,
        [session.companyId, dateFrom, dateTo]
      ),
    ])

    const dashboardValue = Number(dashboardValueResult.rows[0]?.value || 0)
    const trialClosingDebit = Number(trialValueResult.rows[0]?.closing_debit || 0)
    const trialClosingCredit = Number(trialValueResult.rows[0]?.closing_credit || 0)
    const trialBalanceValue = trialClosingDebit - trialClosingCredit
    const delta = dashboardValue - trialBalanceValue
    const isReconciled = Math.abs(delta) <= tolerance

    return ok(
      {
        date_from: dateFrom,
        date_to: dateTo,
        tolerance,
        dashboard_inventory_value: dashboardValue,
        trial_balance_inventory_value: trialBalanceValue,
        trial_balance_closing_debit: trialClosingDebit,
        trial_balance_closing_credit: trialClosingCredit,
        delta,
        is_reconciled: isReconciled,
        status: isReconciled ? "ok" : "mismatch",
        source: {
          dashboard: "ledger_account_1200_balance_as_of_date_to",
          trial_balance: "opening_plus_period_closing_for_account_1200",
        },
        checked_at: new Date().toISOString(),
      },
      undefined,
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
          "Surrogate-Control": "no-store",
        },
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to reconcile inventory value"
    return fail("SERVER_ERROR", message, 500)
  }
}
