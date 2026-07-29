/**
 * Stock allocation ordering, in one place.
 *
 * Before this existed, "allocation rule" was a dropdown whose value was written
 * into a remarks string and then ignored: every path ordered by received_date,
 * so a DO marked FEFO shipped FIFO. Ordering now lives here and every path that
 * chooses stock — the legacy dispatch commit, the FIFO advisory endpoint, and
 * the packable pool the pack screen offers — asks this module, so they cannot
 * disagree about what a rule means.
 *
 * Two rules are genuinely implemented. SERIAL and LOCATION are accepted because
 * the DO form has always offered them, but they are NOT distinct strategies yet
 * and are treated as FIFO. `isRuleImplemented` exposes that honestly so callers
 * can say so instead of implying a behaviour that does not exist.
 */

export type AllocationRule = "FIFO" | "FEFO" | "BATCH" | "SERIAL" | "LOCATION"

export const ALLOCATION_RULES: AllocationRule[] = [
  "FIFO",
  "FEFO",
  "BATCH",
  "SERIAL",
  "LOCATION",
]

export function normalizeAllocationRule(value: unknown): AllocationRule {
  const raw = String(value ?? "").trim().toUpperCase()
  return (ALLOCATION_RULES as string[]).includes(raw) ? (raw as AllocationRule) : "FIFO"
}

/** FIFO, FEFO and BATCH change ordering. The other two currently do not. */
export function isRuleImplemented(rule: AllocationRule): boolean {
  return rule === "FIFO" || rule === "FEFO" || rule === "BATCH"
}

/**
 * The ORDER BY fragment for a rule, written against a stock_serial_numbers
 * alias.
 *
 * FEFO puts the earliest expiry first. Stock with no expiry sorts LAST, not
 * first: a NULL expiry means "not expiry-tracked", and letting NULLs lead would
 * make FEFO silently behave like FIFO for any item whose expiry data has not
 * been captured yet — the exact failure this module exists to prevent.
 *
 * Every rule falls through to received_date then id, so ordering is total and
 * allocation is reproducible rather than dependent on physical row order.
 */
export function allocationOrderBy(rule: AllocationRule, alias = "s"): string {
  const tail = `${alias}.received_date ASC NULLS LAST, ${alias}.id ASC`
  switch (rule) {
    case "FEFO":
      return `${alias}.expiry_date ASC NULLS LAST, ${tail}`
    case "BATCH":
      // Keep a batch together so a picker walks one lot at a time, oldest batch
      // first by the date the batch entered stock.
      return `${alias}.batch_number ASC NULLS LAST, ${tail}`
    default:
      return tail
  }
}

/**
 * Predicate excluding stock that must never be auto-allocated.
 *
 * Two separate rules, and they are not the same thing:
 *
 *   EXPIRED — expiry_date is in the past. Never allocatable, for any item.
 *
 *   BELOW MINIMUM SHELF LIFE — inside items.min_shelf_life_days of expiry. Still
 *     saleable stock, but a customer contracted to a minimum remaining life will
 *     reject it on arrival. Excluding it here is what stops that delivery being
 *     made, and it applies only to items that declare a minimum.
 *
 * Written as SQL rather than filtered in JS because the allocation query uses
 * LIMIT ... FOR UPDATE SKIP LOCKED: filtering after the fact would take the lock
 * on rows it then discards and under-fill the allocation.
 */
export function allocatableStockPredicate(alias = "s", itemAlias = "i"): string {
  return `
    (${alias}.expiry_date IS NULL OR ${alias}.expiry_date >= CURRENT_DATE)
    AND (
      ${itemAlias}.min_shelf_life_days IS NULL
      OR ${alias}.expiry_date IS NULL
      OR ${alias}.expiry_date >= CURRENT_DATE + (${itemAlias}.min_shelf_life_days || ' days')::interval
    )`
}

/**
 * Predicate limiting stock to what this DO line is actually entitled to take.
 *
 * Two disjoint pools, and the distinction is the whole point:
 *
 *   RESERVED to this line — allocation already pinned it here via
 *     stock_serial_numbers.do_line_item_id. Ours.
 *
 *   IN_STOCK and unpinned — free stock, available to whoever asks first.
 *
 * Stock RESERVED to a *different* line is deliberately excluded. Without that
 * exclusion an operator on one DO can pack inventory another DO is holding, and
 * the second order then fails at commit with a shortage it did not cause.
 *
 * `lineExpr` is SQL, not a value, so this works both where the line is a bind
 * parameter (the commit path) and where it is a joined column (the pack pool).
 */
export function reservableStockPredicate(alias = "s", lineExpr = "$1"): string {
  return `(
    (${alias}.status = 'RESERVED' AND ${alias}.do_line_item_id = ${lineExpr})
    OR (${alias}.status = 'IN_STOCK' AND ${alias}.do_line_item_id IS NULL)
  )`
}

/** Human-readable note for a rule, shown wherever allocation is presented. */
export function describeAllocationRule(rule: AllocationRule): string {
  switch (rule) {
    case "FEFO":
      return "First expired, first out — earliest expiry allocated first."
    case "BATCH":
      return "Batch-grouped — stock is allocated one batch at a time, oldest first."
    case "FIFO":
      return "First in, first out — oldest received stock allocated first."
    default:
      return `${rule} is not yet a distinct strategy; stock is allocated first in, first out.`
  }
}