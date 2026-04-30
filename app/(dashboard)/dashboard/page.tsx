"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Building2,
  Clock,
  Download,
  Eye,
  Loader2,
  PackagePlus,
  PackageSearch,
  PackageX,
  RefreshCw,
  Settings2,
  ShieldAlert,
  TrendingUp,
  Truck,
  Warehouse,
} from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { downloadFile } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

type SummaryResponse = {
  executive: {
    total_warehouses: number
    total_inventory_value: number
    today_grns: number
    today_dos: number
    stock_alerts: number
    capacity_utilization_pct: number
  }
  alerts: Array<{ type: "warning" | "info" | "error"; message: string }>
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
  recent_activity: Array<{ action: string; ref: string; time: string; href?: string }>
  meta?: { inventory_value_source: string; inventory_value_as_of: string }
}

type RangeKey = "today" | "week" | "month" | "custom"
type ViewKey = "operations" | "finance" | "admin" | "client_service"

function inr(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0)
}

function exportSnapshot(data: SummaryResponse | undefined, range: string) {
  if (!data) return
  const payload = {
    range,
    generated_at: new Date().toISOString(),
    executive: data.executive,
    billing_snapshot: data.billing_snapshot,
    alerts: data.alerts,
  }
  downloadFile(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `dashboard-snapshot-${range}.json`)
}

