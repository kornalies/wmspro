import { type BillingCycle, billingDuePeriods, daysInCycle } from "@/lib/billing-cycle"
import { DEFAULT_GST_RATE, computeGstSplit, round2 } from "@/lib/money"

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
const OPERATIONAL_CHARGE_TYPES: ChargeType[] = ["INBOUND_HANDLING", "OUTBOUND_HANDLING", "STORAGE", "VAS"]

function toNum(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function monthLabel(dateIso: string) {
  return new Date(dateIso).toLocaleString("en-IN", { month: "short", year: "numeric" })
}

const BILLING_CYCLES: BillingCycle[] = ["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]

function normalizeCycle(value: unknown): BillingCycle {
  const cycle = String(value || "").toUpperCase() as BillingCycle
  return BILLING_CYCLES.includes(cycle) ? cycle : "MONTHLY"
}

/**
 * How many storage charges one configured rate has to be spread across.
 *
 * Storage rates are configured per unit per billing CYCLE (`client_rate_master.billing_cycle`,
 * `client_contracts.billing_cycle`) but storage is staged one charge per DAILY snapshot, with
 * period_from = period_to = the snapshot date. Charging the configured figure on each snapshot
 * bills the same resting stock a full cycle's storage every day — 31x over for a MONTHLY rate,
 * which is how one client picked up two identical 12,000 storage lines in a single week.
 *
 * Only STORAGE is divided: handling and VAS are priced per event, not per day of tenure.
 * PERCENT is left alone because its base amount already carries a period of its own, so
 * dividing again would prorate twice.
 */
function storageDailyDivisor(
  chargeType: ChargeType,
  calcMethod: CalcMethod,
  cycle: unknown,
  eventDate: string
) {
  if (chargeType !== "STORAGE" || calcMethod === "PERCENT") return 1
  return Math.max(daysInCycle(normalizeCycle(cycle), eventDate), 1)
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
  // Delegated to the shared money helper so every charge, invoice line, and note rounds identically
  // (integer-paise) and CGST + SGST always reconciles to the total tax.
  return computeGstSplit(amount, gstRate, supplyType)
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
    `SELECT crm.id, crm.billing_cycle
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

      // Spread a per-cycle storage rate across the days of that cycle before the per-charge
      // floor/ceiling apply, so min_charge/max_charge keep meaning "per staged charge".
      const divisor = storageDailyDivisor(chargeType, calcMethod, masterRes.rows[0].billing_cycle, eventDate)
      if (divisor > 1) amount = amount / divisor

      if (amount < minCharge) amount = minCharge
      if (maxCharge !== null && amount > maxCharge) amount = maxCharge

      amount = round2(amount)
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
       COALESCE(handling_rate_per_unit, 0)::numeric AS handling_rate,
       billing_cycle
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
  const configuredRate =
    chargeType === "STORAGE"
      ? toNum(row.storage_rate)
      : chargeType === "INBOUND_HANDLING" || chargeType === "OUTBOUND_HANDLING"
        ? toNum(row.handling_rate)
        : 0
  // Same per-cycle-to-per-day division as the rate-card path above: storage_rate_per_unit is
  // quoted against the contract's billing_cycle, and storage is staged once per daily snapshot.
  const divisor = storageDailyDivisor(chargeType, "PER_UNIT", row.billing_cycle, eventDate)
  const rate = divisor > 1 ? Number((configuredRate / divisor).toFixed(4)) : configuredRate
  const amount = round2(Math.max(toNum(quantity), 0) * rate)
  return { isResolved: true, rateMasterId: null, rateDetailId: null, rate, amount, gstRate: DEFAULT_GST_RATE }
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
  const amount = rateInfo.isResolved ? round2(toNum(rateInfo.amount, qty * rateInfo.rate)) : 0
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
  const conflicts: Array<{
    clientId: number
    invoiceId: number
    invoiceNumber: string
    status: string
    periodFrom: string
    periodTo: string
  }> = []

  for (const row of clientsRes.rows) {
    const clientId = Number(row.client_id)
    // Serialize concurrent generation for the same (company, client). Two runs racing the same
    // UNBILLED pool would otherwise both select the rows, both build lines, and collide on
    // uq_invoice_header_company_client_period (surfacing as a 500). The xact-scoped lock makes the
    // second run wait for the first to commit, then it correctly finds the pool already BILLED.
    await db.query(`SELECT pg_advisory_xact_lock($1, $2)`, [args.companyId, clientId])
    const profile = await getClientProfile(db, args.companyId, clientId)
    const currency = String(profile?.currency || "INR")
    const prefix = String(profile?.invoice_prefix || "INV")
    const creditDays = toNum(profile?.credit_days, 30)

    // VOID is excluded deliberately (and uq_invoice_header_company_client_period is partial on
    // the same condition, see migration 078). A voided invoice has already released its charges
    // for re-invoicing; treating its shell as the period's occupant pushed the replacement into
    // the supplementary branch below, which reissued it under a period narrowed to the surviving
    // charges instead of the client's actual cycle.
    const existingRes = await db.query(
      `SELECT id, status, paid_amount
       FROM invoice_header
       WHERE company_id = $1
         AND client_id = $2
         AND period_from = $3::date
         AND period_to = $4::date
         AND status <> 'VOID'
       LIMIT 1`,
      [args.companyId, clientId, args.periodFrom, args.periodTo]
    )

    // Overlap guard. uq_invoice_header_company_client_period only makes the EXACT
    // (period_from, period_to) tuple unique, so a request for a window that merely *contains*
    // an existing invoice's window sails straight past it and raises a second invoice covering
    // days the client has already been invoiced for. No charge is billed twice — the earlier
    // invoice's transactions are already BILLED — but the client receives two invoices whose
    // periods overlap, which is indistinguishable from double billing at the point it matters.
    //
    // The exact-period match is excluded here on purpose: that row is the legitimate target of
    // this run (a DRAFT is regenerated in place, a finalized one raises a supplementary invoice
    // narrowed inside its span, both handled below). VOID invoices no longer occupy their period.
    if (!existingRes.rows.length) {
      const overlapRes = await db.query(
        `SELECT id, invoice_number, status, period_from::text AS period_from, period_to::text AS period_to
         FROM invoice_header
         WHERE company_id = $1
           AND client_id = $2
           AND status <> 'VOID'
           AND period_from <= $4::date
           AND period_to >= $3::date
           AND NOT (period_from = $3::date AND period_to = $4::date)
         ORDER BY period_from, id
         LIMIT 1`,
        [args.companyId, clientId, args.periodFrom, args.periodTo]
      )
      if (overlapRes.rows.length) {
        const clash = overlapRes.rows[0]
        conflicts.push({
          clientId,
          invoiceId: Number(clash.id),
          invoiceNumber: String(clash.invoice_number),
          status: String(clash.status),
          periodFrom: String(clash.period_from).slice(0, 10),
          periodTo: String(clash.period_to).slice(0, 10),
        })
        continue
      }
    }

    // Period the invoice HEADER is stored under. Normally the requested window; for a
    // supplementary invoice (see below) it is narrowed to the stranded charges' own span so it
    // does not collide with the finalized invoice on uq_invoice_header_company_client_period.
    let headerPeriodFrom = args.periodFrom
    let headerPeriodTo = args.periodTo
    // A supplementary invoice tops up charges stranded behind an already-finalized period invoice.
    // Minimum-billing must NOT re-apply on it (the primary invoice for the period already carried
    // the minimum), otherwise the minimum would be double-charged.
    let isSupplementary = false
    let invoiceId: number
    if (existingRes.rows.length && existingRes.rows[0].status === "DRAFT") {
      const existing = existingRes.rows[0]
      invoiceId = Number(existing.id)
      // Release any transactions billed to this DRAFT invoice in a PRIOR run back to the
      // unbilled pool before we wipe its lines. Regeneration deletes every line but only
      // re-adds currently-UNBILLED txns; without this reset, txns billed by an earlier run
      // stay BILLED with invoice_id set yet get no line, silently orphaning them (invoice
      // total understated, charge never re-billable). Resetting them lets the UNBILLED
      // re-select below rebuild ALL of the invoice's lines.
      await db.query(
        `UPDATE billing_transactions
         SET status = 'UNBILLED',
             invoice_id = NULL,
             billed_at = NULL,
             billed_by = NULL,
             updated_by = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $1
           AND invoice_id = $2
           AND status = 'BILLED'`,
        [args.companyId, invoiceId, args.userId ?? null]
      )
      await db.query(`DELETE FROM invoice_tax_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, invoiceId])
      await db.query(`DELETE FROM invoice_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, invoiceId])
    } else {
      // A non-DRAFT invoice (FINALIZED/SENT/PAID) already occupies this exact period. Charges
      // staged AFTER that invoice was finalized (event_date inside the closed period) are UNBILLED
      // but can never join the locked invoice. Rather than skip the client and strand them forever,
      // raise a SUPPLEMENTARY draft invoice (Option A) for exactly those leftover charges. Its
      // header period is narrowed to the charges' own date span so it does not violate the
      // uq_invoice_header_company_client_period unique constraint held by the finalized invoice.
      if (existingRes.rows.length) {
        isSupplementary = true
        const spanRes = await db.query(
          `SELECT MIN(event_date)::text AS min_date, MAX(event_date)::text AS max_date
           FROM billing_transactions
           WHERE company_id = $1
             AND client_id = $2
             AND status = 'UNBILLED'
             AND event_date BETWEEN $3::date AND $4::date`,
          [args.companyId, clientId, args.periodFrom, args.periodTo]
        )
        const minDate = spanRes.rows[0]?.min_date as string | null
        const maxDate = spanRes.rows[0]?.max_date as string | null
        if (!minDate || !maxDate) {
          // Nothing stranded (finalized invoice already captured everything). Skip.
          continue
        }
        headerPeriodFrom = String(minDate).slice(0, 10)
        headerPeriodTo = String(maxDate).slice(0, 10)
        // Guarantee the (company, client, period_from, period_to) tuple is free. If the stranded
        // span happens to equal an existing invoice's period, walk period_from back one day at a
        // time until the tuple is unique (period_to stays >= period_from, so ck_ih_period holds).
        for (;;) {
          const clash = await db.query(
            `SELECT 1
             FROM invoice_header
             WHERE company_id = $1
               AND client_id = $2
               AND period_from = $3::date
               AND period_to = $4::date
               AND status <> 'VOID'
             LIMIT 1`,
            [args.companyId, clientId, headerPeriodFrom, headerPeriodTo]
          )
          if (!clash.rows.length) break
          const back = new Date(`${headerPeriodFrom}T00:00:00.000Z`)
          back.setUTCDate(back.getUTCDate() - 1)
          headerPeriodFrom = back.toISOString().slice(0, 10)
        }
      }

      const invoiceDate = headerPeriodTo
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
          headerPeriodFrom,
          headerPeriodTo,
          monthLabel(headerPeriodFrom),
          invoiceDate,
          due.toISOString().slice(0, 10),
          currency,
          args.runKey,
          args.userId ?? null,
        ]
      )
      invoiceId = Number(created.rows[0].id)
    }

    // Set-based generation: copy every UNBILLED charge for this client/period into invoice_lines in
    // a single round-trip, then derive the tax lines from the inserted rows. Amounts are copied
    // verbatim from billing_transactions (no re-pricing here), so this is a pure throughput change —
    // the posted values are identical to the prior per-row loop. line_no follows (event_date, id).
    await db.query(
      `INSERT INTO invoice_lines (
         company_id, invoice_id, line_no, charge_type, description, source_type, source_doc_id,
         source_line_id, source_ref_no, period_from, period_to, uom, quantity, rate, amount,
         tax_code, gst_rate, cgst_amount, sgst_amount, igst_amount, total_tax_amount, gross_amount
       )
       SELECT
         bt.company_id,
         $2,
         ROW_NUMBER() OVER (ORDER BY bt.event_date, bt.id),
         bt.charge_type,
         bt.charge_type || ' (' || bt.source_type || ':' ||
           COALESCE(NULLIF(bt.source_ref_no, ''), bt.source_doc_id::text, bt.id::text) || ')',
         bt.source_type, bt.source_doc_id, bt.source_line_id, bt.source_ref_no,
         bt.period_from, bt.period_to, bt.uom, bt.quantity, bt.rate, bt.amount,
         bt.tax_code, bt.gst_rate, bt.cgst_amount, bt.sgst_amount, bt.igst_amount,
         bt.total_tax_amount, bt.gross_amount
       FROM billing_transactions bt
       WHERE bt.company_id = $1
         AND bt.client_id = $3
         AND bt.status = 'UNBILLED'
         AND bt.event_date BETWEEN $4::date AND $5::date`,
      [args.companyId, invoiceId, clientId, args.periodFrom, args.periodTo]
    )

    await db.query(
      `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
       SELECT il.company_id, il.invoice_id, il.id, 'CGST', il.gst_rate / 2, il.amount, il.cgst_amount
         FROM invoice_lines il
        WHERE il.company_id = $1 AND il.invoice_id = $2 AND il.cgst_amount > 0
       UNION ALL
       SELECT il.company_id, il.invoice_id, il.id, 'SGST', il.gst_rate / 2, il.amount, il.sgst_amount
         FROM invoice_lines il
        WHERE il.company_id = $1 AND il.invoice_id = $2 AND il.sgst_amount > 0
       UNION ALL
       SELECT il.company_id, il.invoice_id, il.id, 'IGST', il.gst_rate, il.amount, il.igst_amount
         FROM invoice_lines il
        WHERE il.company_id = $1 AND il.invoice_id = $2 AND il.igst_amount > 0`,
      [args.companyId, invoiceId]
    )

    // Header-level aggregates the minimum-billing top-up needs: current taxable total, the next free
    // line number, and whether any line is inter-state (drives CGST/SGST vs IGST on the top-up).
    const lineAgg = await db.query(
      `SELECT
         COALESCE(SUM(amount), 0)::numeric AS taxable,
         COALESCE(MAX(line_no), 0)::int AS max_line_no,
         COALESCE(BOOL_OR(igst_amount > 0), false) AS saw_inter
       FROM invoice_lines
       WHERE company_id = $1 AND invoice_id = $2`,
      [args.companyId, invoiceId]
    )
    const taxableSoFar = toNum(lineAgg.rows[0]?.taxable, 0)
    const sawInterState = lineAgg.rows[0]?.saw_inter === true
    let lineNo = toNum(lineAgg.rows[0]?.max_line_no, 0) + 1

    // Minimum billing: if the client's profile enforces a minimum and the period's taxable value
    // falls short, add a MINIMUM top-up line for the shortfall so the invoice meets the floor.
    // Only on the period's primary invoice (never a supplementary top-up) to avoid double-charging.
    const minimumEnabled = profile?.minimum_billing_enabled === true
    const minimumAmount = toNum(profile?.minimum_billing_amount, 0)
    if (minimumEnabled && !isSupplementary && minimumAmount > 0 && taxableSoFar < minimumAmount) {
      const shortfall = round2(minimumAmount - taxableSoFar)
      if (shortfall > 0) {
        const gstRate = DEFAULT_GST_RATE
        const minTax = computeTax(shortfall, gstRate, sawInterState ? "INTER_STATE" : "INTRA_STATE")
        const minLineRes = await db.query(
          `INSERT INTO invoice_lines (
             company_id, invoice_id, line_no, charge_type, description, source_type, source_doc_id, source_line_id, source_ref_no,
             period_from, period_to, uom, quantity, rate, amount, tax_code, gst_rate, cgst_amount, sgst_amount, igst_amount,
             total_tax_amount, gross_amount
           ) VALUES (
             $1,$2,$3,'MINIMUM',$4,'MANUAL',NULL,NULL,NULL,$5::date,$6::date,'UNIT',1,$7,$7,'GST',$8,$9,$10,$11,$12,$13
           )
           RETURNING id`,
          [
            args.companyId,
            invoiceId,
            lineNo,
            `MINIMUM billing top-up (floor ${minimumAmount.toFixed(2)})`,
            headerPeriodFrom,
            headerPeriodTo,
            shortfall,
            gstRate,
            minTax.cgstAmount,
            minTax.sgstAmount,
            minTax.igstAmount,
            minTax.totalTaxAmount,
            minTax.grossAmount,
          ]
        )
        const minLineId = Number(minLineRes.rows[0].id)
        if (minTax.cgstAmount > 0) {
          await db.query(
            `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
             VALUES ($1,$2,$3,'CGST',$4,$5,$6)`,
            [args.companyId, invoiceId, minLineId, gstRate / 2, shortfall, minTax.cgstAmount]
          )
        }
        if (minTax.sgstAmount > 0) {
          await db.query(
            `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
             VALUES ($1,$2,$3,'SGST',$4,$5,$6)`,
            [args.companyId, invoiceId, minLineId, gstRate / 2, shortfall, minTax.sgstAmount]
          )
        }
        if (minTax.igstAmount > 0) {
          await db.query(
            `INSERT INTO invoice_tax_lines (company_id, invoice_id, invoice_line_id, tax_type, tax_rate, taxable_amount, tax_amount)
             VALUES ($1,$2,$3,'IGST',$4,$5,$6)`,
            [args.companyId, invoiceId, minLineId, gstRate, shortfall, minTax.igstAmount]
          )
        }
        lineNo += 1
      }
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

  return { generatedCount, conflicts }
}

/**
 * Split the client population into `count` disjoint slices.
 *
 * The whole run is one pass over every client of every tenant, inside one HTTP
 * request. That is fine at four tenants and is the wrong shape at four hundred:
 * one slow client stalls everybody behind it, and a timeout loses the whole
 * pass rather than a slice of it.
 *
 * Sharding on `client_id % count` rather than on a cursor keeps the slices
 * stable across runs, so a shard that fails can be retried on its own without
 * re-deriving where it was. Slices are disjoint and exhaustive by construction —
 * every client_id has exactly one remainder — which is the property the test
 * asserts rather than trusting the arithmetic.
 */
export type BillingShard = { index: number; count: number }

export function normalizeShard(value: unknown): BillingShard | null {
  if (!value || typeof value !== "object") return null
  const raw = value as { index?: unknown; count?: unknown }
  const count = Math.trunc(Number(raw.count))
  const index = Math.trunc(Number(raw.index))
  if (!Number.isFinite(count) || count < 1) return null
  if (!Number.isFinite(index) || index < 0 || index >= count) {
    throw new Error(`shard index must be between 0 and ${count - 1}`)
  }
  return count === 1 ? null : { index, count }
}

export async function generateInvoiceDraftsByBillingCycle(
  db: DBClient,
  args: {
    companyId: number
    userId?: number
    runDate: string
    runKeyPrefix: string
    clientId?: number | null
    shard?: BillingShard | null
  }
) {
  const params: unknown[] = [args.companyId]
  let clientFilter = ""
  if (args.clientId) {
    params.push(args.clientId)
    clientFilter = `AND cbp.client_id = $${params.length}`
  } else if (args.shard) {
    params.push(args.shard.count, args.shard.index)
    clientFilter = `AND (cbp.client_id % $${params.length - 1}) = $${params.length}`
  }

  const profileRes = await db.query(
    `SELECT
       cbp.client_id,
       cbp.billing_cycle,
       cbp.billing_day_of_week,
       cbp.billing_day_of_month,
       cc.effective_from::text AS contract_effective_from,
       ub.since::text AS unbilled_since
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
     LEFT JOIN LATERAL (
       -- Earliest still-unbilled charge. This bounds how far back catch-up reaches:
       -- a client with nothing outstanding yields no periods, so the enumeration can
       -- never run away over empty history.
       SELECT MIN(bt.event_date) AS since
       FROM billing_transactions bt
       WHERE bt.company_id = cbp.company_id
         AND bt.client_id = cbp.client_id
         AND bt.status = 'UNBILLED'
     ) ub ON true
     WHERE cbp.company_id = $1
       AND cbp.is_active = true
       ${clientFilter}
     ORDER BY cbp.client_id`,
    params
  )

  let generatedCount = 0
  let dueClientCount = 0
  const skipped: Array<{ clientId: number; reason: string }> = []
  const truncatedClients: Array<{ clientId: number; billedThrough: string }> = []
  const windows: Array<{ clientId: number; cycle: string; periodFrom: string; periodTo: string; runKey: string; generated: number }> = []
  const conflicts: Awaited<ReturnType<typeof generateInvoiceDrafts>>["conflicts"] = []

  for (const row of profileRes.rows) {
    const clientId = toNum(row.client_id)
    const cycle = String(row.billing_cycle || "MONTHLY") as BillingCycle

    const due = billingDuePeriods(cycle, args.runDate, {
      billingDayOfWeek: toNum(row.billing_day_of_week, 0) || null,
      billingDayOfMonth: toNum(row.billing_day_of_month, 0) || null,
      contractEffectiveFrom: (row.contract_effective_from as string | null) || null,
      since: (row.unbilled_since as string | null) || null,
    })

    if (!due.periods.length) {
      skipped.push({ clientId, reason: due.reason || "Not due" })
      continue
    }
    if (due.truncated) {
      // Never let a bounded run read as full coverage: the caller records this in
      // billing_job_runs.details so a remaining backlog is visible rather than implied.
      truncatedClients.push({ clientId, billedThrough: due.periods[due.periods.length - 1].periodTo })
    }

    dueClientCount += 1
    for (const period of due.periods) {
      const runKey = `${args.runKeyPrefix}-${clientId}-${period.periodFrom}-${period.periodTo}`
      const summary = await generateInvoiceDrafts(db, {
        companyId: args.companyId,
        userId: args.userId,
        periodFrom: period.periodFrom,
        periodTo: period.periodTo,
        clientId,
        runKey,
      })
      generatedCount += toNum(summary.generatedCount, 0)
      conflicts.push(...summary.conflicts)
      windows.push({
        clientId,
        cycle,
        periodFrom: period.periodFrom,
        periodTo: period.periodTo,
        runKey,
        generated: toNum(summary.generatedCount, 0),
      })
    }
  }

  return {
    generatedCount,
    dueClientCount,
    profileCount: profileRes.rows.length,
    skippedCount: skipped.length,
    skipped,
    conflicts,
    conflictCount: conflicts.length,
    windows,
    truncatedClients,
    shard: args.shard ?? null,
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
  // Never persist OVERDUE: it is a DERIVED display state that the invoices read route computes
  // from due_date + balance. Storing it would violate ck_ih_status, which only permits
  // DRAFT/FINALIZED/SENT/PAID/VOID — so finalizing (or paying) any past-due invoice used to throw
  // a check-constraint violation.
  const status = balance <= 0 ? "PAID" : "FINALIZED"

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

/**
 * Voids an invoice and RELEASES every transaction billed to it back to the unbilled pool.
 *
 * This is the missing half of the reversal workflow: GRN cancel / DO reverse refuse to touch a
 * source document whose charge is already BILLED and tell the user to reverse the invoice first,
 * but nothing previously flipped a BILLED transaction back to UNBILLED. After voiding, those
 * charges are UNBILLED again, so the GRN/DO becomes reversible and the charges can be re-invoiced
 * (the next generation run raises a fresh collision-safe invoice for them).
 *
 * Payments block the void: an invoice with money against it must have its payments removed/refunded
 * first. The caller owns the transaction (BEGIN + setTenantContext) and should re-sync the finance
 * ledger afterwards (syncFinanceLedger excludes VOID invoices and prunes their journal entries).
 */
export async function voidInvoice(
  db: DBClient,
  args: { companyId: number; invoiceId: number; userId?: number }
) {
  const invoiceRes = await db.query(
    `SELECT id, status, paid_amount
     FROM invoice_header
     WHERE company_id = $1
       AND id = $2
     FOR UPDATE`,
    [args.companyId, args.invoiceId]
  )
  if (!invoiceRes.rows.length) {
    throw new Error("Invoice not found")
  }
  const row = invoiceRes.rows[0]
  const currentStatus = String(row.status ?? "")
  if (currentStatus === "VOID") {
    return { status: "VOID" as const, releasedTxnCount: 0 }
  }
  if (toNum(row.paid_amount) > 0) {
    throw new Error(
      "Cannot void an invoice that has payments recorded. Remove or refund the payments first."
    )
  }

  const releasedRes = await db.query(
    `UPDATE billing_transactions
     SET status = 'UNBILLED',
         invoice_id = NULL,
         billed_at = NULL,
         billed_by = NULL,
         updated_by = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE company_id = $1
       AND invoice_id = $2
       AND status = 'BILLED'
     RETURNING id`,
    [args.companyId, args.invoiceId, args.userId ?? null]
  )
  const releasedTxnCount = releasedRes.rowCount ?? 0

  // Drop the lines and zero the money so the void invoice stops contributing to receivables.
  // The header (number + period) is retained as a VOID shell for audit; the released charges will
  // be re-invoiced onto a new document on the next generation run.
  await db.query(`DELETE FROM invoice_tax_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, args.invoiceId])
  await db.query(`DELETE FROM invoice_lines WHERE company_id = $1 AND invoice_id = $2`, [args.companyId, args.invoiceId])

  await db.query(
    `UPDATE invoice_header
     SET status = 'VOID',
         taxable_amount = 0,
         cgst_amount = 0,
         sgst_amount = 0,
         igst_amount = 0,
         total_tax_amount = 0,
         grand_total = 0,
         balance_amount = 0,
         updated_by = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE company_id = $1
       AND id = $2`,
    [args.companyId, args.invoiceId, args.userId ?? null]
  )
  return { status: "VOID" as const, releasedTxnCount }
}
