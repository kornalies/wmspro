"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export function useUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await apiClient.get("/users")
      return res.data ?? []
    },
  })
}

export function useSaveUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (payload.id) return apiClient.put("/users", payload)
      return apiClient.post("/users", payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] })
      toast.success("User saved")
    },
    onError: (error) => handleError(error, "Failed to save user"),
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => apiClient.delete(`/users?id=${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] })
      toast.success("User deactivated")
    },
    onError: (error) => handleError(error, "Failed to delete user"),
  })
}

type Resource = "clients" | "items" | "warehouses" | "zone-layouts" | "companies" | "contracts"

export function useAdminResource(resource: Resource) {
  return useQuery({
    queryKey: ["admin", resource],
    queryFn: async () => {
      const res = await apiClient.get(`/${resource}`)
      return res.data ?? []
    },
  })
}

export function useSaveAdminResource(resource: Resource) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (payload.id) return apiClient.put(`/${resource}`, payload)
      return apiClient.post(`/${resource}`, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", resource] })
      toast.success("Saved successfully")
    },
    onError: (error) => handleError(error, "Save failed"),
  })
}

export function useDeleteAdminResource(resource: Resource) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => apiClient.delete(`/${resource}?id=${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", resource] })
      toast.success("Deactivated")
    },
    onError: (error) => handleError(error, "Delete failed"),
  })
}

export function useRoles() {
  return useQuery({
    queryKey: ["admin", "roles"],
    queryFn: async () => {
      const res = await apiClient.get<Array<{ role_code: string; role_name: string }>>("/roles")
      return res.data ?? []
    },
  })
}
