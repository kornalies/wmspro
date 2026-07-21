"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export type QcHoldRow = {
  hold_id: string
  grn_line_item_id: number
  lp_id: string
  lp_code: string | null
  sku: string | null
  result: string | null
  reason_code: string | null
  rejected_qty: number | null
  accepted_qty: number | null
  total_qty: number | null
  remarks: string | null
  hold_reason: string | null
  inspector_name: string | null
  submitted_at: string | null
  created_at: string
}

export type QcDisposition = "RELEASE" | "SCRAP" | "RETURN_TO_VENDOR" | "REWORK"

export function useQcHolds() {
  return useQuery({
    queryKey: ["qc-holds"],
    queryFn: async () => {
      const res = await apiClient.get<QcHoldRow[]>("/qc/holds")
      return res.data ?? []
    },
  })
}

export function useDispositionQcHold() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { hold_id: string; disposition: QcDisposition }) => {
      const res = await apiClient.post("/qc/holds", input)
      return res.data
    },
    onSuccess: () => {
      toast.success("QC hold dispositioned")
      queryClient.invalidateQueries({ queryKey: ["qc-holds"] })
    },
    onError: (error) => handleError(error),
  })
}