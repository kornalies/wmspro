/**
 * Billing period arithmetic — which closed period a cycle run should invoice.
 *
 * Kept as a dependency-free module on purpose. This is the function that decides
 * what gets billed, and its failure mode is silent: a window that is short by a
 * few days does not error, it just leaves those charges UNBILLED forever, because
 * the next run's window starts after them. Isolating it from the DB layer means
 * the arithmetic can be asserted directly (see tests/billing-cycle.mjs) instead of
 * only through a full invoice run.
 *
 * IMPORTANT: do not add imports to this module. `lib/billing-service.ts` pulls in
 * `@/lib/money`, and the `@/` alias cannot be resolved when Node loads a .ts file
 * directly — which is exactly how the test suite loads this file.
 */

export type BillingCycle = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"

export type BillingPeriod = {
  periodFrom: string
  periodTo: string
}

export type BillingDuePeriods = {
  periods: BillingPeriod[]
  /** True when the catch-up backlog hit MAX_CATCHUP_PERIODS and older periods remain unbilled. */
  truncated: boolean
  reason: string | null
}

/**
 * Upper bound on how many closed periods one run will bill for a single client.
 * Prevents a client with very old unbilled charges (or a bad event_date) from
 * turning one run into hundreds of invoice generations. When this bites, the run
 * reports `truncated` rather than silently covering less than it appears to.
 */
export const MAX_CATCHUP_PERIODS = 36

// Local copy rather than a shared import: this module must stay import-free (see above).
function toNum(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function parseIsoDateUtc(value: string) {
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function toIsoDateUtc(date: Date) {
  return date.toISOString().slice(0, 10)
}

// Date.UTC normalises out-of-range months, so month0 = -1 correctly yields December
// of the previous year. The monthly branch relies on that for the January rollover.
export function endOfMonthUtc(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0))
}

export function startOfQuarterUtc(year: number, quarterIndex: number) {
  return new Date(Date.UTC(year, quarterIndex * 3, 1))
}

export function endOfQuarterUtc(year: number, quarterIndex: number) {
  return new Date(Date.UTC(year, quarterIndex * 3 + 3, 0))
}

