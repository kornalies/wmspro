type DBClient = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

type ChargeType =
  | "INBOUND_HANDLING"
  | "OUTBOUND_HANDLING"
  | "STORAGE"
  | "VAS"
  | "FIXED"
  | "MINIMUM"
  | "ADJUSTMENT"

type SourceType = "GRN" | "DO" | "VAS" | "STORAGE" | "MANUAL"
type SupplyType = "INTRA_STATE" | "INTER_STATE"
type CalcMethod = "FLAT" | "PER_UNIT" | "SLAB" | "PERCENT"
type SlabMode = "ABSOLUTE" | "MARGINAL"
type BillingCycle = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
const OPERATIONAL_CHARGE_TYPES: ChargeType[] = ["OUTBOUND_HANDLING", "STORAGE", "VAS"]

function toNum(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function monthLabel(dateIso: string) {
  return new Date(dateIso).toLocaleString("en-IN", { month: "short", year: "numeric" })
}

function parseIsoDateUtc(value: string) {
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function toIsoDateUtc(date: Date) {
  return date.toISOString().slice(0, 10)
}

function endOfMonthUtc(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0))
}

function startOfQuarterUtc(year: number, quarterIndex: number) {
  return new Date(Date.UTC(year, quarterIndex * 3, 1))
}

function endOfQuarterUtc(year: number, quarterIndex: number) {
  return new Date(Date.UTC(year, quarterIndex * 3 + 3, 0))
}

