/**
 * Seed a list screen's filter state from the query string.
 *
 * Read once, in a `useState` initialiser, the same way saved views are read from
 * localStorage on these screens. This is deliberately not `useSearchParams`: the
 * value is only ever an initial default, and reading it directly keeps the list
 * pages out of the Suspense boundary that hook requires at build time.
 *
 * The point is drill-down. Reports aggregate rows out of GRNs, DOs and serials;
 * without this the only thing a report row could do was tell you what it had
 * counted and leave you to find those records by hand.
 */
export function readUrlFilter(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback
  const value = new URLSearchParams(window.location.search).get(name)
  return value === null || value === "" ? fallback : value
}

export function hasUrlFilters(...names: string[]): boolean {
  if (typeof window === "undefined") return false
  const params = new URLSearchParams(window.location.search)
  return names.some((name) => (params.get(name) ?? "") !== "")
}
