"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useDOWaves(status = "all") {
  return useQuery({
    queryKey: ["do-waves", status],
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (status !== "all") qp.set("status", status)
      return apiClient.get(`/do/waves${qp.toString() ? `?${qp.toString()}` : ""}`)
    },
  })
}

export function useCreateDOWave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/do/waves", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-waves"] })
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      toast.success("Wave created")
    },
    onError: (error) => handleError(error, "Failed to create wave"),
  })
}

export function useReleaseDOWave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (waveId: number) => apiClient.post(`/do/waves/${waveId}/release`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-waves"] })
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      toast.success("Wave released")
    },
    onError: (error) => handleError(error, "Failed to release wave"),
  })
}

export function useAllocateDOWave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      waveId,
      userIds,
      maxTasksPerUser,
    }: {
      waveId: number
      userIds: number[]
      maxTasksPerUser?: number
    }) =>
      apiClient.post(`/do/waves/${waveId}/allocate`, {
        user_ids: userIds,
        max_tasks_per_user: maxTasksPerUser ?? 30,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      toast.success("Wave allocation completed")
    },
    onError: (error) => handleError(error, "Failed to allocate wave"),
  })
}

export function useDOWaveTasks(waveId?: number) {
  return useQuery({
    queryKey: ["do-wave-tasks", waveId || "all"],
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (waveId) qp.set("wave_id", String(waveId))
      return apiClient.get(`/do/waves/tasks${qp.toString() ? `?${qp.toString()}` : ""}`)
    },
  })
}

export function useAssignTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ taskId, userId }: { taskId: number; userId?: number }) =>
      apiClient.post(`/do/waves/tasks/${taskId}/assign`, userId ? { user_id: userId } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      toast.success("Task assigned")
    },
    onError: (error) => handleError(error, "Failed to assign task"),
  })
}

export function useStartTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (taskId: number) => apiClient.post(`/do/waves/tasks/${taskId}/start`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      qc.invalidateQueries({ queryKey: ["do-waves"] })
      toast.success("Task started")
    },
    onError: (error) => handleError(error, "Failed to start task"),
  })
}

export function useCompleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ taskId, pickedQty }: { taskId: number; pickedQty?: number }) =>
      apiClient.post(`/do/waves/tasks/${taskId}/complete`, pickedQty ? { picked_quantity: pickedQty } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["do-wave-tasks"] })
      qc.invalidateQueries({ queryKey: ["do-waves"] })
      qc.invalidateQueries({ queryKey: ["dos"] })
      toast.success("Task completed")
    },
    onError: (error) => handleError(error, "Failed to complete task"),
  })
}
