"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useIntegrationConnectors() {
  return useQuery({
    queryKey: ["integrations", "connectors"],
    queryFn: async () => apiClient.get("/integrations/connectors"),
  })
}

export function useUpsertConnector() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/integrations/connectors", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "connectors"] })
      toast.success("Connector saved")
    },
    onError: (error) => handleError(error, "Failed to save connector"),
  })
}

export function useConnectorCredentials(connectorId?: number) {
  return useQuery({
    queryKey: ["integrations", "credentials", connectorId || 0],
    queryFn: async () =>
      connectorId
        ? apiClient.get(`/integrations/connectors/${connectorId}/credentials`)
        : { data: [] },
    enabled: !!connectorId,
  })
}

export function useSaveConnectorCredential(connectorId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => {
      if (!connectorId) throw new Error("Select connector first")
      return apiClient.post(`/integrations/connectors/${connectorId}/credentials`, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "credentials"] })
      qc.invalidateQueries({ queryKey: ["integrations", "connectors"] })
      toast.success("Credential saved")
    },
    onError: (error) => handleError(error, "Failed to save credential"),
  })
}

export function useIntegrationMappings(connectorId?: number) {
  const suffix = connectorId ? `?connector_id=${connectorId}` : ""
  return useQuery({
    queryKey: ["integrations", "mappings", connectorId || 0],
    queryFn: async () => apiClient.get(`/integrations/mappings${suffix}`),
  })
}

export function useUpsertIntegrationMapping() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/integrations/mappings", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "mappings"] })
      toast.success("Mapping saved")
    },
    onError: (error) => handleError(error, "Failed to save mapping"),
  })
}

export function useIntegrationMonitor(from: string, to: string, connectorId?: number) {
  const q = new URLSearchParams({ from, to })
  if (connectorId) q.set("connector_id", String(connectorId))
  return useQuery({
    queryKey: ["integrations", "monitor", from, to, connectorId || 0],
    queryFn: async () => apiClient.get(`/integrations/monitor?${q.toString()}`),
  })
}

export function useDispatchIntegrationEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => apiClient.post("/integrations/events/dispatch", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "monitor"] })
      toast.success("Event queued")
    },
    onError: (error) => handleError(error, "Failed to queue event"),
  })
}

export function useProcessIntegrationQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.post("/integrations/events/process", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "monitor"] })
      toast.success("Queue processed")
    },
    onError: (error) => handleError(error, "Failed to process queue"),
  })
}

export function useProcessConnectorQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (connectorId: number) =>
      apiClient.post(`/integrations/events/process/${connectorId}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "monitor"] })
      toast.success("Connector queue processed")
    },
    onError: (error) => handleError(error, "Failed to process connector queue"),
  })
}

export function useRetryIntegrationEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId: number) => apiClient.post(`/integrations/events/${eventId}/retry`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "monitor"] })
      toast.success("Event moved to queue")
    },
    onError: (error) => handleError(error, "Failed to retry event"),
  })
}
