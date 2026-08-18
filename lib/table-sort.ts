/**
 * One comparator for every sortable list table.
 *
 * Each screen used to hand-roll its own, and they all failed the same three ways:
 *
 * 1. They gated on `typeof value === "number"` to decide numeric vs text. Postgres
 *    `numeric` columns arrive over the wire as STRINGS (node-postgres does not coerce
 *    them, to preserve precision), so that branch was dead for every money column and
 *    the value fell through to a text compare -- "1200.00" sorting above "999.00".
 *    The TypeScript types said `number`, so the compiler never flagged it.
 *
 * 2. They sniffed the kind per comparison with `Number.isFinite(Number(v))`. But
 *    `Number("")` and `Number(null)` are both 0, i.e. finite -- so in a text column
 *    with gaps, blank-vs-blank compared numerically while blank-vs-value compared as
 *    text. That is an INCONSISTENT comparator, and V8's sort gives arbitrary (not
 *    merely surprising) output for one. The kind is now declared per column, once.
 *
 * 3. They had no tiebreak, so equal keys reshuffled between renders.
 *
 * The rule here is that the caller declares what a column IS, and this module is the
 * only place that decides what that means. Blanks always sort last, in both directions
 * -- a descending sort should surface the largest values, not a wall of empty cells.
 */

export type SortDir = "asc" | "desc"

/** What a column holds. Declared by the caller; never inferred per-comparison. */
export type ValueKind = "text" | "number" | "date" | "boolean"

// One shared collator rather than a localeCompare call per comparison: it is both
// markedly faster over a large table and, with numeric:true, orders "Item 9" before
// "Item 10" the way a human reading a code column expects.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

// Only ISO-ish shapes are treated as dates by inferValueKind. Date.parse is far more
// permissive than that ("15" parses in some engines), and guessing wrong turns a code
// column into nonsense.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/

const TRUTHY = new Set(["true", "t", "yes", "y", "1"])
const FALSY = new Set(["false", "f", "no", "n", "0"])

/**
 * Reduce a raw cell to a number, a string, or null for "blank".
 *
 * Blank means absent, not zero: null, undefined, an empty/whitespace string, and any
 * value that cannot be read as the declared kind (NaN, an unparseable date). A real 0
 * or `false` is NOT blank and must keep sorting as a value.
 */
function normalize(value: unknown, kind: ValueKind): number | string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.trim() === "") return null

  switch (kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim())
      return Number.isFinite(n) ? n : null
    }
    case "date": {
      const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
      return Number.isFinite(ms) ? ms : null
    }
    case "boolean": {
      if (typeof value === "boolean") return value ? 1 : 0
      const text = String(value).trim().toLowerCase()
      if (TRUTHY.has(text)) return 1
      if (FALSY.has(text)) return 0
      return null
    }
    default: {
      const text = String(value).trim()
      return text === "" ? null : text
    }
  }
}

/** Compare two already-normalized, non-null values. */
function compareNormalized(left: number | string, right: number | string): number {
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return collator.compare(String(left), String(right))
}

/** True when a cell reads as empty for the declared kind. Exported for header hints. */
export function isBlankValue(value: unknown, kind: ValueKind = "text"): boolean {
  return normalize(value, kind) === null
}

/**
 * Ascending comparison of two raw cells, blanks last.
 *
 * Direction is NOT applied here -- see makeComparator for why blanks must not flip.
 */
export function compareValues(a: unknown, b: unknown, kind: ValueKind): number {
  const left = normalize(a, kind)
  const right = normalize(b, kind)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return compareNormalized(left, right)
}

/**
 * Direction-independent tiebreak, so rows with equal sort keys hold a fixed order
 * instead of reshuffling on every render. Numeric ids compare numerically.
 */
function compareTiebreak(a: unknown, b: unknown): number {
  const left = normalize(a, "number")
  const right = normalize(b, "number")
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return compareValues(a, b, "text")
}

/**
 * Build an Array#sort comparator for one column.
 *
 * `tiebreak` should be a stable unique key (normally the row id). Pass it: without one
 * the sort is not deterministic across renders for rows sharing a key.
 */
export function makeComparator<T>(
  accessor: (row: T) => unknown,
  kind: ValueKind,
  dir: SortDir,
  tiebreak?: (row: T) => unknown
): (a: T, b: T) => number {
  const sign = dir === "asc" ? 1 : -1
  return (a, b) => {
    const left = normalize(accessor(a), kind)
    const right = normalize(accessor(b), kind)

    if (left === null || right === null) {
      // Blanks sink to the bottom in BOTH directions, so they are never multiplied by
      // sign. Two blanks are equal and fall through to the tiebreak.
      if (right === null && left !== null) return -1
      if (left === null && right !== null) return 1
    } else {
      const result = compareNormalized(left, right) * sign
      if (result !== 0) return result
    }

    return tiebreak ? compareTiebreak(tiebreak(a), tiebreak(b)) : 0
  }
}

/**
 * Sort a list by one declared column. Returns a new array; the input is untouched.
 */
export function sortRows<T>(
  rows: readonly T[],
  accessor: (row: T) => unknown,
  kind: ValueKind,
  dir: SortDir,
  tiebreak?: (row: T) => unknown
): T[] {
  return [...rows].sort(makeComparator(accessor, kind, dir, tiebreak))
}

/**
 * Guess a column's kind from its data.
 *
 * Only for genuinely dynamic tables (the reports screen renders five different result
 * shapes). Call it ONCE per column and reuse the answer -- inferring per comparison is
 * how bug (2) above happened. A column is numeric/date/boolean only if EVERY non-blank
 * sample agrees; anything mixed is text.
 */
export function inferValueKind(values: readonly unknown[], sampleSize = 50): ValueKind {
  let seen = 0
  let allNumber = true
  let allDate = true
  let allBoolean = true

  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === "string" && value.trim() === "") continue

    seen++
    if (typeof value !== "boolean") allBoolean = false
    if (normalize(value, "number") === null) allNumber = false
    // Guard with ISO_DATE first: Date.parse alone would claim plain integers.
    if (!(value instanceof Date) && !ISO_DATE.test(String(value).trim())) allDate = false
    if (!allNumber && !allDate && !allBoolean) return "text"
    if (seen >= sampleSize) break
  }

  if (seen === 0) return "text"
  if (allBoolean) return "boolean"
  // Date before number: an ISO string is never a finite number, so these cannot both
  // hold, but the ordering makes the intent explicit.
  if (allDate) return "date"
  if (allNumber) return "number"
  return "text"
}

/**
 * The direction a column should open in on first click.
 *
 * Text reads naturally A->Z, while for a quantity, an amount or a date the interesting
 * end is the top: newest, largest, most overdue.
 */
export function defaultDirFor(kind: ValueKind): SortDir {
  return kind === "text" ? "asc" : "desc"
}

/**
 * Fold a click on a column header into the next sort state: same column flips
 * direction, a new column adopts that column's natural default.
 */
export function nextSortState<K extends string>(
  current: { key: K; dir: SortDir },
  key: K,
  kind: ValueKind
): { key: K; dir: SortDir } {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" }
  }
  return { key, dir: defaultDirFor(kind) }
}
