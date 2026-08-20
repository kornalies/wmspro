/**
 * One set of formatters for the whole portal.
 *
 * The same invoice used to render two ways: the overview showed `₹1,18,000` via
 * Intl `en-IN`, while the billing table showed `INR 118000.00` by concatenating a
 * currency code onto `toFixed(2)`. A client comparing the two screens has no way to
 * know they are looking at the same number.
 *
 * Amounts arrive from postgres `numeric` columns as STRINGS, so every helper here
 * coerces rather than trusting the declared TypeScript type.
 */

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  const parsed = Number(String(value ?? "").trim())
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Money, in the invoice's own currency. `maximumFractionDigits: 0` on the overview
 * tiles is a summary decision; a statement line must show the paise.
 */
export function formatMoney(value: unknown, currencyCode = "INR", withDecimals = true) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currencyCode || "INR",
    minimumFractionDigits: withDecimals ? 2 : 0,
    maximumFractionDigits: withDecimals ? 2 : 0,
  }).format(toNumber(value))
}

/** Whole-rupee form for headline figures where the paise are noise. */
export function formatMoneyCompact(value: unknown, currencyCode = "INR") {
  return formatMoney(value, currencyCode, false)
}

export function formatQuantity(value: unknown) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(toNumber(value))
}

/** Dates render as "20 Aug 2026" — unambiguous, unlike any all-numeric order. */
export function formatDay(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function formatDayTime(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Whole days from today, positive when the date has passed. Used for "overdue by
 * 12 days", which tells a client more than a due date they have to subtract from.
 */
export function daysPast(value: string | null | undefined): number | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((Date.now() - date.getTime()) / 86400000)
}