export function isoDayOfWeek(date: Date) {
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * The complete cycle period that `date` falls inside, or that ends on the first
 * cycle boundary at/after `date`.
 *
 * `periodAfter` is expressed in terms of this: the period following P is simply
 * the period containing the day after P ends. That identity holds for every
 * cycle, which is why the enumerator below needs no per-cycle stepping logic.
 */
function periodContaining(
  cycle: BillingCycle,
  date: Date,
  billingDayOfWeek?: number | null,
  contractDate?: Date | null
): BillingPeriod {
  if (cycle === "WEEKLY") {
    const dueDow = Math.max(Math.min(toNum(billingDayOfWeek, 7), 7), 1)
    const end = new Date(date)
    while (isoDayOfWeek(end) !== dueDow) {
      end.setUTCDate(end.getUTCDate() + 1)
    }
    const from = new Date(end)
    from.setUTCDate(from.getUTCDate() - 6)
    return { periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(end) }
  }

  if (cycle === "MONTHLY") {
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth()
    return { periodFrom: toIsoDateUtc(new Date(Date.UTC(y, m, 1))), periodTo: toIsoDateUtc(endOfMonthUtc(y, m)) }
  }

  if (cycle === "QUARTERLY") {
    const y = date.getUTCFullYear()
    const q = Math.floor(date.getUTCMonth() / 3)
    return { periodFrom: toIsoDateUtc(startOfQuarterUtc(y, q)), periodTo: toIsoDateUtc(endOfQuarterUtc(y, q)) }
  }

  // YEARLY: periods run anniversary-to-anniversary off the contract date.
  const anchor = contractDate as Date
  const annivMonth = anchor.getUTCMonth()
  const annivDay = anchor.getUTCDate()
  const annivIn = (year: number) =>
    new Date(Date.UTC(year, annivMonth, Math.min(annivDay, endOfMonthUtc(year, annivMonth).getUTCDate())))
  const runYear = date.getUTCFullYear()
  let end = annivIn(runYear)
  if (date.getTime() > end.getTime()) end = annivIn(runYear + 1)
  const prevAnniv = annivIn(end.getUTCFullYear() - 1)
  const from = new Date(prevAnniv)
  from.setUTCDate(from.getUTCDate() + 1)
  return { periodFrom: toIsoDateUtc(from), periodTo: toIsoDateUtc(end) }
}

/**
 * The earliest date on which a closed period may be invoiced.
 *
 * For MONTHLY this is `billing_day_of_month` of the month AFTER the period ends,
 * which is what that setting means once billing runs in arrears: a grace window
 * before the closed month is invoiced, so late-arriving charges still land on it.
 * Every other cycle is released the day its period closes, matching the previous
 * exact-date behaviour.
 */
function releaseDateOf(cycle: BillingCycle, period: BillingPeriod, billingDayOfMonth?: number | null): string {
  if (cycle !== "MONTHLY") return period.periodTo
  const end = parseIsoDateUtc(period.periodTo)
  if (!end) return period.periodTo
  const y = end.getUTCFullYear()
  const m = end.getUTCMonth()
  const nextMonthEnd = endOfMonthUtc(y, m + 1)
  const day =
    billingDayOfMonth && billingDayOfMonth > 0
      ? Math.min(billingDayOfMonth, nextMonthEnd.getUTCDate())
      : nextMonthEnd.getUTCDate()
  return toIsoDateUtc(new Date(Date.UTC(y, m + 1, day)))
}

/**
 * Every closed period that is due to be invoiced as of `runDateIso`, oldest first.
 *
 * This replaces "is today exactly the billing day?" with "which closed periods are
 * owed?", so a run on any date bills whatever is outstanding. The previous
 * exact-match rule meant a single missed day — an outage, a deploy, a failed unit,
 * or simply nobody clicking the button — dropped that period permanently and
 * silently, because the next run's window began after it. A missed run now
 * self-heals on the next one, and the schedule becomes a latency preference
 * rather than a correctness dependency.
 *
 * `since` bounds the backfill and is expected to be the client's earliest UNBILLED
 * charge date. With no unbilled charges there is nothing to invoice and the result
 * is empty, so the enumeration can never run away over empty history.
 *
 * Double-invoicing is not a risk here: uq_invoice_header_company_client_period
 * makes a period unique per client, and generateInvoiceDrafts only ever picks up
 * charges still marked UNBILLED.
 */
export function billingDuePeriods(
  cycle: BillingCycle,
  runDateIso: string,
  opts: {
    billingDayOfWeek?: number | null
    billingDayOfMonth?: number | null
    contractEffectiveFrom?: string | null
    since?: string | null
  } = {}
): BillingDuePeriods {
  const runDate = parseIsoDateUtc(runDateIso)
  if (!runDate) return { periods: [], truncated: false, reason: "Invalid run date" }

  const contractDate = opts.contractEffectiveFrom ? parseIsoDateUtc(opts.contractEffectiveFrom) : null
  if (cycle === "YEARLY" && !contractDate) {
    return { periods: [], truncated: false, reason: "Contract anniversary unavailable for yearly cycle" }
  }

  const sinceDate = opts.since ? parseIsoDateUtc(opts.since) : null
  if (!sinceDate) return { periods: [], truncated: false, reason: "No unbilled charges" }

  const periods: BillingPeriod[] = []
  let truncated = false
  let period = periodContaining(cycle, sinceDate, opts.billingDayOfWeek, contractDate)

  for (;;) {
    // ISO yyyy-mm-dd strings order lexicographically, so plain comparison is safe.
    if (releaseDateOf(cycle, period, opts.billingDayOfMonth) > runDateIso) break
    periods.push(period)
    if (periods.length >= MAX_CATCHUP_PERIODS) {
      truncated = true
      break
    }
    const dayAfter = parseIsoDateUtc(period.periodTo) as Date
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1)
    period = periodContaining(cycle, dayAfter, opts.billingDayOfWeek, contractDate)
  }

  return {
    periods,
    truncated,
    reason: periods.length ? null : "No closed period is due yet",
  }
}
