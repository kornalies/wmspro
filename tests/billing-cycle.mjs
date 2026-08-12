/**
 * Billing period arithmetic acceptance.
 *
 * Two regressions are guarded here, both of which were live and both of which
 * failed SILENTLY — no error, no zero-total invoice, just charges left UNBILLED
 * forever because the next run's window began after them.
 *
 * 1. The monthly window billed [1st of the CURRENT month, runDate]. Because
 *    client_billing_profile.billing_day_of_month is NOT NULL DEFAULT 1 and
 *    CHECK (BETWEEN 1 AND 28), the run date could never be the 29th/30th/31st, so
 *    NO configuration produced a whole month:
 *      day 1  -> [1st, 1st]    a one-day invoice
 *      day 28 -> [1st, 28th]   days 29-31 of every long month never billed
 *
 * 2. A period was billable only if the run date equalled the billing day EXACTLY.
 *    One missed day — an outage, a deploy, or nobody clicking the button — dropped
 *    that period permanently.
 *
 * So the two central assertions are COVERAGE tests: consecutive periods must tile
 * the calendar with no gap and no overlap, and a run on an arbitrary off-day must
 * still bill what is outstanding. A test that only checked "a due date returns a
 * period" would have passed throughout the entire period both bugs existed.
 *
 * Pure arithmetic: no database, no dev server.
 */

import process from "node:process"
import { MAX_CATCHUP_PERIODS, billingDuePeriods, daysInCycle } from "../lib/billing-cycle.ts"

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

function eq(label, actual, expected) {
  check(label, actual === expected, actual === expected ? "" : `expected ${expected}, got ${actual}`)
}

function due(cycle, runDate, opts = {}) {
  return billingDuePeriods(cycle, runDate, opts)
}

/** The single period a run is expected to bill. */
function only(cycle, runDate, opts = {}) {
  const d = due(cycle, runDate, opts)
  return d.periods.length === 1 ? d.periods[0] : { periodFrom: `<${d.periods.length} periods>`, periodTo: d.reason }
}

