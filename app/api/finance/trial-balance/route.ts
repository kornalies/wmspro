import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { syncInvoiceLedger } from "@/lib/finance-ledger"

type TrialBalanceRow = {
  account_code: string
  account_name: string
  account_type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE"
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
}

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

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const range = getDefaultFinancialYearRange()
    const dateFrom = searchParams.get("date_from") || range.from
    const dateTo = searchParams.get("date_to") || range.to
    const warehouseIdRaw = searchParams.get("warehouse_id")
    const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null

    await syncInvoiceLedger(session.companyId, session.userId)

    const tbResult = await query(
      `
      WITH account_master AS (
        SELECT
          coa.account_code,
          coa.account_name,
          coa.account_type
        FROM chart_of_accounts coa
        WHERE coa.company_id = $1
          AND coa.is_active = true
      ),
      ledger_lines AS (
        SELECT
          coa.account_code,
          je.entry_date AS txn_date,
          COALESCE(jl.debit, 0)::numeric AS debit,
          COALESCE(jl.credit, 0)::numeric AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE jl.company_id = $1
          AND je.company_id = $1
          AND coa.company_id = $1
          AND (
            $4::int IS NULL
            OR (
              je.source_module = 'INVOICE'
              AND EXISTS (
                SELECT 1
                FROM invoice_header ih
                JOIN billing_transactions bt
                  ON bt.company_id = ih.company_id
                 AND bt.invoice_id = ih.id
                WHERE ih.company_id = $1
                  AND ih.id = CASE WHEN je.source_id ~ '^[0-9]+$' THEN je.source_id::int ELSE NULL END
                  AND bt.warehouse_id = $4::int
              )
            )
            OR (
              je.source_module = 'GRN'
              AND EXISTS (
                SELECT 1
                FROM grn_header gh
                WHERE gh.company_id = $1
                  AND gh.id = CASE WHEN je.source_id ~ '^[0-9]+$' THEN je.source_id::int ELSE NULL END
                  AND gh.warehouse_id = $4::int
              )
            )
            OR (
              je.source_module = 'DO'
              AND EXISTS (
                SELECT 1
                FROM do_header dh
                WHERE dh.company_id = $1
                  AND dh.id = CASE WHEN je.source_id ~ '^[0-9]+$' THEN je.source_id::int ELSE NULL END
                  AND dh.warehouse_id = $4::int
              )
            )
          )
      ),
      opening AS (
        SELECT account_code, COALESCE(SUM(debit), 0)::numeric AS debit, COALESCE(SUM(credit), 0)::numeric AS credit
        FROM ledger_lines
        WHERE txn_date < $2::date
        GROUP BY account_code
      ),
      period AS (
        SELECT account_code, COALESCE(SUM(debit), 0)::numeric AS debit, COALESCE(SUM(credit), 0)::numeric AS credit
        FROM ledger_lines
        WHERE txn_date BETWEEN $2::date AND $3::date
        GROUP BY account_code
      )
      SELECT
        am.account_code,
        am.account_name,
        am.account_type,
        COALESCE(o.debit, 0)::numeric AS opening_debit,
        COALESCE(o.credit, 0)::numeric AS opening_credit,
        COALESCE(p.debit, 0)::numeric AS period_debit,
        COALESCE(p.credit, 0)::numeric AS period_credit,
        GREATEST(
          COALESCE(o.debit, 0) - COALESCE(o.credit, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0),
          0
        )::numeric AS closing_debit,
        GREATEST(
          COALESCE(o.credit, 0) - COALESCE(o.debit, 0) + COALESCE(p.credit, 0) - COALESCE(p.debit, 0),
          0
        )::numeric AS closing_credit
      FROM account_master am
      LEFT JOIN opening o ON o.account_code = am.account_code
      LEFT JOIN period p ON p.account_code = am.account_code
      ORDER BY am.account_code ASC
      `,
      [session.companyId, dateFrom, dateTo, warehouseId]
    )

    const rows = tbResult.rows as TrialBalanceRow[]
    const totals = rows.reduce(
      (acc, row) => {
        acc.opening_debit += Number(row.opening_debit)
        acc.opening_credit += Number(row.opening_credit)
        acc.period_debit += Number(row.period_debit)
        acc.period_credit += Number(row.period_credit)
        acc.closing_debit += Number(row.closing_debit)
        acc.closing_credit += Number(row.closing_credit)
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

    const isBalanced =
      Math.abs(totals.opening_debit - totals.opening_credit) < 0.01 &&
      Math.abs(totals.period_debit - totals.period_credit) < 0.01 &&
      Math.abs(totals.closing_debit - totals.closing_credit) < 0.01

    return ok({
      date_from: dateFrom,
      date_to: dateTo,
      rows,
      totals,
      is_balanced: isBalanced,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to generate trial balance"
    return fail("SERVER_ERROR", message, 500)
  }
}
