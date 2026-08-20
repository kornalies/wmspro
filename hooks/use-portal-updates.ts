"use client"

/**
 * The portal's notification feed, shared by the shell's bell and the overview card.
 *
 * Deliberately not the react-query `useNotifications` hooks the operator dashboard
 * uses: those poll every 20 seconds, which is right for someone watching a dock
 * decision land and wrong for a client who opened their invoices in a tab. The 60s
 * interval here is the same one the overview card was written with -- keeping it
 * means the bell adds a place to read notifications, not three times the traffic.
 *
 * The rows are session-scoped by the API, so a portal user sees their own and
 * nothing else without any portal-specific route.
 */

import { useCallback, useEffect, useState } from "react"

export type PortalNotification = {
  id: number
  type: string
  title: string
  body: string | null
  data: Record<string, unknown>
  read_at: string | null
  created_at: string
}

const POLL_INTERVAL_MS = 60000

export function relativeTime(iso: string) {
  const then = new Date(iso).getTime()
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

export function usePortalUpdates(limit = 10) {
  const [rows, setRows] = useState<PortalNotification[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/notifications?status=all&limit=${limit}`, { cache: "no-store" })
      const json = await res.json()
      if (res.ok) setRows((json?.data || []) as PortalNotification[])
    } catch {
      // A failed poll is not worth showing the client an error over; the next
      // tick will pick it up.
    } finally {
      setLoaded(true)
    }
  }, [limit])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  const markRead = useCallback(
    async (id: number) => {
      // Optimistic: the badge should drop the moment the client acts on it.
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, read_at: new Date().toISOString() } : row))
      )
      try {
        await fetch(`/api/notifications/${id}/read`, { method: "POST" })
      } catch {
        void load()
      }
    },
    [load]
  )

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    setRows((current) => current.map((row) => (row.read_at ? row : { ...row, read_at: now })))
    try {
      await fetch("/api/notifications/read-all", { method: "POST" })
    } catch {
      void load()
    }
  }, [load])

  return {
    rows,
    loaded,
    unread: rows.filter((row) => !row.read_at).length,
    markRead,
    markAllRead,
    reload: load,
  }
}
