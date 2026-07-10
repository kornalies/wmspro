"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

export type NotificationRow = {
  id: number
  source: string
  type: string
  title: string
  body: string | null
  data: Record<string, unknown>
  read_at: string | null
  created_at: string
}

const POLL_INTERVAL_MS = 20000

export function useNotifications(status: "unread" | "all" = "all", limit = 30) {
  return useQuery({
    queryKey: ["notifications", status, limit],
    queryFn: async () => {
      const res = await apiClient.get<NotificationRow[]>(
        `/notifications?status=${status}&limit=${limit}`
      )
      return res.data ?? []
    },
    refetchInterval: POLL_INTERVAL_MS,
  })
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const res = await apiClient.get<{ count: number }>("/notifications/unread-count")
      return res.data?.count ?? 0
    },
    refetchInterval: POLL_INTERVAL_MS,
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => apiClient.post(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] })
    },
    onError: (error) => handleError(error, "Failed to mark notification as read"),
  })
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => apiClient.post("/notifications/read-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] })
    },
    onError: (error) => handleError(error, "Failed to mark notifications as read"),
  })
}
