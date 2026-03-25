import { getClient, setTenantContext } from "@/lib/db"
import { ensureAccountingSchema } from "@/lib/db-bootstrap"
import { DO_FULFILLMENT_STATUSES } from "@/lib/do-status"

type DBClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  release: () => void
}

type InvoiceSourceRow = {
  source_id: string
  txn_date: string
  client_id: number
  client_name: string
  taxable_amount: number
  tax_amount: number
  invoice_total: number
  paid_amount: number
}

type GrnSourceRow = {
  source_id: string
  txn_date: string
  amount: number
  warehouse_name: string
}

type DoSourceRow = {
  source_id: string
  txn_date: string
  amount: number
  do_number: string
}

type InvoicePaymentSourceRow = {
  payment_id: number
  source_id: string
  txn_date: string
  amount: number
  client_name: string
}

type CreditNoteSourceRow = {
  note_id: number
  source_id: string
  txn_date: string
  taxable_amount: number
  tax_amount: number
  note_total: number
  client_name: string
}

type DebitNoteSourceRow = {
  note_id: number
  source_id: string
  txn_date: string
  taxable_amount: number
  tax_amount: number
  note_total: number
  client_name: string
}

const SYSTEM_ACCOUNTS = [
  { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { code: "1110", name: "Cash / Bank", type: "ASSET" },
  { code: "1200", name: "Inventory Asset", type: "ASSET" },
  { code: "2100", name: "Output GST Payable", type: "LIABILITY" },
  { code: "2200", name: "GRN Clearing / Accrual", type: "LIABILITY" },
  { code: "4100", name: "Sales Revenue", type: "INCOME" },
  { code: "5100", name: "Cost of Goods Sold", type: "EXPENSE" },
] as const

async function fetchInvoiceSourceRows(db: DBClient, companyId: number): Promise<InvoiceSourceRow[]> {
  const normalizedTable = await db.query(`SELECT to_regclass('public.invoice_header') AS table_name`)
  const hasNormalized = Boolean(normalizedTable.rows[0]?.table_name)
  if (hasNormalized) {
    const result = await db.query(
      `SELECT
         CAST(ih.id AS text) AS source_id,
         ih.invoice_date::date::text AS txn_date,
         ih.client_id,
         c.client_name,
         COALESCE(ih.taxable_amount, 0)::numeric AS taxable_amount,
         COALESCE(ih.total_tax_amount, 0)::numeric AS tax_amount,
         COALESCE(ih.grand_total, 0)::numeric AS invoice_total,
         COALESCE(ih.paid_amount, 0)::numeric AS paid_amount
       FROM invoice_header ih
       JOIN clients c ON c.id = ih.client_id
       WHERE ih.company_id = $1`,
      [companyId]
    )
    return result.rows as InvoiceSourceRow[]
  }

  const invoicesTable = await db.query(`SELECT to_regclass('public.invoices') AS table_name`)
  const hasInvoicesTable = Boolean(invoicesTable.rows[0]?.table_name)

  if (hasInvoicesTable) {
    const result = await db.query(
      `SELECT
         CAST(i.id AS text) AS source_id,
         i.invoice_date::date::text AS txn_date,
         i.client_id,
         c.client_name,
         COALESCE(i.total_amount, 0)::numeric AS taxable_amount,
         ROUND(COALESCE(i.total_amount, 0) * 0.18, 2)::numeric AS tax_amount,
         ROUND(COALESCE(i.total_amount, 0) * 1.18, 2)::numeric AS invoice_total,
         COALESCE(i.paid_amount, 0)::numeric AS paid_amount
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.company_id = $1`,
      [companyId]
    )
    return result.rows as InvoiceSourceRow[]
  }
  return []
}

export async function ensureSystemAccounts(db: DBClient, companyId: number) {
  for (const account of SYSTEM_ACCOUNTS) {
    await db.query(
      `INSERT INTO chart_of_accounts (company_id, account_code, account_name, account_type, is_system, is_active)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (company_id, account_code)
       DO UPDATE SET
         account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type,
         is_system = true,
         is_active = true,
         updated_at = CURRENT_TIMESTAMP`,
      [companyId, account.code, account.name, account.type]
    )
  }
}

export async function getAccountIdMap(db: DBClient, companyId: number) {
  const result = await db.query(
    `SELECT id, account_code
     FROM chart_of_accounts
     WHERE company_id = $1
       AND account_code = ANY($2::text[])`,
    [companyId, SYSTEM_ACCOUNTS.map((x) => x.code)]
  )
  const map = new Map<string, number>()
  for (const row of result.rows) {
    map.set(String(row.account_code), Number(row.id))
  }
  return map
}

async function upsertEntry(
  db: DBClient,
  params: {
    companyId: number
    entryDate: string
    sourceId: string
    entryType:
      | "INVOICE_ISSUE"
      | "INVOICE_PAYMENT"
      | "CREDIT_NOTE_ISSUE"
      | "DEBIT_NOTE_ISSUE"
      | "GRN_CONFIRM"
      | "DO_DISPATCH"
      | "MANUAL_JV"
    sourceModule?: "INVOICE" | "GRN" | "DO" | "MANUAL"
    externalRef: string
    description: string
    postedBy?: number
  }
) {
  const result = await db.query(
    `INSERT INTO journal_entries (
      company_id, entry_date, source_module, source_id, entry_type, external_ref, description, posted_by
    ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (company_id, external_ref)
    DO UPDATE SET
      entry_date = EXCLUDED.entry_date,
      source_module = EXCLUDED.source_module,
      source_id = EXCLUDED.source_id,
      entry_type = EXCLUDED.entry_type,
      description = EXCLUDED.description,
      posted_by = EXCLUDED.posted_by,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id`,
    [
      params.companyId,
      params.entryDate,
      params.sourceModule ?? "INVOICE",
      params.sourceId,
      params.entryType,
      params.externalRef,
      params.description,
      params.postedBy ?? null,
    ]
  )
  return Number(result.rows[0].id)
}

async function fetchGrnSourceRows(db: DBClient, companyId: number): Promise<GrnSourceRow[]> {
  const result = await db.query(
    `SELECT
       CAST(gh.id AS text) AS source_id,
       gh.grn_date::date::text AS txn_date,
       COALESCE(SUM(COALESCE(gli.quantity, 0) * COALESCE(gli.mrp, 0)), 0)::numeric AS amount,
       MAX(w.warehouse_name) AS warehouse_name
     FROM grn_header gh
     JOIN warehouses w ON w.id = gh.warehouse_id
     LEFT JOIN grn_line_items gli ON gli.grn_header_id = gh.id
     WHERE gh.company_id = $1
       AND gh.status = 'CONFIRMED'
     GROUP BY gh.id, gh.grn_date`,
    [companyId]
  )
  return result.rows as GrnSourceRow[]
}

async function fetchDoSourceRows(db: DBClient, companyId: number): Promise<DoSourceRow[]> {
  const result = await db.query(
    `SELECT
       CAST(dh.id AS text) AS source_id,
       COALESCE(dh.updated_at::date, dh.request_date::date)::text AS txn_date,
       COALESCE(SUM(COALESCE(dli.quantity_dispatched, 0) * COALESCE(i.standard_mrp, 0)), 0)::numeric AS amount,
       dh.do_number
     FROM do_header dh
     LEFT JOIN do_line_items dli ON dli.do_header_id = dh.id
     LEFT JOIN items i ON i.id = dli.item_id
     WHERE dh.company_id = $1
       AND dh.status = ANY($2::text[])
     GROUP BY dh.id, dh.do_number, dh.updated_at, dh.request_date`,
    [companyId, DO_FULFILLMENT_STATUSES]
  )
  return result.rows as DoSourceRow[]
}

async function fetchInvoicePaymentSourceRows(
  db: DBClient,
  companyId: number
): Promise<InvoicePaymentSourceRow[]> {
  const paymentsTable = await db.query(`SELECT to_regclass('public.invoice_payments') AS table_name`)
  const hasPaymentsTable = Boolean(paymentsTable.rows[0]?.table_name)
  if (!hasPaymentsTable) return []

  const normalizedTable = await db.query(`SELECT to_regclass('public.invoice_header') AS table_name`)
  const hasNormalized = Boolean(normalizedTable.rows[0]?.table_name)
  if (hasNormalized) {
    const result = await db.query(
      `SELECT
         ip.id AS payment_id,
         CAST(ih.id AS text) AS source_id,
         ip.payment_date::date::text AS txn_date,
         COALESCE(ip.amount, 0)::numeric AS amount,
         c.client_name
       FROM invoice_payments ip
       JOIN invoice_header ih ON ih.id = ip.invoice_id
       JOIN clients c ON c.id = ih.client_id
       WHERE ip.company_id = $1
         AND ih.company_id = $1`,
      [companyId]
    )
    return result.rows as InvoicePaymentSourceRow[]
  }

  const result = await db.query(
    `SELECT
       ip.id AS payment_id,
       CAST(i.id AS text) AS source_id,
       ip.payment_date::date::text AS txn_date,
       COALESCE(ip.amount, 0)::numeric AS amount,
       c.client_name
     FROM invoice_payments ip
     JOIN invoices i ON i.id = ip.invoice_id
     JOIN clients c ON c.id = i.client_id
     WHERE ip.company_id = $1
       AND i.company_id = $1`,
    [companyId]
  )
  return result.rows as InvoicePaymentSourceRow[]
}

async function fetchCreditNoteSourceRows(
  db: DBClient,
  companyId: number
): Promise<CreditNoteSourceRow[]> {
  const table = await db.query(`SELECT to_regclass('public.credit_note_header') AS table_name`)
  const hasTable = Boolean(table.rows[0]?.table_name)
  if (!hasTable) return []

  const result = await db.query(
    `SELECT
       cnh.id AS note_id,
       CAST(cnh.invoice_id AS text) AS source_id,
       cnh.note_date::date::text AS txn_date,
       COALESCE(cnh.taxable_amount, 0)::numeric AS taxable_amount,
       COALESCE(cnh.total_tax_amount, 0)::numeric AS tax_amount,
       COALESCE(cnh.grand_total, 0)::numeric AS note_total,
       c.client_name
     FROM credit_note_header cnh
     JOIN clients c ON c.id = cnh.client_id
     WHERE cnh.company_id = $1
       AND COALESCE(cnh.status, 'ISSUED') <> 'VOID'`,
    [companyId]
  )
  return result.rows as CreditNoteSourceRow[]
}

async function fetchDebitNoteSourceRows(
  db: DBClient,
  companyId: number
): Promise<DebitNoteSourceRow[]> {
  const table = await db.query(`SELECT to_regclass('public.debit_note_header') AS table_name`)
  const hasTable = Boolean(table.rows[0]?.table_name)
  if (!hasTable) return []

  const result = await db.query(
    `SELECT
       dnh.id AS note_id,
       CAST(dnh.invoice_id AS text) AS source_id,
       dnh.note_date::date::text AS txn_date,
       COALESCE(dnh.taxable_amount, 0)::numeric AS taxable_amount,
       COALESCE(dnh.total_tax_amount, 0)::numeric AS tax_amount,
       COALESCE(dnh.grand_total, 0)::numeric AS note_total,
       c.client_name
     FROM debit_note_header dnh
     JOIN clients c ON c.id = dnh.client_id
     WHERE dnh.company_id = $1
       AND COALESCE(dnh.status, 'ISSUED') <> 'VOID'`,
    [companyId]
  )
  return result.rows as DebitNoteSourceRow[]
}

async function replaceEntryLines(
  db: DBClient,
  companyId: number,
  entryId: number,
  lines: Array<{ accountId: number; debit: number; credit: number; narration: string }>
) {
  await db.query("DELETE FROM journal_lines WHERE company_id = $1 AND journal_entry_id = $2", [
    companyId,
    entryId,
  ])

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    await db.query(
      `INSERT INTO journal_lines (
        company_id, journal_entry_id, line_no, account_id, debit, credit, narration
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, entryId, i + 1, line.accountId, line.debit, line.credit, line.narration]
    )
  }
}

async function syncFinanceLedgerCore(db: DBClient, companyId: number, postedBy?: number) {
  await setTenantContext(db, companyId)
  await ensureAccountingSchema(db)
  await ensureSystemAccounts(db, companyId)
  const accountIds = await getAccountIdMap(db, companyId)

  const ar = accountIds.get("1100")
  const cash = accountIds.get("1110")
  const inventory = accountIds.get("1200")
  const gst = accountIds.get("2100")
  const grnClearing = accountIds.get("2200")
  const sales = accountIds.get("4100")
  const cogs = accountIds.get("5100")
  if (!ar || !cash || !inventory || !gst || !grnClearing || !sales || !cogs) {
    throw new Error("Missing mandatory chart of accounts entries")
  }

  const invoices = await fetchInvoiceSourceRows(db, companyId)
  const paymentRows = await fetchInvoicePaymentSourceRows(db, companyId)
  const creditNotes = await fetchCreditNoteSourceRows(db, companyId)
  const debitNotes = await fetchDebitNoteSourceRows(db, companyId)
  const hasDetailedPayments = paymentRows.length > 0

  for (const row of invoices) {
    const sourceId = String(row.source_id)
    const taxableAmount = Number(row.taxable_amount || 0)
    const taxAmount = Number(row.tax_amount || 0)
    const invoiceTotal = Number(row.invoice_total || 0)
    const paidAmount = Number(row.paid_amount || 0)

    const issueRef = `INV-${sourceId}-ISSUE`
    const issueEntryId = await upsertEntry(db, {
      companyId,
      entryDate: row.txn_date,
      sourceId,
      entryType: "INVOICE_ISSUE",
      sourceModule: "INVOICE",
      externalRef: issueRef,
      description: `Invoice issued for ${row.client_name}`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, issueEntryId, [
      { accountId: ar, debit: invoiceTotal, credit: 0, narration: "Invoice receivable" },
      { accountId: sales, debit: 0, credit: taxableAmount, narration: "Sales revenue" },
      { accountId: gst, debit: 0, credit: taxAmount, narration: "Output GST payable" },
    ])

    const paymentRef = `INV-${sourceId}-PAYMENT`
    if (!hasDetailedPayments && paidAmount > 0) {
      const paymentEntryId = await upsertEntry(db, {
        companyId,
        entryDate: row.txn_date,
        sourceId,
        entryType: "INVOICE_PAYMENT",
        sourceModule: "INVOICE",
        externalRef: paymentRef,
        description: `Invoice payment received for ${row.client_name}`,
        postedBy,
      })
      await replaceEntryLines(db, companyId, paymentEntryId, [
        { accountId: cash, debit: paidAmount, credit: 0, narration: "Cash / bank receipt" },
        { accountId: ar, debit: 0, credit: paidAmount, narration: "Receivable settled" },
      ])
    } else {
      await db.query(
        "DELETE FROM journal_entries WHERE company_id = $1 AND external_ref = $2",
        [companyId, paymentRef]
      )
    }
  }

  for (const payment of paymentRows) {
    const extRef = `INV-${payment.source_id}-PAY-${payment.payment_id}`
    const paymentEntryId = await upsertEntry(db, {
      companyId,
      entryDate: payment.txn_date,
      sourceId: payment.source_id,
      entryType: "INVOICE_PAYMENT",
      sourceModule: "INVOICE",
      externalRef: extRef,
      description: `Invoice payment received for ${payment.client_name}`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, paymentEntryId, [
      { accountId: cash, debit: Number(payment.amount || 0), credit: 0, narration: "Cash / bank receipt" },
      { accountId: ar, debit: 0, credit: Number(payment.amount || 0), narration: "Receivable settled" },
    ])
  }

  for (const note of creditNotes) {
    const extRef = `CN-${note.note_id}-ISSUE`
    const entryId = await upsertEntry(db, {
      companyId,
      entryDate: note.txn_date,
      sourceId: note.source_id,
      entryType: "CREDIT_NOTE_ISSUE",
      sourceModule: "MANUAL",
      externalRef: extRef,
      description: `Credit note issued for ${note.client_name}`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, entryId, [
      { accountId: sales, debit: Number(note.taxable_amount || 0), credit: 0, narration: "Sales reversal" },
      { accountId: gst, debit: Number(note.tax_amount || 0), credit: 0, narration: "Output GST reversal" },
      { accountId: ar, debit: 0, credit: Number(note.note_total || 0), narration: "Receivable reduced" },
    ])
  }

  for (const note of debitNotes) {
    const extRef = `DN-${note.note_id}-ISSUE`
    const entryId = await upsertEntry(db, {
      companyId,
      entryDate: note.txn_date,
      sourceId: note.source_id,
      entryType: "DEBIT_NOTE_ISSUE",
      sourceModule: "MANUAL",
      externalRef: extRef,
      description: `Debit note issued for ${note.client_name}`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, entryId, [
      { accountId: ar, debit: Number(note.note_total || 0), credit: 0, narration: "Receivable increased" },
      { accountId: sales, debit: 0, credit: Number(note.taxable_amount || 0), narration: "Additional sales" },
      { accountId: gst, debit: 0, credit: Number(note.tax_amount || 0), narration: "Output GST payable" },
    ])
  }

  const grns = await fetchGrnSourceRows(db, companyId)
  for (const row of grns) {
    const amount = Number(row.amount || 0)
    const extRef = `GRN-${row.source_id}-CONFIRM`
    const entryId = await upsertEntry(db, {
      companyId,
      entryDate: row.txn_date,
      sourceId: row.source_id,
      entryType: "GRN_CONFIRM",
      sourceModule: "GRN",
      externalRef: extRef,
      description: `GRN confirmed - inventory capitalization (${row.warehouse_name})`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, entryId, [
      { accountId: inventory, debit: amount, credit: 0, narration: "Inventory received" },
      { accountId: grnClearing, debit: 0, credit: amount, narration: "GRN accrual" },
    ])
  }

  const dispatchedDos = await fetchDoSourceRows(db, companyId)
  for (const row of dispatchedDos) {
    const amount = Number(row.amount || 0)
    const extRef = `DO-${row.source_id}-DISPATCH`
    const entryId = await upsertEntry(db, {
      companyId,
      entryDate: row.txn_date,
      sourceId: row.source_id,
      entryType: "DO_DISPATCH",
      sourceModule: "DO",
      externalRef: extRef,
      description: `DO dispatched - COGS recognition (${row.do_number})`,
      postedBy,
    })
    await replaceEntryLines(db, companyId, entryId, [
      { accountId: cogs, debit: amount, credit: 0, narration: "Cost of goods sold" },
      { accountId: inventory, debit: 0, credit: amount, narration: "Inventory issued" },
    ])
  }
}

export async function syncFinanceLedgerInTransaction(db: DBClient, companyId: number, postedBy?: number) {
  await syncFinanceLedgerCore(db, companyId, postedBy)
}

export async function syncFinanceLedger(companyId: number, postedBy?: number) {
  const db = (await getClient()) as unknown as DBClient
  try {
    await db.query("BEGIN")
    await syncFinanceLedgerCore(db, companyId, postedBy)
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
}

export async function syncInvoiceLedger(companyId: number, postedBy?: number) {
  return syncFinanceLedger(companyId, postedBy)
}
