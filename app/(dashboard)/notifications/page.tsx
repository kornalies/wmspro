"use client"

import { useState } from "react"
import { Bell, CheckCheck } from "lucide-react"
import { formatDistanceToNowStrict } from "date-fns"

import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/hooks/use-notifications"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export default function NotificationsPage() {
  const [status, setStatus] = useState<"all" | "unread">("all")
  const notificationsQuery = useNotifications(status, 50)
  const unreadCountQuery = useUnreadNotificationCount()
  const markReadMutation = useMarkNotificationRead()
  const markAllReadMutation = useMarkAllNotificationsRead()

  const rows = notificationsQuery.data ?? []

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-slate-700" />
            <h1 className="text-2xl font-semibold tracking-normal text-slate-950">Notifications</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Events from the mobile app and this workspace, most recent first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={status === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setStatus("all")}
          >
            All
          </Button>
          <Button
            variant={status === "unread" ? "default" : "outline"}
            size="sm"
            onClick={() => setStatus("unread")}
          >
            Unread{unreadCountQuery.data ? ` (${unreadCountQuery.data})` : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllReadMutation.mutate()}
            disabled={!unreadCountQuery.data || markAllReadMutation.isPending}
          >
            <CheckCheck className="h-4 w-4" />
            Mark all as read
          </Button>
        </div>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {status === "unread" ? "Unread" : "All"} notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {notificationsQuery.isLoading &&
            Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={`skeleton-${index}`} className="h-16 w-full" />
            ))}

          {!notificationsQuery.isLoading && rows.length === 0 && (
            <div className="py-12 text-center">
              <p className="font-medium text-slate-900">No notifications</p>
              <p className="text-sm text-slate-500">
                {status === "unread" ? "You're all caught up." : "Nothing has come in yet."}
              </p>
            </div>
          )}

          {rows.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                if (!n.read_at) markReadMutation.mutate(n.id)
              }}
              className={cn(
                "flex w-full flex-col items-start gap-1 rounded-md border px-4 py-3 text-left transition hover:bg-muted",
                !n.read_at && "bg-sky-50 dark:bg-sky-950/30"
              )}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-medium text-slate-900 dark:text-slate-100">{n.title}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {n.source}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNowStrict(new Date(n.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
              {n.body && <span className="text-sm text-muted-foreground">{n.body}</span>}
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
