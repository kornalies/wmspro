"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import type { GRNFormPayload } from "@/lib/validations/grn"

type GrnRow = {
  id: number
  grn_number: string
  grn_date: string
  client_name: string
  warehouse_name: string
  invoice_number: string
  total_items: number
  total_quantity: number
  total_value?: number
  status: string
  created_at: string
  created_by_name?: string | null
  supplier_name?: string | null
  supplier_gst?: string | null
  source_channel?: string | null
  invoice_quantity?: number | null
  received_quantity?: number | null
  damage_quantity?: number | null
}

type GrnListResponse = {
  data: GrnRow[]
  pagination?: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

type GrnQueryParams = {
  page?: number
  limit?: number
  status?: string
  search?: string
  warehouse_id?: string
  client_id?: string
  date_from?: string
  date_to?: string
}

function buildQuery(params: GrnQueryParams) {
  const sp = new URLSearchParams()
  if (params.page) sp.set("page", String(params.page))
  if (params.limit) sp.set("limit", String(params.limit))
  if (params.status && params.status !== "all") sp.set("status", params.status)
  if (params.search) sp.set("search", params.search)
  if (params.client_id && params.client_id !== "all") sp.set("client_id", params.client_id)
  if (params.date_from) sp.set("date_from", params.date_from)
  if (params.date_to) sp.set("date_to", params.date_to)
  if (params.warehouse_id && params.warehouse_id !== "all") {
    sp.set("warehouse_id", params.warehouse_id)
  }
  return sp.toString()
}

export function useGRNs(params: GrnQueryParams) {
  return useQuery({
    queryKey: ["grns", params],
    queryFn: async (): Promise<GrnListResponse> => {
      const query = buildQuery(params)
      const res = await apiClient.get<GrnRow[]>(`/grn${query ? `?${query}` : ""}`)
      return {
        data: res.data ?? [],
        pagination: res.pagination,
      }
    },
  })
}

export function useCreateGRN() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: GRNFormPayload) => apiClient.post("/grn", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grns"] })
      toast.success("GRN created successfully")
    },
    onError: (error) => handleError(error, "Failed to create GRN"),
  })
}

export function useUpdateGRN() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: GRNFormPayload }) =>
      apiClient.put(`/grn/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grns"] })
      toast.success("GRN updated successfully")
    },
    onError: (error) => handleError(error, "Failed to update GRN"),
  })
}

export function useConfirmDraftGRN() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => apiClient.post(`/grn/${id}/confirm`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grns"] })
      toast.success("Draft GRN confirmed")
    },
    onError: (error) => handleError(error, "Failed to confirm draft GRN"),
  })
}

export function useCancelGRN() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => apiClient.delete(`/grn/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grns"] })
      toast.success("GRN cancelled successfully")
    },
    onError: (error) => handleError(error, "Failed to cancel GRN"),
  })
}
