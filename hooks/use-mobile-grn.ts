"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

type MobileCaptureRow = {
  id: number
  capture_ref: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  notes?: string | null
  approved_grn_id?: number | null
  invoice_number?: string | null
  supplier_name?: string | null
  created_at: string
}

type MobileCaptureDetail = {
  id: number
  capture_ref: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  notes?: string | null
  approved_grn_id?: number | null
  payload: {
    header: Record<string, unknown>
    lineItems: Array<{
      item_id: number
      quantity: number
      rate?: number
      serial_numbers: string[]
    }>
  }
  created_at: string
}

export function useMobileGrnCaptures(status: "PENDING" | "APPROVED" | "REJECTED" | "ALL") {
  return useQuery({
    queryKey: ["mobile-grn-captures", status],
    queryFn: async () => {
      const res = await apiClient.get<MobileCaptureRow[]>(
        `/mobile/grn/captures?status=${encodeURIComponent(status)}`
      )
      return res.data ?? []
    },
  })
}

export function useMobileGrnCaptureDetail(id: string) {
  return useQuery({
    queryKey: ["mobile-grn-capture", id],
    queryFn: async () => {
      const res = await apiClient.get<MobileCaptureDetail>(`/mobile/grn/captures/${id}`)
      return res.data
    },
    enabled: !!id,
  })
}

export function useApproveMobileCapture() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => apiClient.post<{ capture_id: number; grn_id: number }>(`/mobile/grn/captures/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mobile-grn-captures"] })
      toast.success("Mobile GRN approved")
    },
    onError: (error) => handleError(error, "Failed to approve mobile GRN"),
  })
}

export function useRejectMobileCapture() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, notes }: { id: number; notes?: string }) =>
      apiClient.post(`/mobile/grn/captures/${id}/reject`, { notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mobile-grn-captures"] })
      toast.success("Mobile GRN rejected")
    },
    onError: (error) => handleError(error, "Failed to reject mobile GRN"),
  })
}
