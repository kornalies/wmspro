"use client"

import { useQuery } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"

type StockFilters = {
  serial?: string
  item?: string
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
}

type StockSearchResponse<T> = {
  rows: T[]
  summary: StockSearchSummary
}

function buildQuery(filters: StockFilters, page: number, limit: number) {
  const sp = new URLSearchParams()
  if (filters.serial) sp.set("serial", filters.serial)
  if (filters.item) sp.set("item", filters.item)
  if (filters.status) sp.set("status", filters.status)
  if (filters.warehouseId && filters.warehouseId !== "all") {
    sp.set("warehouse_id", filters.warehouseId)
  }
  if (filters.minAge) sp.set("min_age", filters.minAge)
  if (filters.maxAge) sp.set("max_age", filters.maxAge)
  sp.set("page", String(page))
  sp.set("limit", String(limit))
  return sp.toString()
}

export function useStockSearch<T>(filters: StockFilters, page = 1, limit = 50) {
  return useQuery({
    queryKey: ["stock", "search", filters, page, limit],
    queryFn: async () => {
      const q = buildQuery(filters, page, limit)
      const res = await apiClient.get<StockSearchResponse<T>>(`/stock/search?${q}`)
      return {
        rows: res.data?.rows ?? [],
        summary: res.data?.summary ?? { in_stock: 0, reserved: 0, dispatched: 0, avg_age_days: 0 },
        pagination: res.pagination ?? { page, limit, total: 0, totalPages: 1 },
      }
    },
  })
}