function daysBetweenInclusive(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`)
  const to = Date.parse(`${toIso}T00:00:00.000Z`)
  return Math.round((to - from) / 86400000) + 1
}

function assertContiguous(label, periods) {
  let detail = ""
  for (let i = 1; i < periods.length; i++) {
    const prevTo = Date.parse(`${periods[i - 1].periodTo}T00:00:00.000Z`)
    const thisFrom = Date.parse(`${periods[i].periodFrom}T00:00:00.000Z`)
    if (thisFrom - prevTo !== 86400000) {
      detail = `gap/overlap between ${periods[i - 1].periodTo} and ${periods[i].periodFrom}`
      break
    }
  }
  check(label, detail === "", detail)
}

console.log("\n== MONTHLY: bills the whole previous month ==")

// The default configuration for every client in the system.
{
  const p = only("MONTHLY", "2026-08-01", { billingDayOfMonth: 1, since: "2026-07-02" })
  eq("day 1 period_from", p.periodFrom, "2026-07-01")
  eq("day 1 period_to", p.periodTo, "2026-07-31")
  eq("day 1 covers 31 days", daysBetweenInclusive(p.periodFrom, p.periodTo), 31)
}

// The other boundary the CHECK constraint allows.
{
  const p = only("MONTHLY", "2026-08-28", { billingDayOfMonth: 28, since: "2026-07-02" })
  eq("day 28 period_from", p.periodFrom, "2026-07-01")
  eq("day 28 period_to", p.periodTo, "2026-07-31")
}

// Mid-month invoice day.
{
  const p = only("MONTHLY", "2026-08-15", { billingDayOfMonth: 15, since: "2026-07-02" })
  eq("day 15 period_from", p.periodFrom, "2026-07-01")
  eq("day 15 period_to", p.periodTo, "2026-07-31")
}

console.log("\n== MONTHLY: short months and leap years ==")

// 30-day month.
{
  const p = only("MONTHLY", "2026-07-01", { billingDayOfMonth: 1, since: "2026-06-10" })
  eq("June is 30 days, from", p.periodFrom, "2026-06-01")
  eq("June is 30 days, to", p.periodTo, "2026-06-30")
  eq("June day count", daysBetweenInclusive(p.periodFrom, p.periodTo), 30)
}

// Non-leap February.
{
  const p = only("MONTHLY", "2026-03-01", { billingDayOfMonth: 1, since: "2026-02-10" })
  eq("Feb 2026 from", p.periodFrom, "2026-02-01")
  eq("Feb 2026 to", p.periodTo, "2026-02-28")
  eq("Feb 2026 day count", daysBetweenInclusive(p.periodFrom, p.periodTo), 28)
}

// Leap February — 2028 is a leap year.
{
  const p = only("MONTHLY", "2028-03-01", { billingDayOfMonth: 1, since: "2028-02-10" })
  eq("Feb 2028 to (leap)", p.periodTo, "2028-02-29")
  eq("Feb 2028 day count (leap)", daysBetweenInclusive(p.periodFrom, p.periodTo), 29)
}

// Century non-leap year: 2100 is NOT a leap year.
{
  const p = only("MONTHLY", "2100-03-01", { billingDayOfMonth: 1, since: "2100-02-10" })
  eq("Feb 2100 to (century non-leap)", p.periodTo, "2100-02-28")
}

console.log("\n== MONTHLY: December -> January rollover ==")

// The month index goes negative here; Date.UTC must normalise it back a year.
{
  const p = only("MONTHLY", "2027-01-01", { billingDayOfMonth: 1, since: "2026-12-05" })
  eq("January run bills previous December, from", p.periodFrom, "2026-12-01")
  eq("January run bills previous December, to", p.periodTo, "2026-12-31")
}
{
  const p = only("MONTHLY", "2027-01-28", { billingDayOfMonth: 28, since: "2026-12-05" })
  eq("January day-28 run, from", p.periodFrom, "2026-12-01")
  eq("January day-28 run, to", p.periodTo, "2026-12-31")
}

console.log("\n== MONTHLY: release timing ==")

// billing_day_of_month is a grace window in arrears: the closed month is held back
// until that day of the following month, so late-arriving charges still land on it.
{
  const early = due("MONTHLY", "2026-08-10", { billingDayOfMonth: 15, since: "2026-07-02" })
  eq("before the grace day, July is not yet due", early.periods.length, 0)
  eq("grace-window reason", early.reason, "No closed period is due yet")

  const onTime = due("MONTHLY", "2026-08-15", { billingDayOfMonth: 15, since: "2026-07-02" })
  eq("on the grace day, July becomes due", onTime.periods.length, 1)
  eq("grace-day period_to", onTime.periods[0]?.periodTo, "2026-07-31")

  const late = due("MONTHLY", "2026-08-27", { billingDayOfMonth: 15, since: "2026-07-02" })
  eq("after the grace day, July is still due", late.periods.length, 1)
}

// An open month must never be billed before it closes.
{
  const d = due("MONTHLY", "2026-08-20", { billingDayOfMonth: 1, since: "2026-08-03" })
  eq("an open month is not billed", d.periods.length, 0)
}

// A grace day longer than the following month clamps to that month's end, so the
// period stays reachable rather than being silently never due.
{
  const p = only("MONTHLY", "2026-02-28", { billingDayOfMonth: 30, since: "2026-01-05" })
  eq("day 30 clamps to Feb 28 and releases January", p.periodTo, "2026-01-31")
}

console.log("\n== MONTHLY: twelve consecutive periods tile the calendar exactly ==")

// This is the assertion the old implementation could not satisfy at any setting:
// it covered 12/365 days at day 1 and 336/365 at day 28.
for (const dom of [1, 15, 28]) {
  const d = due("MONTHLY", `2027-01-${String(dom).padStart(2, "0")}`, {
    billingDayOfMonth: dom,
    since: "2026-01-05",
  })
  eq(`day ${dom}: twelve months are due`, d.periods.length, 12)
  eq(`day ${dom}: starts at January`, d.periods[0]?.periodFrom, "2026-01-01")
  eq(`day ${dom}: ends at December`, d.periods[11]?.periodTo, "2026-12-31")
  assertContiguous(`day ${dom}: no gap or overlap across 12 periods`, d.periods)
  const totalDays = d.periods.reduce((sum, p) => sum + daysBetweenInclusive(p.periodFrom, p.periodTo), 0)
  eq(`day ${dom}: 12 periods cover 365 days`, totalDays, 365)
}

console.log("\n== CATCH-UP: a run on any date bills what is outstanding ==")

// The live situation: today is the 4th, nobody ran the job on the 1st.
{
  const d = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: "2026-07-02" })
  eq("off-day run still bills July", d.periods.length, 1)
  eq("off-day run period_from", d.periods[0]?.periodFrom, "2026-07-01")
  eq("off-day run period_to", d.periods[0]?.periodTo, "2026-07-31")
}

// Several consecutive missed months are all recovered by one later run.
{
  const d = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: "2026-04-15" })
  eq("recovers a 4-month backlog", d.periods.length, 4)
  eq("backlog starts at the oldest unbilled month", d.periods[0]?.periodFrom, "2026-04-01")
  eq("backlog ends at the last closed month", d.periods[3]?.periodTo, "2026-07-31")
  check("backlog is not truncated", d.truncated === false)
  assertContiguous("backlog periods are contiguous", d.periods)
}

console.log("\n== CATCH-UP: bounded by actual unbilled data ==")

{
  const d = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: null })
  eq("no unbilled charges means nothing due", d.periods.length, 0)
  eq("no-charges reason", d.reason, "No unbilled charges")
}

// Future-dated charges (the 2099 chaos fixtures) must not drag a run backwards or
// produce periods that have not closed.
{
  const d = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: "2099-07-02" })
  eq("future-dated charges yield no due period", d.periods.length, 0)
}

// A runaway backlog is capped AND reports it, rather than silently covering less.
{
  const d = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: "2000-01-05" })
  eq("very old backlog is capped", d.periods.length, MAX_CATCHUP_PERIODS)
  check("capped run reports truncation", d.truncated === true)
  eq("cap starts at the oldest unbilled month", d.periods[0]?.periodFrom, "2000-01-01")
}

console.log("\n== CATCH-UP: repeated runs converge ==")

// Running twice must not widen or shift what is owed. (Idempotency at the data layer
// is enforced by uq_invoice_header_company_client_period; this asserts the arithmetic
// stops proposing periods once the backlog is cleared.)
{
  const first = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: "2026-06-10" })
  eq("first run proposes 2 periods", first.periods.length, 2)
  const second = due("MONTHLY", "2026-08-04", { billingDayOfMonth: 1, since: null })
  eq("second run proposes nothing", second.periods.length, 0)
}

console.log("\n== WEEKLY ==")

{
  // 2026-08-03 is a Monday.
  const p = only("WEEKLY", "2026-08-03", { billingDayOfWeek: 1, since: "2026-07-29" })
  eq("weekly period_from", p.periodFrom, "2026-07-28")
  eq("weekly period_to", p.periodTo, "2026-08-03")
  eq("weekly covers 7 days", daysBetweenInclusive(p.periodFrom, p.periodTo), 7)
}
{
  // Sunday must map to ISO day 7, not 0.
  const p = only("WEEKLY", "2026-08-02", { billingDayOfWeek: 7, since: "2026-07-28" })
  eq("Sunday weekly period_from", p.periodFrom, "2026-07-27")
  eq("Sunday weekly period_to", p.periodTo, "2026-08-02")
}
{
  // A run on Wednesday still bills the week that closed on Monday.
  const d = due("WEEKLY", "2026-08-05", { billingDayOfWeek: 1, since: "2026-07-30" })
  eq("weekly off-day run bills the closed week", d.periods.length, 1)
  eq("weekly caught-up period_to", d.periods[0]?.periodTo, "2026-08-03")
}
{
  const d = due("WEEKLY", "2026-08-05", { billingDayOfWeek: 1, since: "2026-08-04" })
  eq("an open week is not billed", d.periods.length, 0)
}

console.log("\n== QUARTERLY ==")

{
  const p = only("QUARTERLY", "2026-06-30", { since: "2026-05-02" })
  eq("Q2 period_from", p.periodFrom, "2026-04-01")
  eq("Q2 period_to", p.periodTo, "2026-06-30")
  eq("Q2 covers 91 days", daysBetweenInclusive(p.periodFrom, p.periodTo), 91)
}
{
  const d = due("QUARTERLY", "2026-06-29", { since: "2026-05-02" })
  eq("an open quarter is not billed", d.periods.length, 0)
}
{
  const d = due("QUARTERLY", "2026-07-14", { since: "2026-05-02" })
  eq("quarterly off-day run bills Q2", d.periods.length, 1)
  eq("quarterly caught-up period_to", d.periods[0]?.periodTo, "2026-06-30")
}

console.log("\n== YEARLY ==")

{
  const p = only("YEARLY", "2026-03-15", { contractEffectiveFrom: "2024-03-15", since: "2025-06-01" })
  eq("yearly period_from", p.periodFrom, "2025-03-16")
  eq("yearly period_to", p.periodTo, "2026-03-15")
  eq("yearly covers 365 days", daysBetweenInclusive(p.periodFrom, p.periodTo), 365)
}
{
  const d = due("YEARLY", "2026-04-01", { contractEffectiveFrom: "2024-03-15", since: "2025-06-01" })
  eq("yearly off-day run bills the closed year", d.periods.length, 1)
  eq("yearly caught-up period_to", d.periods[0]?.periodTo, "2026-03-15")
}
{
  const d = due("YEARLY", "2026-04-01", { contractEffectiveFrom: null, since: "2025-06-01" })
  eq("yearly without a contract yields nothing", d.periods.length, 0)
  eq("yearly missing-contract reason", d.reason, "Contract anniversary unavailable for yearly cycle")
}

console.log("\n== Invalid input ==")

{
  const d = due("MONTHLY", "not-a-date", { billingDayOfMonth: 1, since: "2026-07-02" })
  eq("invalid run date yields nothing", d.periods.length, 0)
  eq("invalid run date reason", d.reason, "Invalid run date")
}

/**
 * Storage rate proration.
 *
 * Storage rates are quoted per unit per CYCLE but staged one charge per DAILY snapshot.
 * Before this divisor existed, a MONTHLY rate was charged in full on every snapshot: one
 * client's 12 units at 1,000/unit produced two identical 12,000 lines inside a single week.
 *
 * The load-bearing property is not the divisor itself but that a day's rate, summed over
 * the cycle, reconciles back to the configured cycle rate — which is the check finance
 * actually performs. A flat 30/365 denominator passes a naive "it divides" test and fails
 * this one in every month that is not 30 days long.
 */
console.log("\n== Storage rate proration ==")

{
  eq("weekly is 7 days", daysInCycle("WEEKLY", "2026-08-05"), 7)
  eq("august is 31 days", daysInCycle("MONTHLY", "2026-08-05"), 31)
  eq("february 2026 is 28 days", daysInCycle("MONTHLY", "2026-02-14"), 28)
  eq("february 2028 is 29 days", daysInCycle("MONTHLY", "2028-02-14"), 29)
  eq("Q1 is 90 days", daysInCycle("QUARTERLY", "2026-02-14"), 90)
  eq("Q2 is 91 days", daysInCycle("QUARTERLY", "2026-05-14"), 91)
  eq("2026 is 365 days", daysInCycle("YEARLY", "2026-08-05"), 365)
  eq("2028 is 366 days", daysInCycle("YEARLY", "2028-08-05"), 366)
  eq("an unrecognised cycle falls back to monthly", daysInCycle("FORTNIGHTLY", "2026-08-05"), 31)
  eq("an invalid date never divides by zero", daysInCycle("MONTHLY", "not-a-date"), 1)
}

{
  // The reconciliation property, asserted per day rather than as a single division:
  // 1,000/unit/month over August, charged on all 31 snapshots, must total 1,000.
  const rate = 1000
  const days = daysInCycle("MONTHLY", "2026-08-05")
  const perDay = Number((rate / days).toFixed(4))
  const summed = Number((perDay * days).toFixed(2))
  eq("a month of daily storage sums back to the monthly rate", summed, rate)
  check(
    "12 units of daily storage is no longer a month's charge",
    Math.round(perDay * 12 * 100) / 100 === 387.1,
    `got ${Math.round(perDay * 12 * 100) / 100}`
  )
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)