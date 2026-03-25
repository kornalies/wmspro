"use client"

import Link from "next/link"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, Building2, Clock, Info, Package, PackagePlus, PackageX, TrendingUp, Warehouse } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { apiClient } from "@/lib/api-client"

type SummaryResponse = {
  executive: {
    total_warehouses: number
    total_inventory_value: number
    today_grns: number
    today_dos: number
    stock_alerts: number
    capacity_utilization_pct: number
  }
  alerts: Array<{
    type: "warning" | "info" | "error"
    message: string
  }>
  drilldown: {
    today_grns_recent: Array<{ id: number; number: string; warehouse_name: string; href: string }>
    today_dos_recent: Array<{ id: number; number: string; warehouse_name: string; href: string }>
    capacity_by_warehouse: Array<{
      warehouse_id: number
      warehouse_name: string
      used_units: number
      total_capacity_units: number
      utilization_pct: number
      href: string
    }>
  }
  billing_snapshot: {
    total_billed: number
    total_paid: number
    total_pending: number
    overdue_invoices: number
    invoice_count: number
    href: string
  }
  recent_activity: Array<{
    action: string
    ref: string
    time: string
    href?: string
  }>
}

export default function DashboardPage() {
  const [range, setRange] = useState<"today" | "week" | "month" | "custom">("today")
  const [customFromInput, setCustomFromInput] = useState("")
  const [customToInput, setCustomToInput] = useState("")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [rangeError, setRangeError] = useState("")

  const summaryQuery = useQuery({
    queryKey: ["dashboard", "summary", range, customFrom, customTo],
    queryFn: async () => {
      const params = new URLSearchParams({ range })
      if (range === "custom" && customFrom && customTo) {
        params.set("from", customFrom)
        params.set("to", customTo)
      }
      const res = await apiClient.get<SummaryResponse>(`/dashboard/summary?${params.toString()}`)
      return res.data
    },
  })

  const periodLabel =
    range === "today"
      ? "Today"
      : range === "week"
        ? "This Week"
        : range === "month"
          ? "This Month"
          : "Selected Range"

  const lastUpdatedLabel = summaryQuery.dataUpdatedAt
    ? new Date(summaryQuery.dataUpdatedAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-"

  const stats = [
    {
      title: "Total Warehouses",
      value: String(summaryQuery.data?.executive.total_warehouses ?? 0),
      icon: Warehouse,
      description: "Across active network",
      href: "/admin/warehouses",
      bgColor: "bg-gradient-to-br from-blue-400 to-blue-500",
      iconColor: "text-blue-100",
    },
    {
      title: "Inventory Value",
      value: `INR ${(summaryQuery.data?.executive.total_inventory_value ?? 0).toLocaleString("en-IN")}`,
      icon: TrendingUp,
      description: "Total in-stock value",
      href: "/stock/search",
      bgColor: "bg-gradient-to-br from-green-400 to-green-500",
      iconColor: "text-green-100",
    },
    {
      title: "Today's GRNs",
      value: String(summaryQuery.data?.executive.today_grns ?? 0),
      icon: PackagePlus,
      description: `Inbound received (${periodLabel.toLowerCase()})`,
      href: "/grn",
      bgColor: "bg-gradient-to-br from-orange-400 to-orange-500",
      iconColor: "text-orange-100",
    },
    {
      title: "Today's DOs",
      value: String(summaryQuery.data?.executive.today_dos ?? 0),
      icon: PackageX,
      description: `Outbound orders (${periodLabel.toLowerCase()})`,
      href: "/do",
      bgColor: "bg-gradient-to-br from-purple-400 to-purple-500",
      iconColor: "text-purple-100",
    },
    {
      title: "Stock Alerts",
      value: String(summaryQuery.data?.executive.stock_alerts ?? 0),
      icon: AlertCircle,
      description: "Below min stock threshold",
      href: "/stock/search",
      bgColor: "bg-gradient-to-br from-red-500 to-red-600",
      iconColor: "text-red-100",
    },
    {
      title: "Capacity Utilization",
      value: `${(summaryQuery.data?.executive.capacity_utilization_pct ?? 0).toFixed(1)}%`,
      icon: Building2,
      description: "Used capacity across warehouses",
      href: "/admin/zone-layouts",
      bgColor: "bg-gradient-to-br from-cyan-400 to-cyan-500",
      iconColor: "text-cyan-100",
    },
  ]

  const alerts = summaryQuery.data?.alerts ?? []
  const recentActivity = summaryQuery.data?.recent_activity ?? []

  const quickActions = [
    { label: "90-min Onboarding", href: "/admin/onboarding" },
    { label: "Create GRN", href: "/grn/new" },
    { label: "Process DO", href: "/do" },
    { label: "Gate In", href: "/gate/in" },
    { label: "View Reports", href: "/finance/billing" },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Dashboard</h2>
        <p className="mt-1 text-gray-500">Welcome to your warehouse management system</p>
        <p className="mt-1 text-xs text-gray-500">Last updated: {lastUpdatedLabel}</p>
        <div className="mt-4 inline-flex rounded-lg border bg-white p-1">
          {[
            { id: "today", label: "Today" },
            { id: "week", label: "Week" },
            { id: "month", label: "Month" },
            { id: "custom", label: "Custom" },
          ].map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={range === item.id ? "default" : "ghost"}
              className="h-8 px-4"
              onClick={() => {
                setRange(item.id as "today" | "week" | "month" | "custom")
                setRangeError("")
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {range === "custom" && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <p className="mb-1 text-xs text-gray-500">From</p>
              <Input
                type="date"
                value={customFromInput}
                onChange={(e) => setCustomFromInput(e.target.value)}
                className="h-9 w-[170px]"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-gray-500">To</p>
              <Input
                type="date"
                value={customToInput}
                onChange={(e) => setCustomToInput(e.target.value)}
                className="h-9 w-[170px]"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!customFromInput || !customToInput) {
                  setRangeError("Select both From and To dates")
                  return
                }
                if (customFromInput > customToInput) {
                  setRangeError("From date cannot be after To date")
                  return
                }
                setRangeError("")
                setCustomFrom(customFromInput)
                setCustomTo(customToInput)
              }}
            >
              Apply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setCustomFromInput("")
                setCustomToInput("")
                setCustomFrom("")
                setCustomTo("")
                setRangeError("")
                setRange("today")
              }}
            >
              Clear
            </Button>
            {rangeError && <p className="text-xs text-red-600">{rangeError}</p>}
          </div>
        )}
      </div>

      {summaryQuery.isLoading && (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      )}

      {summaryQuery.isError && (
        <Card className="border-red-200">
          <CardContent className="pt-6 text-sm text-red-700">
            Failed to load dashboard summary. Please refresh.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => (
          <Card
            key={stat.title}
            className="overflow-hidden border-none shadow-lg transition-shadow hover:shadow-xl"
          >
            <div className={`${stat.bgColor} p-6`}>
              <div className="mb-4 flex items-center justify-between">
                <CardTitle className="flex items-center gap-1 text-sm font-medium text-white">
                  {stat.title}
                  <span
                    title={stat.description}
                    className="inline-flex cursor-help items-center rounded p-0.5 hover:bg-white/20"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </CardTitle>
                <stat.icon className={`h-8 w-8 ${stat.iconColor}`} />
              </div>
              <div className="mb-2 text-3xl font-bold text-white">{stat.value}</div>
              <p className={`text-xs ${stat.iconColor}`}>{stat.description}</p>
              <Link href={stat.href} className={`mt-3 inline-block text-xs font-semibold ${stat.iconColor} underline`}>
                Drill down
              </Link>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-lg">
          <CardHeader className="bg-gradient-to-r from-red-50 to-orange-50">
            <CardTitle className="flex items-center gap-2 text-lg">
              <AlertCircle className="h-5 w-5 text-red-600" />
              Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {alerts.map((alert, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 rounded-lg border-l-4 border-yellow-500 bg-gray-50 p-4 hover:bg-gray-100"
                >
                  {alert.type === "warning" && (
                    <AlertCircle className="mt-0.5 h-5 w-5 text-yellow-600" />
                  )}
                  {alert.type === "info" && <Package className="mt-0.5 h-5 w-5 text-blue-600" />}
                  {alert.type === "error" && <Clock className="mt-0.5 h-5 w-5 text-red-600" />}
                  <p className="text-sm font-medium text-gray-900">{alert.message}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-lg">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5 text-blue-600" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {recentActivity.map((activity, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg bg-gray-50 p-3 hover:bg-gray-100"
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{activity.action}</p>
                    {activity.href ? (
                      <Link href={activity.href} className="mt-1 block text-xs font-medium text-blue-600 hover:underline">
                        {activity.ref}
                      </Link>
                    ) : (
                      <p className="mt-1 text-xs font-medium text-blue-600">{activity.ref}</p>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{activity.time}</div>
                </div>
              ))}
              {recentActivity.length === 0 && (
                <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">No recent activity</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="shadow-lg md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">{periodLabel} GRNs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(summaryQuery.data?.drilldown.today_grns_recent ?? []).map((row) => (
              <div key={row.id} className="rounded bg-gray-50 p-3">
                <Link href={row.href} className="text-sm font-medium text-blue-600 hover:underline">
                  {row.number}
                </Link>
                <p className="text-xs text-gray-500">{row.warehouse_name}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-lg md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">{periodLabel} DOs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(summaryQuery.data?.drilldown.today_dos_recent ?? []).map((row) => (
              <div key={row.id} className="rounded bg-gray-50 p-3">
                <Link href={row.href} className="text-sm font-medium text-blue-600 hover:underline">
                  {row.number}
                </Link>
                <p className="text-xs text-gray-500">{row.warehouse_name}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-lg md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Capacity by Warehouse</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(summaryQuery.data?.drilldown.capacity_by_warehouse ?? []).map((row) => (
              <div key={row.warehouse_id} className="rounded bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{row.warehouse_name}</p>
                  <p className="text-sm font-semibold">{row.utilization_pct.toFixed(1)}%</p>
                </div>
                <p className="text-xs text-gray-500">
                  {row.used_units}/{row.total_capacity_units} units
                </p>
                <Link href={row.href} className="mt-1 inline-block text-xs font-semibold text-blue-600 hover:underline">
                  Drill down
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-lg">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Billing Snapshot</CardTitle>
            <Link
              href={summaryQuery.data?.billing_snapshot.href || "/finance/billing"}
              className="text-xs font-semibold text-blue-600 hover:underline"
            >
              Open Billing
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-5">
            <div className="rounded-md bg-blue-50 p-4" title={`Invoices generated in ${periodLabel.toLowerCase()}`}>
              <p className="text-xs text-gray-600">Invoices</p>
              <p className="text-xl font-bold text-blue-700">
                {summaryQuery.data?.billing_snapshot.invoice_count ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-emerald-50 p-4" title={`Total billed amount in ${periodLabel.toLowerCase()}`}>
              <p className="text-xs text-gray-600">Total Billed</p>
              <p className="text-xl font-bold text-emerald-700">
                INR {(summaryQuery.data?.billing_snapshot.total_billed ?? 0).toLocaleString("en-IN")}
              </p>
            </div>
            <div className="rounded-md bg-lime-50 p-4" title="Amount already paid by customers">
              <p className="text-xs text-gray-600">Paid</p>
              <p className="text-xl font-bold text-lime-700">
                INR {(summaryQuery.data?.billing_snapshot.total_paid ?? 0).toLocaleString("en-IN")}
              </p>
            </div>
            <div className="rounded-md bg-amber-50 p-4" title="Open receivables pending payment">
              <p className="text-xs text-gray-600">Pending</p>
              <p className="text-xl font-bold text-amber-700">
                INR {(summaryQuery.data?.billing_snapshot.total_pending ?? 0).toLocaleString("en-IN")}
              </p>
            </div>
            <div className="rounded-md bg-rose-50 p-4" title="Invoices with due date already crossed">
              <p className="text-xs text-gray-600">Overdue</p>
              <p className="text-xl font-bold text-rose-700">
                {summaryQuery.data?.billing_snapshot.overdue_invoices ?? 0}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Personalization (Coming Soon)</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600">
          Personalized widgets, saved dashboard layouts, and role-wise default views will be added in next phase.
        </CardContent>
      </Card>

      <Card className="overflow-hidden shadow-lg">
        <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 p-6">
          <h3 className="mb-4 text-lg font-semibold text-white">Quick Actions</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {quickActions.map((action) => (
              <Button
                key={action.label}
                asChild
                variant="ghost"
                className="h-auto rounded-lg bg-white/20 px-4 py-3 font-medium text-white transition-all hover:scale-105 hover:bg-white/30"
              >
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
