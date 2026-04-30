"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useLaborMeta() {
  return useQuery({
    queryKey: ["labor", "meta"],
    queryFn: async () => apiClient.get("/labor/meta"),
  })
}

export function useLaborStandards(activeOnly = true) {
  return useQuery({
    queryKey: ["labor", "standards", activeOnly],
    queryFn: async () => apiClient.get(`/labor/standards?active=${activeOnly}`),
  })
}

export function useUpsertLaborStandard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/labor/standards", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labor", "standards"] })
      qc.invalidateQueries({ queryKey: ["labor", "meta"] })
      toast.success("Labor standard saved")
    },
    onError: (error) => handleError(error, "Failed to save labor standard"),
  })
}

export function useLaborShifts(shiftDate: string, warehouseId = "all") {
  return useQuery({
    queryKey: ["labor", "shifts", shiftDate, warehouseId],
    queryFn: async () =>
      apiClient.get(
        `/labor/shifts?shift_date=${encodeURIComponent(shiftDate)}&warehouse_id=${encodeURIComponent(
          warehouseId === "all" ? "0" : warehouseId
        )}`
      ),
  })
}

export function useUpsertLaborShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/labor/shifts", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labor", "shifts"] })
      qc.invalidateQueries({ queryKey: ["labor", "meta"] })
      toast.success("Labor shift saved")
    },
    onError: (error) => handleError(error, "Failed to save labor shift"),
  })
}

export function useLaborAssignments(shiftDate: string) {
  return useQuery({
    queryKey: ["labor", "assignments", shiftDate],
    queryFn: async () =>
      apiClient.get(`/labor/shifts/assignments?shift_date=${encodeURIComponent(shiftDate)}`),
  })
}

export function useUpsertLaborAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/labor/shifts/assignments", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labor", "assignments"] })
      qc.invalidateQueries({ queryKey: ["labor", "shifts"] })
      toast.success("Shift assignment saved")
    },
    onError: (error) => handleError(error, "Failed to save shift assignment"),
  })
}

export function useLaborProductivity(
  from: string,
  to: string,
  filters?: { userId?: string; shiftId?: string; warehouseId?: string }
) {
  return useQuery({
    queryKey: ["labor", "productivity", from, to, filters?.userId, filters?.shiftId, filters?.warehouseId],
    queryFn: async () => {
      const params = new URLSearchParams({
        from,
        to,
        user_id: filters?.userId && filters.userId !== "all" ? filters.userId : "0",
        shift_id: filters?.shiftId && filters.shiftId !== "all" ? filters.shiftId : "0",
        warehouse_id: filters?.warehouseId && filters.warehouseId !== "all" ? filters.warehouseId : "0",
      })
      return apiClient.get(`/labor/productivity?${params.toString()}`)
    },
  })
}

export function useCreateLaborProductivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/labor/productivity", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labor", "productivity"] })
      qc.invalidateQueries({ queryKey: ["labor", "exceptions"] })
      toast.success("Productivity event saved")
    },
    onError: (error) => handleError(error, "Failed to save productivity event"),
  })
}

export function useLaborExceptions(
  from: string,
  to: string,
  filters?: { userId?: string; shiftId?: string; warehouseId?: string }
) {
  return useQuery({
    queryKey: ["labor", "exceptions", from, to, filters?.userId, filters?.shiftId, filters?.warehouseId],
    queryFn: async () => {
      const params = new URLSearchParams({
        from,
        to,
        user_id: filters?.userId && filters.userId !== "all" ? filters.userId : "0",
        shift_id: filters?.shiftId && filters.shiftId !== "all" ? filters.shiftId : "0",
        warehouse_id: filters?.warehouseId && filters.warehouseId !== "all" ? filters.warehouseId : "0",
      })
      return apiClient.get(`/labor/exceptions?${params.toString()}`)
    },
  })
}