export default function DashboardPage() {
  const [range, setRange] = useState<RangeKey>("today")
  const [customFromInput, setCustomFromInput] = useState("")
  const [customToInput, setCustomToInput] = useState("")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [rangeError, setRangeError] = useState("")
  const [view, setView] = useState<ViewKey>("operations")
  const [warehouseId, setWarehouseId] = useState("all")
  const [clientId, setClientId] = useState("all")
  const [showSettings, setShowSettings] = useState(false)
  const [hiddenWidgets, setHiddenWidgets] = useState<string[]>([])

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

  const clientsQuery = useQuery({
    queryKey: ["clients", "active", "dashboard"],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; client_name: string }[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active", "dashboard"],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; warehouse_name: string }[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const data = summaryQuery.data
  const periodLabel = range === "today" ? "Today" : range === "week" ? "This Week" : range === "month" ? "This Month" : "Selected Range"
  const lastUpdatedLabel = summaryQuery.dataUpdatedAt
    ? new Date(summaryQuery.dataUpdatedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "-"

  const visibleCapacity = useMemo(() => {
    const rows = data?.drilldown.capacity_by_warehouse ?? []
    if (warehouseId === "all") return rows
    return rows.filter((row) => String(row.warehouse_id) === warehouseId)
  }, [data?.drilldown.capacity_by_warehouse, warehouseId])

  const exceptionCount = Number(data?.executive.stock_alerts || 0) + Number(data?.billing_snapshot.overdue_invoices || 0) + visibleCapacity.filter((row) => row.utilization_pct >= 90).length
  const capacitySeverity = Number(data?.executive.capacity_utilization_pct || 0) >= 95 ? "critical" : Number(data?.executive.capacity_utilization_pct || 0) >= 90 ? "warning" : "healthy"

  const stats = [
    {
      id: "warehouses",
      title: "Total Warehouses",
      value: String(data?.executive.total_warehouses ?? 0),
      icon: Warehouse,
      description: "Across active network",
      href: "/admin/warehouses",
      delta: "+0 vs previous period",
      severity: "neutral",
    },
    {
      id: "inventory",
      title: "Inventory Value",
      value: inr(Number(data?.executive.total_inventory_value || 0)),
      icon: TrendingUp,
      description: "Ledger-backed in-stock value",
      href: "/stock/search",
      delta: "Live valuation",
      severity: "healthy",
    },
    {
      id: "grns",
      title: `${periodLabel} GRNs`,
      value: String(data?.executive.today_grns ?? 0),
      icon: PackagePlus,
      description: "Inbound receipts",
      href: "/grn",
      delta: "Tap to review recent GRNs",
      severity: "neutral",
    },
    {
      id: "dos",
      title: `${periodLabel} DOs`,
      value: String(data?.executive.today_dos ?? 0),
      icon: PackageX,
      description: "Outbound orders",
      href: "/do",
      delta: "Tap to review dispatch queue",
      severity: "neutral",
    },
    {
      id: "alerts",
      title: "Stock Alerts",
      value: String(data?.executive.stock_alerts ?? 0),
      icon: AlertCircle,
      description: "Below min stock threshold",
      href: "/stock/search",
      delta: Number(data?.executive.stock_alerts || 0) > 0 ? "Needs attention" : "No active stock alerts",
      severity: Number(data?.executive.stock_alerts || 0) > 0 ? "critical" : "healthy",
    },
    {
      id: "capacity",
      title: "Capacity Utilization",
      value: `${Number(data?.executive.capacity_utilization_pct || 0).toFixed(1)}%`,
      icon: Building2,
      description: "Used capacity across warehouses",
      href: "/admin/zone-layouts",
      delta: capacitySeverity === "critical" ? "Critical threshold" : capacitySeverity === "warning" ? "Warning threshold" : "Healthy",
      severity: capacitySeverity,
    },
  ].filter((stat) => !hiddenWidgets.includes(stat.id))

  const quickActions = [
    { label: "Create GRN", href: "/grn/new", icon: PackagePlus },
    { label: "Create DO", href: "/do/new", icon: PackageX },
    { label: "Gate In", href: "/gate/in", icon: Truck },
    { label: "Stock Search", href: "/stock/search", icon: PackageSearch },
    { label: "Run Report", href: "/reports", icon: BarChart3 },
  ]

  const chartData = useMemo(() => {
    const grn = data?.executive.today_grns ?? 0
    const dos = data?.executive.today_dos ?? 0
    const alerts = data?.executive.stock_alerts ?? 0
    const overdue = data?.billing_snapshot.overdue_invoices ?? 0
    return [
      { label: "GRN", value: grn },
      { label: "DO", value: dos },
      { label: "Alerts", value: alerts },
      { label: "Overdue", value: overdue },
    ]
  }, [data])

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-slate-900">Dashboard</h2>
          <p className="mt-1 text-slate-600">Operations command center</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Last synced: {lastUpdatedLabel}</span>
            <span>Inventory as of: {data?.meta?.inventory_value_as_of || "-"}</span>
            <Badge className={exceptionCount > 0 ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-800"}>
              {exceptionCount} needs attention
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => summaryQuery.refetch()} disabled={summaryQuery.isFetching}>
            {summaryQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button variant="outline" onClick={() => exportSnapshot(data, range)}>
            <Download className="h-4 w-4" />
            Export Snapshot
          </Button>
          <Button variant="outline" onClick={() => setShowSettings((value) => !value)}>
            <Settings2 className="h-4 w-4" />
            Personalize
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_180px]">
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">Date Range</p>
              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
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
                      setRange(item.id as RangeKey)
                      setRangeError("")
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">View</p>
              <Select value={view} onValueChange={(value) => setView(value as ViewKey)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="operations">Operations</SelectItem>
                  <SelectItem value="finance">Finance</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="client_service">Client Service</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">Warehouse</p>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {(warehousesQuery.data ?? []).map((warehouse) => (
                    <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.warehouse_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">Client</p>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  {(clientsQuery.data ?? []).map((client) => (
                    <SelectItem key={client.id} value={String(client.id)}>{client.client_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {range === "custom" ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Input type="date" value={customFromInput} onChange={(e) => setCustomFromInput(e.target.value)} className="h-9 w-[170px]" />
              <Input type="date" value={customToInput} onChange={(e) => setCustomToInput(e.target.value)} className="h-9 w-[170px]" />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (!customFromInput || !customToInput) return setRangeError("Select both From and To dates")
                  if (customFromInput > customToInput) return setRangeError("From date cannot be after To date")
                  setRangeError("")
                  setCustomFrom(customFromInput)
                  setCustomTo(customToInput)
                }}
              >
                Apply
              </Button>
              {rangeError ? <p className="text-xs text-red-600">{rangeError}</p> : null}
            </div>
          ) : null}
          {showSettings ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
              {["warehouses", "inventory", "grns", "dos", "alerts", "capacity"].map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant={hiddenWidgets.includes(id) ? "outline" : "secondary"}
                  onClick={() => setHiddenWidgets((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
                >
                  {hiddenWidgets.includes(id) ? "Show" : "Hide"} {id}
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-2 md:grid-cols-5">
        {quickActions.map((action) => {
          const Icon = action.icon
          return (
            <Button key={action.label} asChild variant="outline" className="h-11 justify-start">
              <Link href={action.href}>
                <Icon className="h-4 w-4" />
                {action.label}
              </Link>
            </Button>
          )
        })}
      </div>

      {summaryQuery.isLoading ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : null}

      {summaryQuery.isError ? (
        <Card className="border-red-200">
          <CardContent className="flex items-center justify-between pt-6 text-sm text-red-700">
            Failed to load dashboard summary.
            <Button variant="outline" size="sm" onClick={() => summaryQuery.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {stats.map((stat) => (
          <KpiCard key={stat.id} stat={stat} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4" />
              {periodLabel} Throughput
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-44 items-end gap-3">
              {chartData.map((point) => {
                const max = Math.max(...chartData.map((entry) => entry.value), 1)
                return (
                  <div key={point.label} className="flex flex-1 flex-col items-center gap-2">
                    <div className="w-full rounded-t bg-blue-600" style={{ height: `${Math.max(8, (point.value / max) * 150)}px` }} />
                    <span className="text-xs text-slate-500">{point.label}</span>
                    <span className="text-xs font-semibold">{point.value}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-red-600" />
              Needs Attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <AttentionRow
              label={`${data?.executive.stock_alerts ?? 0} stock alert(s)`}
              href="/stock/search"
              severity={Number(data?.executive.stock_alerts || 0) > 0 ? "critical" : "healthy"}
            />
            <AttentionRow
              label={`${data?.billing_snapshot.overdue_invoices ?? 0} overdue invoice(s)`}
              href="/finance/invoices"
              severity={Number(data?.billing_snapshot.overdue_invoices || 0) > 0 ? "warning" : "healthy"}
            />
            <AttentionRow
              label={`${visibleCapacity.filter((row) => row.utilization_pct >= 90).length} warehouse capacity warning(s)`}
              href="/admin/zone-layouts"
              severity={visibleCapacity.some((row) => row.utilization_pct >= 95) ? "critical" : visibleCapacity.some((row) => row.utilization_pct >= 90) ? "warning" : "healthy"}
            />
            <AttentionRow label="Integration health available in monitor" href="/integrations" severity="neutral" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Exception Center" icon={AlertCircle}>
          {(data?.alerts ?? []).map((alert, index) => (
            <div key={index} className={`rounded-md border p-3 text-sm ${alert.type === "error" ? "border-red-200 bg-red-50 text-red-800" : alert.type === "warning" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-blue-200 bg-blue-50 text-blue-800"}`}>
              {alert.message}
            </div>
          ))}
        </Panel>

        <Panel title="Recent Activity" icon={Clock}>
          {(data?.recent_activity ?? []).map((activity, index) => (
            <div key={index} className="flex items-center justify-between rounded-md border bg-white p-3 text-sm">
              <div>
                <p className="font-medium">{activity.action}</p>
                {activity.href ? (
                  <Link href={activity.href} className="text-xs font-medium text-blue-600 hover:underline">{activity.ref}</Link>
                ) : (
                  <p className="text-xs text-blue-600">{activity.ref}</p>
                )}
              </div>
              <span className="text-xs text-slate-500">{activity.time}</span>
            </div>
          ))}
          {(data?.recent_activity ?? []).length === 0 ? <EmptyLine text="No recent activity in this range" /> : null}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={`${periodLabel} GRNs`} icon={PackagePlus}>
          {(data?.drilldown.today_grns_recent ?? []).map((row) => <RecordLink key={row.id} href={row.href} primary={row.number} secondary={row.warehouse_name} />)}
          {(data?.drilldown.today_grns_recent ?? []).length === 0 ? <EmptyLine text="No GRNs in this range" /> : null}
        </Panel>
        <Panel title={`${periodLabel} DOs`} icon={PackageX}>
          {(data?.drilldown.today_dos_recent ?? []).map((row) => <RecordLink key={row.id} href={row.href} primary={row.number} secondary={row.warehouse_name} />)}
          {(data?.drilldown.today_dos_recent ?? []).length === 0 ? <EmptyLine text="No DOs in this range" /> : null}
        </Panel>
        <Panel title="Capacity by Warehouse" icon={Building2}>
          {visibleCapacity.map((row) => (
            <div key={row.warehouse_id} className="rounded-md border bg-white p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{row.warehouse_name}</span>
                <Badge className={row.utilization_pct >= 95 ? "bg-red-100 text-red-700" : row.utilization_pct >= 90 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}>
                  {row.utilization_pct.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-2 h-2 rounded-full bg-slate-100">
                <div className={row.utilization_pct >= 95 ? "h-2 rounded-full bg-red-600" : row.utilization_pct >= 90 ? "h-2 rounded-full bg-amber-500" : "h-2 rounded-full bg-emerald-600"} style={{ width: `${Math.min(100, row.utilization_pct)}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <span>{row.used_units}/{row.total_capacity_units} units</span>
                <Link href={row.href} className="font-semibold text-blue-600 hover:underline">Drill down</Link>
              </div>
            </div>
          ))}
        </Panel>
      </div>

      {view === "finance" || view === "admin" ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Billing Snapshot</CardTitle>
              <Link href={data?.billing_snapshot.href || "/finance/billing"} className="text-xs font-semibold text-blue-600 hover:underline">Open Billing</Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-5">
              <BillingMetric label="Invoices" value={String(data?.billing_snapshot.invoice_count ?? 0)} />
              <BillingMetric label="Total Billed" value={inr(Number(data?.billing_snapshot.total_billed || 0))} />
              <BillingMetric label="Paid" value={inr(Number(data?.billing_snapshot.total_paid || 0))} />
              <BillingMetric label="Pending" value={inr(Number(data?.billing_snapshot.total_pending || 0))} />
              <BillingMetric label="Overdue" value={String(data?.billing_snapshot.overdue_invoices ?? 0)} tone="text-red-700" />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function KpiCard({ stat }: { stat: { title: string; value: string; icon: typeof Warehouse; description: string; href: string; delta: string; severity: string } }) {
  const Icon = stat.icon
  const accent = stat.severity === "critical" ? "border-l-red-500" : stat.severity === "warning" ? "border-l-amber-500" : stat.severity === "healthy" ? "border-l-emerald-500" : "border-l-blue-500"
  const badge = stat.severity === "critical" ? "bg-red-100 text-red-700" : stat.severity === "warning" ? "bg-amber-100 text-amber-800" : stat.severity === "healthy" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"

  return (
    <Card className={`border-l-4 ${accent}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">{stat.title}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{stat.value}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-2">
            <Icon className="h-5 w-5 text-blue-600" />
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">{stat.description}</p>
        <div className="mt-3 flex items-center justify-between">
          <Badge className={badge}>{stat.delta}</Badge>
          <Link href={stat.href} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline">
            Open <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

function Panel({ title, icon: Icon, children }: { title: string; icon: typeof AlertCircle; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-blue-600" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  )
}

function AttentionRow({ label, href, severity }: { label: string; href: string; severity: "critical" | "warning" | "healthy" | "neutral" }) {
  const tone = severity === "critical" ? "text-red-700" : severity === "warning" ? "text-amber-800" : severity === "healthy" ? "text-emerald-700" : "text-slate-700"
  return (
    <Link href={href} className="flex items-center justify-between rounded-md border bg-white p-3 text-sm hover:bg-slate-50">
      <span className={tone}>{label}</span>
      <Eye className="h-4 w-4 text-slate-400" />
    </Link>
  )
}

function RecordLink({ href, primary, secondary }: { href: string; primary: string; secondary: string }) {
  return (
    <div className="rounded-md border bg-white p-3">
      <Link href={href} className="text-sm font-medium text-blue-600 hover:underline">{primary}</Link>
      <p className="text-xs text-slate-500">{secondary}</p>
    </div>
  )
}

function BillingMetric({ label, value, tone = "text-slate-900" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border bg-slate-50 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${tone}`}>{value}</p>
    </div>
  )
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed p-3 text-sm text-slate-500">{text}</div>
}
