"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

type ShipmentQueryParams = {
  page?: number
  status?: string
  mode?: string
  search?: string
}

function buildQuery(params: ShipmentQueryParams) {
  const sp = new URLSearchParams()
  if (params.page) sp.set("page", String(params.page))
  if (params.status && params.status !== "all") sp.set("status", params.status)
  if (params.mode && params.mode !== "all") sp.set("mode", params.mode)
  if (params.search) sp.set("search", params.search)
  return sp.toString()
}

export function useFreightShipments(params: ShipmentQueryParams) {
  return useQuery({
    queryKey: ["freight", "shipments", params],
    queryFn: async () => {
      const q = buildQuery(params)
      return apiClient.get(`/freight/shipments${q ? `?${q}` : ""}`)
    },
  })
}

export function useFreightShipment(id: number | string | null | undefined) {
  const ref = String(id || "").trim()
  return useQuery({
    queryKey: ["freight", "shipment", ref],
    enabled: !!ref,
    queryFn: async () => apiClient.get(`/freight/shipments/${encodeURIComponent(ref)}`),
  })
}

export function useCreateFreightShipment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => apiClient.post("/freight/shipments", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight", "shipments"] })
      toast.success("Shipment created")
    },
    onError: (error) => handleError(error, "Failed to create shipment"),
  })
}

export function useUpdateFreightShipment(id: number | string) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiClient.patch(`/freight/shipments/${encodeURIComponent(ref)}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight", "shipments"] })
      qc.invalidateQueries({ queryKey: ["freight", "shipment", ref] })
      toast.success("Shipment updated")
    },
    onError: (error) => handleError(error, "Failed to update shipment"),
  })
}

export function useAddFreightLeg(id: number | string) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiClient.post(`/freight/shipments/${encodeURIComponent(ref)}/legs`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight", "shipment", ref] })
      toast.success("Leg added")
    },
    onError: (error) => handleError(error, "Failed to add leg"),
  })
}

export function useAddFreightMilestone(id: number | string) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiClient.post(`/freight/shipments/${encodeURIComponent(ref)}/milestones`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight", "shipment", ref] })
      toast.success("Milestone added")
    },
    onError: (error) => handleError(error, "Failed to add milestone"),
  })
}

export function useAddFreightDocument(id: number | string) {
  const qc = useQueryClient()
  const ref = String(id).trim()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiClient.post(`/freight/shipments/${encodeURIComponent(ref)}/documents`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["freight", "shipment", ref] })
      toast.success("Document added")
    },
    onError: (error) => handleError(error, "Failed to add document"),
  })
}
