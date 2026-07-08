"use client"

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { Bell, LogOut, Menu, Moon, Search, Sun } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { formatDistanceToNowStrict } from "date-fns"

import { useAuth, useLogout, useSwitchCompany } from "@/hooks/use-auth"
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/hooks/use-notifications"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { handleError } from "@/lib/error-handler"
import { apiClient } from "@/lib/api-client"
import { cn } from "@/lib/utils"

type CompanyOption = {
  id: number
  company_code: string
  company_name: string
  is_active: boolean
}

export function AppHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const { user } = useAuth()
  const logoutMutation = useLogout()
  const { theme, setTheme } = useTheme()
  const [globalSearchState, setGlobalSearchState] = useState({ value: "", pathname })
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const notificationsRef = useRef<HTMLDivElement | null>(null)
  const switchCompanyMutation = useSwitchCompany()
  const unreadCountQuery = useUnreadNotificationCount()
  const notificationsQuery = useNotifications("all", 10)
  const markReadMutation = useMarkNotificationRead()
  const markAllReadMutation = useMarkAllNotificationsRead()
  const canSwitchCompany =
    user?.permissions?.includes("admin.companies.manage") || user?.role === "SUPER_ADMIN"
  const companiesQuery = useQuery({
    queryKey: ["auth", "companies"],
    queryFn: async () => {
      const res = await apiClient.get<CompanyOption[]>("/companies")
      return (res.data ?? []).filter((c) => c.is_active)
    },
    enabled: !!canSwitchCompany,
  })

  const onLogout = async () => {
    try {
      await logoutMutation.mutateAsync()
      router.replace("/login")
    } catch (error) {
      handleError(error, "Logout failed")
    }
  }

  const onCompanyChange = async (companyId: number) => {
    try {
      await switchCompanyMutation.mutateAsync(companyId)
      router.refresh()
    } catch (error) {
      handleError(error, "Failed to switch company")
    }
  }

  const crumbs = useMemo(() => {
    const segments = pathname.split("/").filter(Boolean)
    const build: Array<{ label: string; href: string }> = []
    let current = ""
    for (const part of segments) {
      current += `/${part}`
      const label = part
        .replace(/-/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
      build.push({ label, href: current })
    }
    return build
  }, [pathname])
  const globalSearchSuggestions = useMemo(
    () => ["GRN-", "DO-", "Serial", ...crumbs.map((crumb) => crumb.label)],
    [crumbs]
  )
  const globalSearch = globalSearchState.pathname === pathname ? globalSearchState.value : ""

  const handleGlobalSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const term = globalSearch.trim()
    if (!term) return
    const upper = term.toUpperCase()
    if (upper.startsWith("GRN")) {
      router.push(`/grn?search=${encodeURIComponent(term)}`)
      return
    }
    if (upper.startsWith("DO")) {
      router.push(`/do?search=${encodeURIComponent(term)}`)
      return
    }
    router.push(`/stock/search?serial=${encodeURIComponent(term)}`)
  }

  const submitGlobalSearchFromKeyboard = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    e.currentTarget.form?.requestSubmit()
  }

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setShowProfileMenu(false)
      }
      if (notificationsRef.current && !notificationsRef.current.contains(target)) {
        setShowNotifications(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [])

  return (
    <div className="flex min-h-16 flex-col gap-2 px-4 py-2 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 md:hidden"
            onClick={() => {
              const event = new CustomEvent("wms:toggle-mobile-sidebar")
              window.dispatchEvent(event)
            }}
            title="Open menu"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold">GWU WMS - GWU Software Solutions</h2>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Home</span>
          {crumbs.map((crumb, index) => (
            <span key={crumb.href} className="flex items-center gap-2">
              <span>/</span>
              {index === crumbs.length - 1 ? (
                <span className="font-medium text-foreground">{crumb.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => router.push(crumb.href)}
                  className="hover:text-foreground"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={handleGlobalSearch} className="relative w-full min-w-[220px] md:w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <TypeaheadInput
            value={globalSearch}
            onValueChange={(value) => setGlobalSearchState({ value, pathname })}
            onKeyDown={submitGlobalSearchFromKeyboard}
            suggestions={globalSearchSuggestions}
            placeholder="Search GRN / DO / Serial..."
            className="h-9 pl-8"
            aria-label="Global search"
          />
          <button type="submit" className="sr-only">Search</button>
        </form>
        <Badge variant="outline" className="font-mono text-xs">
          Company: {user?.company_code || "N/A"}
        </Badge>
        {canSwitchCompany && (
          <select
            className="h-9 rounded-md border px-2 text-sm"
            value={user?.company_id || ""}
            onChange={(e) => onCompanyChange(Number(e.target.value))}
            disabled={switchCompanyMutation.isPending || companiesQuery.isLoading}
          >
            {(companiesQuery.data ?? []).map((company) => (
              <option key={company.id} value={company.id}>
                {company.company_code} - {company.company_name}
              </option>
            ))}
          </select>
        )}
        <div ref={notificationsRef} className="relative">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative h-9 w-9"
            onClick={() => setShowNotifications((prev) => !prev)}
            title="Notifications"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
            {!!unreadCountQuery.data && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
                {unreadCountQuery.data > 9 ? "9+" : unreadCountQuery.data}
              </span>
            )}
          </Button>
          {showNotifications && (
            <div className="absolute right-0 z-50 mt-2 w-80 rounded-md border bg-white shadow-lg dark:bg-slate-950">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-sm font-semibold">Notifications</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  onClick={() => markAllReadMutation.mutate()}
                  disabled={!unreadCountQuery.data || markAllReadMutation.isPending}
                >
                  Mark all as read
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notificationsQuery.isLoading && (
                  <p className="px-3 py-4 text-sm text-muted-foreground">Loading...</p>
                )}
                {!notificationsQuery.isLoading && (notificationsQuery.data ?? []).length === 0 && (
                  <p className="px-3 py-4 text-sm text-muted-foreground">No notifications yet</p>
                )}
                {(notificationsQuery.data ?? []).map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      if (!n.read_at) markReadMutation.mutate(n.id)
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted",
                      !n.read_at && "bg-sky-50 dark:bg-sky-950/30"
                    )}
                  >
                    <span className="font-medium">{n.title}</span>
                    {n.body && (
                      <span className="text-xs text-muted-foreground">{n.body}</span>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {formatDistanceToNowStrict(new Date(n.created_at), { addSuffix: true })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div ref={profileMenuRef} className="relative">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[120px] justify-between"
            onClick={() => setShowProfileMenu((prev) => !prev)}
          >
            {user?.full_name || user?.username || "User"}
          </Button>
          {showProfileMenu && (
            <div className="absolute right-0 z-50 mt-2 w-52 rounded-md border bg-white p-1 shadow-lg dark:bg-slate-950">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setTheme(theme === "dark" ? "light" : "dark")
                  setShowProfileMenu(false)
                }}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === "dark" ? "Use light mode" : "Use dark mode"}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                onClick={() => {
                  setShowProfileMenu(false)
                  void onLogout()
                }}
                disabled={logoutMutation.isPending}
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