function isoDayOfWeek(date: Date) {
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

function billingCycleWindow(
  cycle: BillingCycle,
  runDateIso: string,
  billingDayOfWeek?: number | null,
  billingDayOfMonth?: number | null,
  contractEffectiveFromIso?: string | null
) {
  const runDate = parseIsoDateUtc(runDateIso)
  if (!runDate) return { isDue: false, periodFrom: null, periodTo: null, reason: "Invalid run date" }

  if (cycle === "WEEKLY") {
    const dueDow = Math.max(Math.min(toNum(billingDayOfWeek, 7), 7), 1)
    const runDow = isoDayOfWeek(runDate)
    if (runDow !== dueDow) {
      return { isDue: false, periodFrom: null, periodTo: null, reason: `Not due for weekly cycle day ${dueDow}` }
    }
    const from = new Date(runDate)
    from.setUTCDate(from.getUTCDate() - 6)
    return { isDue: true, periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(runDate), reason: null }
  }

  if (cycle === "MONTHLY") {
    const y = runDate.getUTCFullYear()
    const m = runDate.getUTCMonth()
    const monthEnd = endOfMonthUtc(y, m)
    const dueDom = billingDayOfMonth && billingDayOfMonth > 0 ? Math.min(billingDayOfMonth, monthEnd.getUTCDate()) : monthEnd.getUTCDate()
    if (runDate.getUTCDate() !== dueDom) {
      return { isDue: false, periodFrom: null, periodTo: null, reason: `Not due for monthly cycle day ${dueDom}` }
    }
    const from = new Date(Date.UTC(y, m, 1))
    return { isDue: true, periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(runDate), reason: null }
  }

  if (cycle === "QUARTERLY") {
    const y = runDate.getUTCFullYear()
    const q = Math.floor(runDate.getUTCMonth() / 3)
    const quarterEnd = endOfQuarterUtc(y, q)
    if (toIsoDateUtc(runDate) !== toIsoDateUtc(quarterEnd)) {
      return { isDue: false, periodFrom: null, periodTo: null, reason: "Not quarter end date" }
    }
    const from = startOfQuarterUtc(y, q)
    return { isDue: true, periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(runDate), reason: null }
  }

  const contractDate = contractEffectiveFromIso ? parseIsoDateUtc(contractEffectiveFromIso) : null
  if (!contractDate) {
    return { isDue: false, periodFrom: null, periodTo: null, reason: "Contract anniversary unavailable for yearly cycle" }
  }
  const annivMonth = contractDate.getUTCMonth()
  const annivDay = contractDate.getUTCDate()
  const runYear = runDate.getUTCFullYear()
  const thisYearMaxDay = endOfMonthUtc(runYear, annivMonth).getUTCDate()
  const thisYearAnniv = new Date(Date.UTC(runYear, annivMonth, Math.min(annivDay, thisYearMaxDay)))
  if (toIsoDateUtc(thisYearAnniv) !== toIsoDateUtc(runDate)) {
    return { isDue: false, periodFrom: null, periodTo: null, reason: "Not contract anniversary date" }
  }
  const prevYear = runYear - 1
  const prevYearMaxDay = endOfMonthUtc(prevYear, annivMonth).getUTCDate()
  const prevAnniv = new Date(Date.UTC(prevYear, annivMonth, Math.min(annivDay, prevYearMaxDay)))
  const from = new Date(prevAnniv)
  from.setUTCDate(from.getUTCDate() + 1)
  return { isDue: true, periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(runDate), reason: null }
}

async function resolveSupplyType(
  db: DBClient,
  companyId: number,
  clientId: number,
  warehouseId?: number | null
): Promise<SupplyType> {
  if (!warehouseId) return "INTRA_STATE"
  const result = await db.query(
    `SELECT
       CASE
         WHEN UPPER(COALESCE(c.state, '')) = UPPER(COALESCE(w.state, '')) THEN 'INTRA_STATE'
         ELSE 'INTER_STATE'
       END AS supply_type
     FROM clients c
     JOIN warehouses w ON w.id = $3
     WHERE c.id = $2
       AND c.company_id = $1
     LIMIT 1`,
    [companyId, clientId, warehouseId]
  )
  return (result.rows[0]?.supply_type as SupplyType) || "INTRA_STATE"
}

function computeTax(amount: number, gstRate: number, supplyType: SupplyType) {
  const tax = Number(((amount * gstRate) / 100).toFixed(2))
  if (supplyType === "INTER_STATE") {
    return {
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: tax,
      totalTaxAmount: tax,
      grossAmount: Number((amount + tax).toFixed(2)),
    }
  }
  const half = Number((tax / 2).toFixed(2))
  return {
    cgstAmount: half,
    sgstAmount: half,
    igstAmount: 0,
    totalTaxAmount: Number((half + half).toFixed(2)),
    grossAmount: Number((amount + half + half).toFixed(2)),
  }
}

export async function assertInvoiceOperationalValueCompliance(
  db: DBClient,
  args: { companyId: number; invoiceId: number }
) {
  const result = await db.query(
    `SELECT
       COALESCE(ih.taxable_amount, 0)::numeric AS taxable_amount,
       COALESCE(
         SUM(
           CASE
             WHEN il.charge_type = ANY($3::text[]) THEN COALESCE(il.quantity, 0)
             ELSE 0
           END
         ),
         0
       )::numeric AS operational_qty
     FROM invoice_header ih
     LEFT JOIN invoice_lines il
       ON il.company_id = ih.company_id
      AND il.invoice_id = ih.id
     WHERE ih.company_id = $1
       AND ih.id = $2
     GROUP BY ih.id, ih.taxable_amount`,
    [args.companyId, args.invoiceId, OPERATIONAL_CHARGE_TYPES]
  )

  if (!result.rows.length) return
  const taxableAmount = toNum(result.rows[0].taxable_amount)
  const operationalQty = toNum(result.rows[0].operational_qty)
  if (taxableAmount <= 0 && operationalQty > 0) {
    throw new Error(
      "Invoice taxable amount is zero while operational activity exists (Dispatch/Storage/VAS). Update rates before finalize/send."
    )
  }
}

async function resolveRate(
  db: DBClient,
  companyId: number,
  clientId: number,
  chargeType: ChargeType,
  eventDate: string,
  quantity: number,
  baseAmount?: number | null,
  itemId?: number | null
) {
  const masterRes = await db.query(
    `SELECT crm.id
     FROM client_rate_master crm
     WHERE crm.company_id = $1
       AND crm.client_id = $2
       AND crm.is_active = true
       AND crm.effective_from <= $3::date
       AND (crm.effective_to IS NULL OR crm.effective_to >= $3::date)
     ORDER BY crm.priority ASC, crm.effective_from DESC, crm.id DESC
     LIMIT 1`,
    [companyId, clientId, eventDate]
  )

  if (masterRes.rows.length) {
    const rateMasterId = toNum(masterRes.rows[0].id)
    const detailRes = await db.query(
      `SELECT
         crd.id AS rate_detail_id,
         crd.calc_method,
         COALESCE(crd.slab_mode, 'ABSOLUTE') AS slab_mode,
         crd.item_id,
         COALESCE(crd.min_qty, 0)::numeric AS min_qty,
         crd.max_qty::numeric AS max_qty,
         COALESCE(crd.free_qty, 0)::numeric AS free_qty,
         COALESCE(crd.unit_rate, 0)::numeric AS unit_rate,
         COALESCE(crd.min_charge, 0)::numeric AS min_charge,
         crd.max_charge::numeric AS max_charge,
         COALESCE(crd.gst_rate, 18)::numeric AS gst_rate
       FROM client_rate_details crd
        WHERE crd.company_id = $1
          AND crd.rate_master_id = $2
          AND crd.is_active = true
          AND crd.charge_type = $3
          AND (crd.item_id IS NULL OR crd.item_id = $4)
        ORDER BY
          CASE WHEN crd.item_id = $4 THEN 0 ELSE 1 END,
          COALESCE(crd.min_qty, 0) ASC,
          crd.id ASC`,
      [companyId, rateMasterId, chargeType, itemId ?? null]
    )

    if (detailRes.rows.length) {
      const q = Math.max(toNum(quantity), 0)
      const matching =
        detailRes.rows.find((row) => {
          const min = toNum(row.min_qty, 0)
          const maxValue = row.max_qty
          const max = maxValue === null || maxValue === undefined ? Number.POSITIVE_INFINITY : toNum(maxValue, Number.POSITIVE_INFINITY)
          return q >= min && q <= max
        }) ?? detailRes.rows[detailRes.rows.length - 1]

      const calcMethod = String(matching.calc_method || "PER_UNIT") as CalcMethod
      const slabMode = String(matching.slab_mode || "ABSOLUTE") as SlabMode
      const freeQty = Math.max(toNum(matching.free_qty, 0), 0)
      const unitRate = toNum(matching.unit_rate, 0)
      const minCharge = Math.max(toNum(matching.min_charge, 0), 0)
      const maxCharge =
        matching.max_charge === null || matching.max_charge === undefined
          ? null
          : Math.max(toNum(matching.max_charge, 0), 0)

      const billableQty = Math.max(q - freeQty, 0)
      let amount = 0

      if (calcMethod === "FLAT") {
        amount = unitRate
      } else if (calcMethod === "PERCENT") {
        const base = toNum(baseAmount, NaN)
        if (!Number.isFinite(base) || base <= 0) {
          return {
            isResolved: false,
            reason: "PERCENT rate requires base_amount > 0",
            rateMasterId: rateMasterId || null,
            rateDetailId: toNum(matching.rate_detail_id) || null,
            rate: 0,
            amount: 0,
            gstRate: toNum(matching.gst_rate, 18),
          }
        }
        amount = (base * unitRate) / 100
      } else if (calcMethod === "SLAB" && slabMode === "MARGINAL") {
        let marginalAmount = 0
        for (const row of detailRes.rows) {
          const min = Math.max(toNum(row.min_qty, 0), 0)
          const maxValue = row.max_qty
          const max =
            maxValue === null || maxValue === undefined
              ? Number.POSITIVE_INFINITY
              : toNum(maxValue, Number.POSITIVE_INFINITY)
          const bandQty = Math.max(Math.min(billableQty, max) - min, 0)
          if (bandQty > 0) {
            marginalAmount += bandQty * toNum(row.unit_rate, 0)
          }
        }
        if (marginalAmount === 0 && billableQty > 0) {
          // If slab configuration is sparse/invalid, preserve prior behavior by using the matched band rate.
          marginalAmount = billableQty * unitRate
        }
        amount = marginalAmount
      } else {
        // PER_UNIT and SLAB(ABSOLUTE) both use per-unit valuation with matching band selection.
        amount = billableQty * unitRate
      }

      if (amount < minCharge) amount = minCharge
      if (maxCharge !== null && amount > maxCharge) amount = maxCharge

      amount = Number(amount.toFixed(2))
      const effectiveRate = q > 0 ? Number((amount / q).toFixed(4)) : Number(amount.toFixed(4))

      return {
        isResolved: true,
        rateMasterId: rateMasterId || null,
        rateDetailId: toNum(matching.rate_detail_id) || null,
        rate: effectiveRate,
        amount,
        gstRate: toNum(matching.gst_rate, 18),
      }
    }
  }

  const fallbackContract = await db.query(
    `SELECT
       COALESCE(storage_rate_per_unit, 0)::numeric AS storage_rate,
       COALESCE(handling_rate_per_unit, 0)::numeric AS handling_rate
     FROM client_contracts
     WHERE company_id = $1
       AND client_id = $2
       AND is_active = true
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`,
    [companyId, clientId]
  )
  if (!fallbackContract.rows.length) {
    return { isResolved: false, rateMasterId: null, rateDetailId: null, rate: 0, gstRate: 18 }
  }
  const row = fallbackContract.rows[0]
  const rate =
    chargeType === "STORAGE"
      ? toNum(row.storage_rate)
      : chargeType === "INBOUND_HANDLING" || chargeType === "OUTBOUND_HANDLING"
        ? toNum(row.handling_rate)
        : 0
  const amount = Number((Math.max(toNum(quantity), 0) * rate).toFixed(2))
  return { isResolved: true, rateMasterId: null, rateDetailId: null, rate, amount, gstRate: 18 }
}

export async function stageChargeTransaction(
  db: DBClient,
    args: {
    companyId: number
    userId?: number
    clientId: number
    warehouseId?: number | null
    chargeType: ChargeType
    sourceType: SourceType
    sourceDocId?: number | null
    sourceLineId?: number | null
    sourceRefNo?: string | null
    eventDate: string
    periodFrom?: string | null
    periodTo?: string | null
    quantity: number
    baseAmount?: number
    itemId?: number | null
    uom?: string
    remarks?: string | null
  }
) {
  const qty = toNum(args.quantity)
  const rateInfo = await resolveRate(
    db,
    args.companyId,
    args.clientId,
    args.chargeType,
    args.eventDate,
    qty,
    args.baseAmount ?? null,
    args.itemId ?? null
  )
  const supplyType = await resolveSupplyType(db, args.companyId, args.clientId, args.warehouseId)
  const status = rateInfo.isResolved ? "UNBILLED" : "UNRATED"
  const amount = rateInfo.isResolved ? Number(toNum(rateInfo.amount, qty * rateInfo.rate).toFixed(2)) : 0
  const taxes = rateInfo.isResolved
    ? computeTax(amount, rateInfo.gstRate, supplyType)
    : {
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        totalTaxAmount: 0,
        grossAmount: 0,
      }

  await db.query(
    `INSERT INTO billing_transactions (
       company_id, client_id, warehouse_id, charge_type, source_type, source_doc_id, source_line_id, source_ref_no,
       event_date, period_from, period_to, uom, quantity, rate, amount, tax_code, gst_rate, cgst_amount, sgst_amount,
       igst_amount, total_tax_amount, gross_amount, status, rate_master_id, rate_detail_id, remarks, created_by, updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11::date,$12,$13,$14,$15,'GST',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26
     )
     ON CONFLICT (
       company_id,
       source_type,
       COALESCE(source_doc_id, 0),
       COALESCE(source_line_id, 0),
       charge_type,
       event_date,
       COALESCE(period_from, event_date),
       COALESCE(period_to, event_date)
     )
     DO UPDATE SET
       quantity = EXCLUDED.quantity,
       rate = EXCLUDED.rate,
       amount = EXCLUDED.amount,
       gst_rate = EXCLUDED.gst_rate,
       cgst_amount = EXCLUDED.cgst_amount,
       sgst_amount = EXCLUDED.sgst_amount,
       igst_amount = EXCLUDED.igst_amount,
       total_tax_amount = EXCLUDED.total_tax_amount,
       gross_amount = EXCLUDED.gross_amount,
       rate_master_id = EXCLUDED.rate_master_id,
       rate_detail_id = EXCLUDED.rate_detail_id,
       status = CASE
         WHEN billing_transactions.status = 'BILLED' THEN billing_transactions.status
         WHEN billing_transactions.status = 'VOID' THEN billing_transactions.status
         ELSE EXCLUDED.status
       END,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
    [
      args.companyId,
      args.clientId,
      args.warehouseId ?? null,
      args.chargeType,
      args.sourceType,
      args.sourceDocId ?? null,
      args.sourceLineId ?? null,
      args.sourceRefNo ?? null,
      args.eventDate,
      args.periodFrom ?? null,
      args.periodTo ?? null,
      args.uom || "UNIT",
      qty,
      rateInfo.rate,
      amount,
      rateInfo.gstRate,
      taxes.cgstAmount,
      taxes.sgstAmount,
      taxes.igstAmount,
      taxes.totalTaxAmount,
      taxes.grossAmount,
      status,
      rateInfo.rateMasterId,
      rateInfo.rateDetailId,
      args.remarks ?? (rateInfo.isResolved ? null : "Rate missing: staged as UNRATED"),
      args.userId ?? null,
    ]
  )
}

export async function createStorageSnapshot(
  db: DBClient,
  args: { companyId: number; snapshotDate: string; userId?: number; runKey: string }
) {
  await db.query(
    `INSERT INTO storage_snapshot (
       company_id, client_id, warehouse_id, snapshot_date, item_id, uom, units_in_stock, source_mode, job_run_ref
     )
     SELECT
       ssn.company_id,
       ssn.client_id,
       ssn.warehouse_id,
       $2::date AS snapshot_date,
       ssn.item_id,
       'UNIT' AS uom,
       COUNT(*)::int AS units_in_stock,
       'SNAPSHOT' AS source_mode,
       $3 AS job_run_ref
     FROM stock_serial_numbers ssn
     WHERE ssn.company_id = $1
       AND ssn.status = 'IN_STOCK'
     GROUP BY ssn.company_id, ssn.client_id, ssn.warehouse_id, ssn.item_id
     ON CONFLICT (company_id, client_id, warehouse_id, snapshot_date, COALESCE(item_id, 0))
     DO UPDATE SET
       units_in_stock = EXCLUDED.units_in_stock,
       source_mode = EXCLUDED.source_mode,
       job_run_ref = EXCLUDED.job_run_ref`,
    [args.companyId, args.snapshotDate, args.runKey]
  )

  const storageRows = await db.query(
    `SELECT
       ss.id,
       ss.client_id,
       ss.warehouse_id,
       ss.item_id,
       ss.snapshot_date::text AS snapshot_date,
       ss.uom,
       COALESCE(ss.units_in_stock, 0)::numeric AS quantity
     FROM storage_snapshot ss
     WHERE ss.company_id = $1
       AND ss.snapshot_date = $2::date
       AND COALESCE(ss.units_in_stock, 0) > 0`,
    [args.companyId, args.snapshotDate]
  )

  for (const row of storageRows.rows) {
    const snapshotId = toNum(row.id)
    const itemId = row.item_id === null || row.item_id === undefined ? null : toNum(row.item_id)
    const snapshotDate = String(row.snapshot_date || args.snapshotDate).slice(0, 10)
    const warehouseId = toNum(row.warehouse_id) || null
    const clientId = toNum(row.client_id)
    const quantity = toNum(row.quantity, 0)
    const sourceRef = `STG-${snapshotDate.replaceAll("-", "")}-${clientId}-${warehouseId || 0}-${itemId || 0}`

    await stageChargeTransaction(db, {
      companyId: args.companyId,
      userId: args.userId,
      clientId,
      warehouseId,
      chargeType: "STORAGE",
      sourceType: "STORAGE",
      sourceDocId: snapshotId || null,
      sourceLineId: itemId,
      sourceRefNo: sourceRef,
      eventDate: snapshotDate,
      periodFrom: snapshotDate,
      periodTo: snapshotDate,
      quantity,
      itemId,
      uom: String(row.uom || "UNIT"),
      remarks: "Storage snapshot rated via active storage rate",
    })
  }
}

async function nextInvoiceNumber(
  db: DBClient,
  companyId: number,
  invoiceDate: string,
  prefix: string
) {
  const seq = await db.query(
    `INSERT INTO billing_invoice_seq (company_id, last_seq, updated_at)
     VALUES ($1, 1, CURRENT_TIMESTAMP)
     ON CONFLICT (company_id)
     DO UPDATE SET last_seq = billing_invoice_seq.last_seq + 1, updated_at = CURRENT_TIMESTAMP
     RETURNING last_seq`,
    [companyId]
  )
  const next = Number(seq.rows[0]?.last_seq || 1)
  return `${prefix}-${new Date(invoiceDate).toISOString().slice(0, 7).replace("-", "")}-${String(next).padStart(6, "0")}`
}

async function getClientProfile(db: DBClient, companyId: number, clientId: number) {
  const row = await db.query(
    `SELECT
       billing_cycle,
       credit_days,
       currency,
       invoice_prefix,
       minimum_billing_enabled,
       minimum_billing_amount
     FROM client_billing_profile
     WHERE company_id = $1
       AND client_id = $2
       AND is_active = true
     LIMIT 1`,
    [companyId, clientId]
  )
  return row.rows[0] || null
}

export async function generateInvoiceDrafts(
  db: DBClient,
  args: {
    companyId: number
    userId?: number
    periodFrom: string
    periodTo: string
    clientId?: number | null
    runKey: string
  }
) {
  const params: unknown[] = [args.companyId, args.periodFrom, args.periodTo]
  const clientFilter = args.clientId ? "AND bt.client_id = $4" : ""
  if (args.clientId) params.push(args.clientId)

  const clientsRes = await db.query(
    `SELECT DISTINCT bt.client_id
     FROM billing_transactions bt
     WHERE bt.company_id = $1
       AND bt.status = 'UNBILLED'
       AND bt.event_date BETWEEN $2::date AND $3::date
       ${clientFilter}
     ORDER BY bt.client_id`,
    params
  )
  let generatedCount = 0

  for (const row of clientsRes.rows) {
    const clientId = Number(row.client_id)
    const profile = await getClientProfile(db, args.companyId, clientId)
    const currency = String(profile?.currency || "INR")
    const prefix = String(profile?.invoice_prefix || "INV")
    const creditDays = toNum(profile?.credit_days, 30)

    const existingRes = await db.query(
      `SELECT id, status, paid_amount
       FROM invoice_header
       WHERE company_id = $1
         AND client_id = $2
         AND period_from = $3::date
         AND period_to = $4::date
       LIMIT 1`,
      [args.companyId, clientId, args.periodFrom, args.periodTo]
    )
    let invoiceId: number
    if (existingRes.rows.length) {
      const existing = existingRes.rows[0]
      if (existing.status !== "DRAFT") {
        continue
      }
      invoiceId = Number(existing.id)
      await db.query(`DELETE FROM invoice_tax_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, invoiceId])
      await db.query(`DELETE FROM invoice_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, invoiceId])
    } else {
      const invoiceDate = args.periodTo
      const due = new Date(`${invoiceDate}T00:00:00.000Z`)
      due.setUTCDate(due.getUTCDate() + creditDays)
      const invoiceNumber = await nextInvoiceNumber(db, args.companyId, invoiceDate, prefix)
      const created = await db.query(
        `INSERT INTO invoice_header (
           company_id, invoice_number, client_id, billing_cycle, period_from, period_to, billing_period,
           invoice_date, due_date, currency, status, draft_run_key, created_by, updated_by
         ) VALUES (
           $1,$2,$3,$4,$5::date,$6::date,$7,$8::date,$9::date,$10,'DRAFT',$11,$12,$12
         )
         RETURNING id`,
        [
          args.companyId,
          invoiceNumber,
          clientId,
          String(profile?.billing_cycle || "MONTHLY"),
          args.periodFrom,
          args.periodTo,
          monthLabel(args.periodFrom),
          invoiceDate,
          due.toISOString().slice(0, 10),
          currency,
          args.runKey,
          args.userId ?? null,
        ]
      )
      invoiceId = Number(created.rows[0].id)
    }

    const txns = await db.query(
      `SELECT *
       FROM billing_transactions
       WHERE company_id = $1
         AND client_id = $2
         AND status = 'UNBILLED'
         AND event_date BETWEEN $3::date AND $4::date
       ORDER BY event_date, id`,
      [args.companyId, clientId, args.periodFrom, args.periodTo]
    )

    let lineNo = 1
    for (const tx of txns.rows) {
      const lineRes = await db.query(
        `INSERT INTO invoice_lines (
           company_id, invoice_id, line_no, charge_type, description, source_type, source_doc_id, source_line_id, source_ref_no,
           period_from, period_to, uom, quantity, rate, amount, tax_code, gst_rate, cgst_amount, sgst_amount, igst_amount,
           total_tax_amount, gross_amount
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
         )
         RETURNING id`,
        [
          args.companyId,
          invoiceId,
          lineNo,
          tx.charge_type,
          `${tx.charge_type} (${tx.source_type}:${tx.source_ref_no || tx.source_doc_id || tx.id})`,
          tx.source_type,
          tx.source_doc_id,
          tx.source_line_id,
          tx.source_ref_no,
          tx.period_from,
          tx.period_to,
          tx.uom,
          tx.quantity,
          tx.rate,
          tx.amount,
          tx.tax_code,
          tx.gst_rate,
          tx.cgst_amount,
          tx.sgst_amount,
          tx.igst_amount,
          tx.total_tax_amount,
          tx.gross_amount,
        ]
      )
      const invoiceLineId = Number(lineRes.rows[0].id)
      if (toNum(tx.cgst_amount) > 0) {
        await db.query(
          `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
           VALUES ($1,$2,$3,'CGST',$4,$5,$6)`,
          [args.companyId, invoiceId, invoiceLineId, toNum(tx.gst_rate) / 2, tx.amount, tx.cgst_amount]
        )
      }
      if (toNum(tx.sgst_amount) > 0) {
        await db.query(
          `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
           VALUES ($1,$2,$3,'SGST',$4,$5,$6)`,
          [args.companyId, invoiceId, invoiceLineId, toNum(tx.gst_rate) / 2, tx.amount, tx.sgst_amount]
        )
      }
      if (toNum(tx.igst_amount) > 0) {
        await db.query(
          `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
           VALUES ($1,$2,$3,'IGST',$4,$5,$6)`,
          [args.companyId, invoiceId, invoiceLineId, tx.gst_rate, tx.amount, tx.igst_amount]
        )
      }
      lineNo += 1
    }

    const totals = await db.query(
      `SELECT
         COALESCE(SUM(amount), 0)::numeric AS taxable_amount,
         COALESCE(SUM(cgst_amount), 0)::numeric AS cgst_amount,
         COALESCE(SUM(sgst_amount), 0)::numeric AS sgst_amount,
         COALESCE(SUM(igst_amount), 0)::numeric AS igst_amount,
         COALESCE(SUM(total_tax_amount), 0)::numeric AS total_tax_amount,
         COALESCE(SUM(gross_amount), 0)::numeric AS grand_total
       FROM invoice_lines
       WHERE company_id = $1
         AND invoice_id = $2`,
      [args.companyId, invoiceId]
    )
    const t = totals.rows[0]
    const grandTotal = toNum(t.grand_total)
    await db.query(
      `UPDATE invoice_header
       SET taxable_amount = $1,
           cgst_amount = $2,
           sgst_amount = $3,
           igst_amount = $4,
           total_tax_amount = $5,
           grand_total = $6,
           balance_amount = GREATEST($6 - COALESCE(paid_amount, 0), 0),
           updated_by = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $8
         AND id = $9`,
      [
        t.taxable_amount,
        t.cgst_amount,
        t.sgst_amount,
        t.igst_amount,
        t.total_tax_amount,
        grandTotal,
        args.userId ?? null,
        args.companyId,
        invoiceId,
      ]
    )

    await db.query(
      `UPDATE billing_transactions bt
       SET status = 'BILLED',
           billed_at = CURRENT_TIMESTAMP,
           billed_by = $1,
           invoice_id = $2,
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE bt.company_id = $3
         AND bt.client_id = $4
         AND bt.status = 'UNBILLED'
         AND bt.event_date BETWEEN $5::date AND $6::date`,
      [args.userId ?? null, invoiceId, args.companyId, clientId, args.periodFrom, args.periodTo]
    )
    generatedCount += 1
  }

  return { generatedCount }
}

export async function generateInvoiceDraftsByBillingCycle(
  db: DBClient,
  args: {
    companyId: number
    userId?: number
    runDate: string
    runKeyPrefix: string
    clientId?: number | null
  }
) {
  const params: unknown[] = [args.companyId]
  const clientFilter = args.clientId ? "AND cbp.client_id = $2" : ""
  if (args.clientId) params.push(args.clientId)

  const profileRes = await db.query(
    `SELECT
       cbp.client_id,
       cbp.billing_cycle,
       cbp.billing_day_of_week,
       cbp.billing_day_of_month,
       cc.effective_from::text AS contract_effective_from
     FROM client_billing_profile cbp
     LEFT JOIN LATERAL (
       SELECT effective_from
       FROM client_contracts
       WHERE company_id = cbp.company_id
         AND client_id = cbp.client_id
         AND is_active = true
       ORDER BY effective_from DESC, id DESC
       LIMIT 1
     ) cc ON true
     WHERE cbp.company_id = $1
       AND cbp.is_active = true
       ${clientFilter}
     ORDER BY cbp.client_id`,
    params
  )

  let generatedCount = 0
  let dueClientCount = 0
  const skipped: Array<{ clientId: number; reason: string }> = []
  const windows: Array<{ clientId: number; cycle: string; periodFrom: string; periodTo: string; runKey: string; generated: number }> = []

  for (const row of profileRes.rows) {
    const clientId = toNum(row.client_id)
    const cycle = String(row.billing_cycle || "MONTHLY") as BillingCycle
    const window = billingCycleWindow(
      cycle,
      args.runDate,
      toNum(row.billing_day_of_week, 0) || null,
      toNum(row.billing_day_of_month, 0) || null,
      (row.contract_effective_from as string | null) || null
    )
    if (!window.isDue || !window.periodFrom || !window.periodTo) {
      skipped.push({ clientId, reason: window.reason || "Not due" })
      continue
    }
    dueClientCount += 1
    const runKey = `${args.runKeyPrefix}-${clientId}-${window.periodFrom}-${window.periodTo}`
    const summary = await generateInvoiceDrafts(db, {
      companyId: args.companyId,
      userId: args.userId,
      periodFrom: window.periodFrom,
      periodTo: window.periodTo,
      clientId,
      runKey,
    })
    generatedCount += toNum(summary.generatedCount, 0)
    windows.push({
      clientId,
      cycle,
      periodFrom: window.periodFrom,
      periodTo: window.periodTo,
      runKey,
      generated: toNum(summary.generatedCount, 0),
    })
  }

  return {
    generatedCount,
    dueClientCount,
    profileCount: profileRes.rows.length,
    skippedCount: skipped.length,
    skipped,
    windows,
  }
}

export async function finalizeInvoice(
  db: DBClient,
  args: { companyId: number; invoiceId: number; userId?: number }
) {
  const invoiceRes = await db.query(
    `SELECT id, status, grand_total, paid_amount, due_date
     FROM invoice_header
     WHERE company_id = $1
       AND id = $2
     FOR UPDATE`,
    [args.companyId, args.invoiceId]
  )
  if (!invoiceRes.rows.length) {
    throw new Error("Invoice not found")
  }
  await assertInvoiceOperationalValueCompliance(db, {
    companyId: args.companyId,
    invoiceId: args.invoiceId,
  })
  const row = invoiceRes.rows[0]
  const currentStatus = String(row.status ?? "")
  if (currentStatus !== "DRAFT") {
    throw new Error("Only draft invoice can be finalized")
  }

  const balance = Math.max(toNum(row.grand_total) - toNum(row.paid_amount), 0)
  const dueDateSource = row.due_date
  const dueDateValue =
    typeof dueDateSource === "string" || typeof dueDateSource === "number" || dueDateSource instanceof Date
      ? dueDateSource
      : new Date().toISOString()
  const dueDate = new Date(dueDateValue)
  const status = balance <= 0 ? "PAID" : dueDate < new Date() ? "OVERDUE" : "FINALIZED"

  await db.query(
    `UPDATE invoice_header
     SET status = $1,
         balance_amount = $2,
         finalized_at = CURRENT_TIMESTAMP,
         finalized_by = $3,
         updated_by = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE company_id = $4
       AND id = $5`,
    [status, balance, args.userId ?? null, args.companyId, args.invoiceId]
  )
  return { status, balance }
}
