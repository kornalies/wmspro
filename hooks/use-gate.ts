"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useGateInLogs() {
  return useQuery({
    queryKey: ["gate", "in"],
    queryFn: async () => apiClient.get("/gate/in"),
  })
}

export function useGateOutLogs() {
  return useQuery({
    queryKey: ["gate", "out"],
    queryFn: async () => apiClient.get("/gate/out"),
  })
}

export function useCreateGateIn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/gate/in", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gate", "in"] })
      toast.success("Gate in recorded")
    },
    onError: (error) => handleError(error, "Failed to record gate in"),
  })
}

export function useCreateGateOut() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/gate/out", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gate", "out"] })
      toast.success("Gate out recorded")
    },
    onError: (error) => handleError(error, "Failed to record gate out"),
  })
}
