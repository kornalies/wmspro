"use client"

import { useQuery } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"

type StockFilters = {
  serial?: string
  lpId?: string
  item?: string
  clientId?: string
  status?: string
  warehouseId?: string
  minAge?: string
  maxAge?: string
}

type StockSearchSummary = {
  in_stock: number
  reserved: number
  dispatched: number
  avg_age_days: number
  total_serials: number
  total_items: number
}

type StockSearchResponse<T> = {
  rows: T[]
  summary: StockSearchSummary
}

const EMPTY_SUMMARY: StockSearchSummary = {
  in_stock: 0,
  reserved: 0,
  dispatched: 0,
  avg_age_days: 0,
  total_serials: 0,
  total_items: 0,
}

function appendFilters(sp: URLSearchParams, filters: StockFilters) {
  if (filters.serial) sp.set("serial", filters.serial)
  if (filters.lpId) sp.set("lp", filters.lpId)
  if (filters.item) sp.set("item", filters.item)
  if (filters.clientId && filters.clientId !== "all") sp.set("client_id", filters.clientId)
  if (filters.status) sp.set("status", filters.status)
  if (filters.warehouseId && filters.warehouseId !== "all") {
    sp.set("warehouse_id", filters.warehouseId)
  }
  if (filters.minAge) sp.set("min_age", filters.minAge)
  if (filters.maxAge) sp.set("max_age", filters.maxAge)
}

/**
 * Item-summary search: one lightweight row per item (counts only), paginated by item.
 * This is the default consolidated Stock Search view — serials are loaded lazily per
 * item via {@link useItemStockSerials}, so the payload stays flat at any depth.
 */
export function useStockSearch<T>(filters: StockFilters, page = 1, limit = 50) {
  return useQuery({
    queryKey: ["stock", "search", "items", filters, page, limit],
    queryFn: async () => {
      const sp = new URLSearchParams()
      sp.set("group", "item")
      appendFilters(sp, filters)
      sp.set("page", String(page))
      sp.set("limit", String(limit))
      const res = await apiClient.get<StockSearchResponse<T>>(`/stock/search?${sp.toString()}`)
      return {
        rows: res.data?.rows ?? [],
        summary: res.data?.summary ?? EMPTY_SUMMARY,
        pagination: res.pagination ?? { page, limit, total: 0, totalPages: 1 },
      }
    },
  })
}

/**
 * Lazily fetch the serials for a single item (the expand drill-down). Disabled until
 * an item is actually expanded, and paginated so even a very high-volume SKU loads a
 * bounded batch at a time.
 */
export function useItemStockSerials<T>(
  itemId: number | null,
  filters: StockFilters,
  page = 1,
  limit = 100
) {
  return useQuery({
    enabled: itemId != null,
    queryKey: ["stock", "search", "serials", itemId, filters, page, limit],
    queryFn: async () => {
      const sp = new URLSearchParams()
      appendFilters(sp, filters)
      sp.set("item_id", String(itemId))
      sp.set("page", String(page))
      sp.set("limit", String(limit))
      const res = await apiClient.get<StockSearchResponse<T>>(`/stock/search?${sp.toString()}`)
      return {
        rows: res.data?.rows ?? [],
        pagination: res.pagination ?? { page, limit, total: 0, totalPages: 1 },
      }
    },
  })
}

type StockExportResponse<T> = {
  rows: T[]
  truncated: boolean
  limit: number
}

/**
 * Fetch every serial matching the current filters for an Excel export. Server-capped
 * (see EXPORT_LIMIT) so an unfiltered export can't pull the whole tenant; `truncated`
 * signals the cap was hit.
 */
export async function fetchStockExport<T>(filters: StockFilters): Promise<StockExportResponse<T>> {
  const sp = new URLSearchParams()
  appendFilters(sp, filters)
  const res = await apiClient.get<StockExportResponse<T>>(`/stock/search/export?${sp.toString()}`)
  return {
    rows: res.data?.rows ?? [],
    truncated: Boolean(res.data?.truncated),
    limit: res.data?.limit ?? 0,
  }
}