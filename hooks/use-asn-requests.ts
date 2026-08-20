"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export type AsnRequestRow = {
  id: number
  request_number: string
  client_id: number
  client_name: string
  client_code: string
  expected_date: string | null
  remarks: string | null
  status: "REQUESTED" | "ACCEPTED" | "REJECTED" | "RECEIVED" | "CANCELLED"
  reviewed_at: string | null
  review_remarks: string | null
  requested_by_name: string | null
  reviewed_by_name: string | null
  created_at: string
  // pg returns COUNT and SUM as strings; every consumer must coerce.
  line_count: string | number
  expected_quantity: string | number
  receipt_count: string | number
}

export type AsnRequestLine = {
  id: number
  line_number: number
  item_id: number
  item_code: string
  item_name: string
  expected_quantity: string | number
  uom: string | null
  batch_no: string | null
  expiry_date: string | null
  remarks: string | null
}

export type AsnRequestDetail = AsnRequestRow & {
  lines: AsnRequestLine[]
  receipts: Array<{
    id: number
    grn_number: string
    grn_date: string
    status: string
    total_quantity: string | number
  }>
}

export function useAsnRequests(params: { status?: string; search?: string } = {}) {
  const search = new URLSearchParams()
  if (params.status) search.set("status", params.status)
  if (params.search) search.set("search", params.search)
  const qs = search.toString()

  return useQuery({
    queryKey: ["asn-requests", params.status ?? "", params.search ?? ""],
    queryFn: async () => {
      const res = await apiClient.get<AsnRequestRow[]>(`/grn/asn-requests${qs ? `?${qs}` : ""}`)
      return res.data ?? []
    },
  })
}

export function useAsnRequest(id: number | null) {
  return useQuery({
    queryKey: ["asn-request", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await apiClient.get<AsnRequestDetail>(`/grn/asn-requests/${id}`)
      return res.data
    },
  })
}

export function useReviewAsnRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: number; decision: "ACCEPT" | "REJECT"; remarks?: string }) => {
      const res = await apiClient.post(`/grn/asn-requests/${input.id}/decision`, {
        decision: input.decision,
        remarks: input.remarks,
      })
      return res.data
    },
    onSuccess: (_data, variables) => {
      toast.success(variables.decision === "ACCEPT" ? "Shipment accepted" : "Request rejected")
      queryClient.invalidateQueries({ queryKey: ["asn-requests"] })
      queryClient.invalidateQueries({ queryKey: ["asn-request", variables.id] })
    },
    onError: (error) => handleError(error),
  })
}
