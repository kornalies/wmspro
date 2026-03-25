"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import type { DOWorkflowStatus } from "@/lib/do-status"
import { handleError } from "@/lib/error-handler"

type DOQueryParams = {
  page?: number
  status?: string
  search?: string
  warehouse_id?: string
}

type DORef = number | string

type DispatchPayload = {
  vehicle_number: string
  driver_name: string
  driver_phone: string
  seal_number?: string
  dispatch_date?: string
  dispatch_time?: string
  remarks?: string
  supplierName?: string
  invoiceNo?: string
  invoiceDate?: string
  modelNo?: string
  serialNo?: string
  materialDescription?: string
  dateOfManufacturing?: string
  basicPrice?: number
  invoiceQty?: number
  dispatchedQty?: number
  difference?: number
  noOfCases?: number
  noOfPallets?: number
  weight?: number
  handlingType?: string
  machineType?: string
  machineFromTime?: string
  machineToTime?: string
  outwardRemarks?: string
  doNo?: string
  clientName?: string
  items: Array<{ item_id: number; quantity: number }>
}

type ReversePayload = {
  id: number
  reason?: string
}

type WorkflowStatusPayload = {
  status: DOWorkflowStatus
}

function buildQuery(params: DOQueryParams) {
  const sp = new URLSearchParams()
  if (params.page) sp.set("page", String(params.page))
  if (params.status && params.status !== "all") sp.set("status", params.status)
  if (params.search) sp.set("search", params.search)
  if (params.warehouse_id && params.warehouse_id !== "all") sp.set("warehouse_id", params.warehouse_id)
  return sp.toString()
}

export function useDOs(params: DOQueryParams) {
  return useQuery({
    queryKey: ["dos", params],
    queryFn: async () => {
      const q = buildQuery(params)
      return apiClient.get(`/do${q ? `?${q}` : ""}`)
    },
  })
}

function normalizeRef(id: DORef | null) {
  if (id == null) return null
  const value = String(id).trim()
  return value.length > 0 ? value : null
}

export function useDO(id: DORef | null) {
  const ref = normalizeRef(id)
  return useQuery({
    queryKey: ["do", ref],
    enabled: !!ref,
    queryFn: async () => apiClient.get(`/do/${encodeURIComponent(ref || "")}`),
  })
}

export function useCreateDO() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/do", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dos"] })
      toast.success("Delivery order created")
    },
    onError: (error) => handleError(error, "Failed to create delivery order"),
  })
}

export function useDispatchDO(id: DORef) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: DispatchPayload) =>
      apiClient.post(`/do/${encodeURIComponent(ref)}/dispatch`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dos"] })
      qc.invalidateQueries({ queryKey: ["do", ref] })
      toast.success("Dispatch recorded")
    },
    onError: (error) => handleError(error, "Failed to dispatch delivery order"),
  })
}

export function useCaptureDO(id: DORef) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: Partial<DispatchPayload>) =>
      apiClient.post(`/do/${encodeURIComponent(ref)}/capture`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dos"] })
      qc.invalidateQueries({ queryKey: ["do", ref] })
      toast.success("DO capture submitted")
    },
    onError: (error) => handleError(error, "Failed to submit DO capture"),
  })
}

export function useReverseDO() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: ReversePayload) =>
      apiClient.post(`/do/${payload.id}/reverse`, { reason: payload.reason }),
    onSuccess: (_, payload) => {
      qc.invalidateQueries({ queryKey: ["dos"] })
      qc.invalidateQueries({ queryKey: ["do", payload.id] })
      toast.success("DO reversed and stock restored")
    },
    onError: (error) => handleError(error, "Failed to reverse delivery order"),
  })
}

export function useUpdateDOStatus(id: DORef) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: WorkflowStatusPayload) =>
      apiClient.post(`/do/${encodeURIComponent(ref)}/status`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dos"] })
      qc.invalidateQueries({ queryKey: ["do", ref] })
      toast.success("DO status updated")
    },
    onError: (error) => handleError(error, "Failed to update DO status"),
  })
}
