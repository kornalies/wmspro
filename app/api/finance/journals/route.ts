import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureAccountingSchema } from "@/lib/db-bootstrap"
import { ensureSystemAccounts, syncFinanceLedger } from "@/lib/finance-ledger"

const journalLineSchema = z.object({
  account_code: z.string().min(2).max(20),
  debit: z.number().min(0).optional().default(0),
  credit: z.number().min(0).optional().default(0),
  narration: z.string().optional(),
})

const manualJournalSchema = z.object({
  entry_date: z.string().min(10),
  description: z.string().min(2).max(500),
  lines: z.array(journalLineSchema).min(2),
})

export async function GET(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    const { searchParams } = new URL(request.url)
    const warehouseIdRaw = searchParams.get("warehouse_id")
    const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null

    // Sync ledger first because it uses its own DB transaction/client.
    // Running it inside an open transaction here can deadlock on chart_of_accounts upserts.
    await syncFinanceLedger(session.companyId, session.userId)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    await ensureAccountingSchema(db)
    await ensureSystemAccounts(db, session.companyId)

    const accountsResult = await db.query(
      `SELECT account_code, account_name, account_type
       FROM chart_of_accounts
       WHERE company_id = $1
         AND is_active = true
       ORDER BY account_code`,
      [session.companyId]
    )

    const journalsResult = await db.query(
      `SELECT
         je.id,
         je.entry_date,
         je.entry_type,
         je.external_ref,
         je.description,
         je.created_at,
         je.updated_at,
         COALESCE(u.full_name, u.username, 'System') AS modified_by_name,
         COALESCE(SUM(jl.debit), 0)::numeric AS total_debit,
         COALESCE(SUM(jl.credit), 0)::numeric AS total_credit
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
       LEFT JOIN users u ON u.id = je.posted_by AND u.company_id = je.company_id
       WHERE je.company_id = $1
         AND (
           $2::int IS NULL
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
                 AND bt.warehouse_id = $2::int
             )
           )
           OR (
             je.source_module = 'GRN'
             AND EXISTS (
               SELECT 1
               FROM grn_header gh
               WHERE gh.company_id = $1
                 AND gh.id = CASE WHEN je.source_id ~ '^[0-9]+$' THEN je.source_id::int ELSE NULL END
                 AND gh.warehouse_id = $2::int
             )
           )
           OR (
             je.source_module = 'DO'
             AND EXISTS (
               SELECT 1
               FROM do_header dh
               WHERE dh.company_id = $1
                 AND dh.id = CASE WHEN je.source_id ~ '^[0-9]+$' THEN je.source_id::int ELSE NULL END
                 AND dh.warehouse_id = $2::int
             )
           )
         )
       GROUP BY je.id, u.full_name, u.username
       ORDER BY je.entry_date DESC, je.id DESC
       LIMIT 30`,
      [session.companyId, warehouseId]
    )

    await db.query("COMMIT")
    return ok({
      accounts: accountsResult.rows,
      journals: journalsResult.rows,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to fetch journals"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = manualJournalSchema.parse(await request.json())
    const lines = payload.lines
      .map((line) => ({
        ...line,
        debit: Number(line.debit || 0),
        credit: Number(line.credit || 0),
      }))
      .filter((line) => line.debit > 0 || line.credit > 0)

    if (lines.length < 2) {
      return fail("VALIDATION_ERROR", "At least 2 non-zero lines are required", 400)
    }

    const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0)
    const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0)
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return fail("VALIDATION_ERROR", "Total debit and total credit must be equal", 400)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    await ensureAccountingSchema(db)
    await ensureSystemAccounts(db, session.companyId)

    const accountCodes = lines.map((line) => line.account_code)
    const accountResult = await db.query(
      `SELECT id, account_code
       FROM chart_of_accounts
       WHERE company_id = $1
         AND account_code = ANY($2::text[])
         AND is_active = true`,
      [session.companyId, accountCodes]
    )
    const accountMap = new Map<string, number>()
    for (const row of accountResult.rows) {
      accountMap.set(String(row.account_code), Number(row.id))
    }
    for (const line of lines) {
      if (!accountMap.has(line.account_code)) {
        throw new Error(`Account code not found: ${line.account_code}`)
      }
    }

    const externalRef = `JV-${payload.entry_date}-${Date.now()}`
    const entryResult = await db.query(
      `INSERT INTO journal_entries (
        company_id, entry_date, source_module, source_id, entry_type, external_ref, description, posted_by
      ) VALUES ($1, $2::date, 'MANUAL', NULL, 'MANUAL_JV', $3, $4, $5)
      RETURNING id`,
      [session.companyId, payload.entry_date, externalRef, payload.description, session.userId]
    )
    const entryId = Number(entryResult.rows[0].id)

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      await db.query(
        `INSERT INTO journal_lines (
          company_id, journal_entry_id, line_no, account_id, debit, credit, narration
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.companyId,
          entryId,
          i + 1,
          accountMap.get(line.account_code),
          line.debit,
          line.credit,
          line.narration || null,
        ]
      )
    }

    await db.query("COMMIT")
    return ok({ id: entryId, external_ref: externalRef }, "Journal voucher posted")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to post journal voucher"
    return fail("SERVER_ERROR", message, 500)
  } finally {
    db.release()
  }
}
