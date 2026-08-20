"use client"

/**
 * The list table every portal screen shares.
 *
 * There were four hand-rolled `<table>` blocks in the portal, none of them
 * sortable, searchable or paged -- while the app already had a shared comparator
 * (lib/table-sort) built precisely because hand-rolled sorts kept getting the same
 * three things wrong. This wires the portal into it.
 *
 * Two things it does that the old tables did not:
 *
 * 1. It renders all four states. "Loading billing..." as a bare string, a grey
 *    "No records found", and red error text with no way forward are three different
 *    ways of telling a client nothing. A skeleton keeps the layout still, the empty
 *    state says what would appear here, and the error offers a retry.
 *
 * 2. Below `md` it stops being a table. A twelve-column invoice grid inside
 *    overflow-x-auto is a horizontal scrollbar, not a layout, and the portal is the
 *    one part of this product routinely opened on a phone.
 */

import { useMemo, useState, type ReactNode } from "react"

import {
  defaultDirFor,
  makeComparator,
  nextSortState,
  type SortDir,
  type ValueKind,
} from "@/lib/table-sort"

export type PortalColumn<T> = {
  key: string
  label: string
  /**
   * What the column holds. Declared, never inferred: postgres `numeric` arrives as
   * a string, so anything that sniffs the type at compare time sorts money as text.
   */
  kind: ValueKind
  /** Raw cell value, used for sorting and search. */
  value: (row: T) => unknown
  /** Display. Defaults to the raw value. */
  render?: (row: T) => ReactNode
  align?: "left" | "right"
  /** Set false for action columns and anything whose text would pollute search. */
  sortable?: boolean
  searchable?: boolean
  /**
   * Where this column goes on the phone card. "title" is the headline, "figure" the
   * one big number, "meta" a labelled line, "hidden" drops it.
   */
  card?: "title" | "figure" | "meta" | "actions" | "hidden"
}

export type PortalFilter = {
  key: string
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}

type PortalTableProps<T> = {
  rows: T[]
  columns: Array<PortalColumn<T>>
  rowKey: (row: T) => string | number
  loading?: boolean
  error?: string
  onRetry?: () => void
  /** What this list is, for the search box and the empty state. */
  noun?: { singular: string; plural: string }
  searchPlaceholder?: string
  filters?: PortalFilter[]
  empty?: { title: string; body?: string; action?: ReactNode }
  pageSize?: number
  /** Defaults to the first sortable column. */
  initialSort?: { key: string; dir: SortDir }
  /** Rendered inline above the table, right-aligned. */
  toolbar?: ReactNode
}

