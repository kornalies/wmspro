"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useWesEquipment() {
  return useQuery({
    queryKey: ["wes", "equipment"],
    queryFn: async () => apiClient.get("/wes/equipment"),
  })
}

export function useUpsertWesEquipment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/wes/equipment", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wes", "equipment"] })
      qc.invalidateQueries({ queryKey: ["wes", "monitor"] })
      toast.success("Equipment saved")
    },
    onError: (error) => handleError(error, "Failed to save equipment"),
  })
}

export function useWesCommands(equipmentId?: number) {
  const suffix = equipmentId ? `?equipment_id=${equipmentId}` : ""
  return useQuery({
    queryKey: ["wes", "commands", equipmentId || 0],
    queryFn: async () => apiClient.get(`/wes/commands${suffix}`),
  })
}

export function useQueueWesCommand() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/wes/commands", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wes", "commands"] })
      qc.invalidateQueries({ queryKey: ["wes", "monitor"] })
      toast.success("Command queued")
    },
    onError: (error) => handleError(error, "Failed to queue command"),
  })
}

export function useWesMonitor(equipmentId?: number) {
  const suffix = equipmentId ? `?equipment_id=${equipmentId}` : ""
  return useQuery({
    queryKey: ["wes", "monitor", equipmentId || 0],
    queryFn: async () => apiClient.get(`/wes/monitor${suffix}`),
  })
}

export function useProcessWesQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.post("/wes/process", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wes", "commands"] })
      qc.invalidateQueries({ queryKey: ["wes", "monitor"] })
      qc.invalidateQueries({ queryKey: ["wes", "equipment"] })
      toast.success("WES processor run completed")
    },
    onError: (error) => handleError(error, "Failed to process queue"),
  })
}

export function useResolveWesIncident() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      incidentId,
      resolutionNotes,
      closeSafetyMode,
    }: {
      incidentId: number
      resolutionNotes: string
      closeSafetyMode?: boolean
    }) =>
      apiClient.post(`/wes/incidents/${incidentId}/resolve`, {
        resolution_notes: resolutionNotes,
        close_equipment_safety_mode: closeSafetyMode ?? false,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wes", "monitor"] })
      qc.invalidateQueries({ queryKey: ["wes", "equipment"] })
      toast.success("Incident resolved")
    },
    onError: (error) => handleError(error, "Failed to resolve incident"),
  })
}
