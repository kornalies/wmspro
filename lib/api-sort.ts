/**
 * ORDER BY construction for the paginated list endpoints.
 *
 * The DO and GRN lists are server-paginated but had a hardcoded ORDER BY, while their
 * screens sorted client-side. That meant a header click only reordered the ~20 rows on
 * the current page: sorting by quantity descending gave you the largest of THAT PAGE,
 * silently, with no indication the other 39 pages were not considered.
 *
 * Two rules matter here and both are load-bearing:
 *
 * 1. The sort key is a LOOKUP, never interpolation. A caller-supplied string reaching
 *    the SQL text is injection, and ORDER BY cannot be parameterised with $n -- so the
 *    only safe construction is to map a key to an expression WE wrote and fall back to
 *    a default when it is not in the map. Nothing from the request is ever concatenated.
 *
 * 2. Every ordering ends in a unique tiebreak. Postgres gives no guarantee of a stable
 *    order for rows equal on the sort key, so two pages of a LIMIT/OFFSET walk can
 *    otherwise repeat a row on one page and drop it from another -- a paging bug that
 *    looks like data loss and reproduces only on ties.
 */

export type SortDirection = "ASC" | "DESC"

/** Maps an API sort key to the SQL expression that implements it. */
export type SortColumnMap = Record<string, string>

function normalizeDirection(value: string | null, fallback: SortDirection): SortDirection {
  const text = (value || "").trim().toUpperCase()
  return text === "ASC" || text === "DESC" ? text : fallback
}

/**
 * Build a complete, safe ORDER BY clause.
 *
 * `tiebreakExpression` must be unique per row (a primary key). Unrecognised sort keys
 * fall back to the default rather than erroring: a stale bookmark or an old client
 * should render a sensible list, not a 400.
 */
export function buildOrderBy(
  requestedKey: string | null,
  requestedDirection: string | null,
  columns: SortColumnMap,
  defaults: { key: string; direction: SortDirection },
  tiebreakExpression: string
): string {
  const key = requestedKey && requestedKey in columns ? requestedKey : defaults.key
  const expression = columns[key] ?? columns[defaults.key]
  const direction = normalizeDirection(requestedDirection, defaults.direction)

  // NULLS LAST in both directions, matching lib/table-sort.ts: a descending sort exists
  // to surface the largest values, and Postgres's default (NULLS FIRST on DESC) would
  // instead fill the top of the page with empty cells.
  return `ORDER BY ${expression} ${direction} NULLS LAST, ${tiebreakExpression} DESC`
}

/** True when a key is one this endpoint can actually sort on. Used to tell the UI. */
export function isSortableKey(key: string | null, columns: SortColumnMap): boolean {
  return Boolean(key && key in columns)
}