function SkeletonRows({ columns, rows = 6 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-t border-neutral-100">
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <td key={cellIndex} className="px-3 py-3">
              <div
                className="h-3 animate-pulse rounded bg-neutral-200"
                style={{ width: `${55 + ((rowIndex * 7 + cellIndex * 13) % 40)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export function PortalTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  error = "",
  onRetry,
  noun = { singular: "record", plural: "records" },
  searchPlaceholder,
  filters = [],
  empty,
  pageSize = 25,
  initialSort,
  toolbar,
}: PortalTableProps<T>) {
  const sortableColumns = columns.filter((column) => column.sortable !== false)
  const firstSortable = sortableColumns[0] ?? columns[0]

  const [sort, setSort] = useState<{ key: string; dir: SortDir }>(
    initialSort ?? { key: firstSortable?.key ?? "", dir: defaultDirFor(firstSortable?.kind ?? "text") }
  )
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  // Searching or filtering while on page 3 would otherwise leave the reader on an
  // empty page. Adjusted during render rather than in an effect: an effect would
  // paint the empty page first and then correct it, and React flags the cascading
  // render it causes.
  const filterSignature = filters.map((filter) => filter.value).join("|")
  const hasActiveFilter = filters.some((filter) => Boolean(filter.value))
  const queryKey = `${search}::${filterSignature}`
  const [lastQueryKey, setLastQueryKey] = useState(queryKey)
  if (lastQueryKey !== queryKey) {
    setLastQueryKey(queryKey)
    setPage(1)
  }

  const searched = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    const haystackColumns = columns.filter((column) => column.searchable !== false)
    return rows.filter((row) =>
      haystackColumns.some((column) => {
        const value = column.value(row)
        return value !== null && value !== undefined && String(value).toLowerCase().includes(needle)
      })
    )
  }, [columns, rows, search])

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sort.key)
    if (!column) return searched
    return [...searched].sort(makeComparator(column.value, column.kind, sort.dir, rowKey))
  }, [columns, rowKey, searched, sort])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const visible = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const titleColumn = columns.find((column) => column.card === "title") ?? columns[0]
  const figureColumn = columns.find((column) => column.card === "figure")
  const actionsColumn = columns.find((column) => column.card === "actions")
  const metaColumns = columns.filter(
    (column) => column.card === "meta" || (!column.card && column !== titleColumn)
  )

  const cell = (column: PortalColumn<T>, row: T): ReactNode => {
    if (column.render) return column.render(row)
    const value = column.value(row)
    return value === null || value === undefined || value === "" ? "—" : String(value)
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-medium text-red-900">We could not load your {noun.plural}.</p>
        <p className="mt-1 text-sm text-red-800">{error}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        ) : null}
      </div>
    )
  }

  const showToolbar = !loading && (rows.length > 0 || Boolean(search) || hasActiveFilter)

  return (
    <div className="space-y-3">
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="portal-table-search" className="sr-only">
              Search {noun.plural}
            </label>
            <input
              id="portal-table-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder || `Search ${noun.plural}`}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            />
          </div>

          {filters.map((filter) => (
            <div key={filter.key}>
              <label htmlFor={`portal-filter-${filter.key}`} className="sr-only">
                {filter.label}
              </label>
              <select
                id={`portal-filter-${filter.key}`}
                value={filter.value}
                onChange={(event) => filter.onChange(event.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                {filter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ))}

          {toolbar ? <div className="ml-auto flex items-center gap-2">{toolbar}</div> : null}
        </div>
      ) : null}

      {/* Desktop */}
      <div className="hidden overflow-hidden rounded-xl border border-neutral-200 bg-white md:block">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-neutral-50">
                {columns.map((column) => {
                  const active = sort.key === column.key
                  const alignment = column.align === "right" ? "text-right" : "text-left"
                  if (column.sortable === false) {
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 ${alignment}`}
                      >
                        {column.label}
                      </th>
                    )
                  }
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 ${alignment}`}
                    >
                      <button
                        type="button"
                        onClick={() => setSort((current) => nextSortState(current, column.key, column.kind))}
                        className={`inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                          column.align === "right" ? "flex-row-reverse" : ""
                        } ${active ? "text-neutral-900" : ""}`}
                      >
                        {column.label}
                        <span aria-hidden className="text-[10px] text-neutral-400">
                          {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows columns={columns.length} />
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-3 py-12 text-center">
                    <p className="text-sm font-medium text-neutral-800">
                      {search || hasActiveFilter
                        ? `No ${noun.plural} match your search`
                        : empty?.title || `No ${noun.plural} yet`}
                    </p>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
                      {search || hasActiveFilter
                        ? "Try a different search term, or clear the filters."
                        : empty?.body || ""}
                    </p>
                    {empty?.action && !search ? <div className="mt-3">{empty.action}</div> : null}
                  </td>
                </tr>
              ) : (
                visible.map((row) => (
                  <tr key={rowKey(row)} className="border-t border-neutral-100 transition hover:bg-neutral-50">
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`px-3 py-2.5 align-middle text-neutral-700 ${
                          column.align === "right" ? "text-right tabular-nums" : "text-left"
                        }`}
                      >
                        {cell(column, row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: the same rows, as cards. */}
      <div className="space-y-2 md:hidden">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <div className="h-3.5 w-1/2 animate-pulse rounded bg-neutral-200" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-100" />
            </div>
          ))
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center">
            <p className="text-sm font-medium text-neutral-800">
              {search ? `No ${noun.plural} match your search` : empty?.title || `No ${noun.plural} yet`}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {search ? "Try a different search term." : empty?.body || ""}
            </p>
            {empty?.action && !search ? <div className="mt-3">{empty.action}</div> : null}
          </div>
        ) : (
          visible.map((row) => (
            <article key={rowKey(row)} className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-words text-sm font-semibold text-neutral-900">
                  {titleColumn ? cell(titleColumn, row) : null}
                </p>
                {figureColumn ? (
                  <p className="shrink-0 text-right text-base font-semibold tabular-nums text-neutral-900">
                    {cell(figureColumn, row)}
                  </p>
                ) : null}
              </div>
              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {metaColumns.map((column) => (
                  <div key={column.key} className="min-w-0">
                    <dt className="text-[11px] uppercase tracking-wide text-neutral-400">{column.label}</dt>
                    <dd className="truncate text-sm text-neutral-700">{cell(column, row)}</dd>
                  </div>
                ))}
              </dl>
              {actionsColumn ? (
                <div className="mt-3 border-t border-neutral-100 pt-3">{cell(actionsColumn, row)}</div>
              ) : null}
            </article>
          ))
        )}
      </div>

      {!loading && sorted.length > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="text-neutral-500">
            Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sorted.length)} of{" "}
            {sorted.length} {sorted.length === 1 ? noun.singular : noun.plural}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={currentPage === 1}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-neutral-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={currentPage === totalPages}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
