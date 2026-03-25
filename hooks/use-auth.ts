"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"

type AuthUser = {
  id: number
  username: string
  email: string
  full_name: string
  role: string
  roles?: string[]
  permissions?: string[]
  company_id: number
  company_code?: string
  company_name?: string
  warehouse_id?: number
}

type LoginPayload = {
  company_code: string
  username: string
  password: string
}

export function useMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const res = await apiClient.get<AuthUser>("/auth/me")
      return res.user ?? res.data
    },
    retry: false,
  })
}

export function useLogin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: LoginPayload) => apiClient.post<AuthUser>("/auth/login", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] })
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => apiClient.post<null>("/auth/logout"),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["auth", "me"] })
    },
  })
}

export function useSwitchCompany() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (companyId: number) =>
      apiClient.post<{ company_id: number; company_code: string }>("/auth/switch-company", {
        company_id: companyId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] })
      queryClient.invalidateQueries({ queryKey: ["admin"] })
    },
  })
}

export function useAuth() {
  const { data: user, isLoading, isError } = useMe()

  const hasRole = (roles: string[]) => {
    if (!user?.role) return false
    return roles.includes(user.role)
  }

  const hasPermission = (permissions: string[]) => {
    if (!user?.permissions?.length) return false
    return permissions.some((perm) => user.permissions?.includes(perm))
  }

  return {
    user,
    isLoading,
    isAuthenticated: !!user && !isError,
    hasRole,
    hasPermission,
    isAdmin: hasPermission(["admin.users.manage"]),
    canManage: hasPermission(["master.data.manage"]),
  }
}
