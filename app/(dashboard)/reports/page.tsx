"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowUpDown,
  BarChart3,
  CalendarDays,
  Download,
  Eye,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Settings2,
  Star,
  TrendingUp,
  Truck,
} from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { downloadFile } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type StockSummaryRow = {
  client: string
  item: string
  in_stock: number
  reserved: number
  dispatched: number
  total: number
  value: number
}

type MovementRow = {
  date: string
  grn_count: number
  do_count: number
  gate_in: number
  gate_out: number
  items_received: number
  items_dispatched: number
  do_cases: number
  do_pallets: number
  do_weight_kg: number
}

type SlowMovingRow = {
  serial: string
  item: string
  client: string
  age_days: number
  status: string
  value: number
}

type AnalyticsRow = {
  name: string
  stock: number
  billing: number
  grns: number
  dos: number
}

type GateInReportRow = {
  id: number
  gate_in_number: string
  gate_in_datetime: string
  vehicle_number: string
  driver_name?: string
  transport_company?: string
  lr_number?: string
  lr_date?: string
  e_way_bill_number?: string
  e_way_bill_date?: string
  from_location?: string
  to_location?: string
  vehicle_type?: string
  vehicle_model?: string
  transported_by?: string
  vendor_name?: string
  transportation_remarks?: string
  client_name: string
  warehouse_name: string
}

type ReportType = "stock_summary" | "movement" | "gate_in" | "slow_moving" | "client_wise"
type SortDirection = "asc" | "desc"
type ExportFormat = "csv" | "excel" | "pdf"

type SavedView = {
  id: string
  name: string
  reportType: ReportType
  dateFrom: string
  dateTo: string
  clientId: string
  warehouseId: string
  datePreset: string
}

const TODAY = new Date()
const TODAY_ISO = TODAY.toISOString().slice(0, 10)
const THIRTY_DAYS_AGO_ISO = new Date(TODAY.getTime() - 30 * 86400000).toISOString().slice(0, 10)
const STORAGE_KEY = "wmspro.reports.savedViews"

const reportCards: Array<{
  id: ReportType
  title: string
  icon: typeof Package
  desc: string
  category: "Inventory" | "Operations" | "Finance" | "Exception"
  metric: string
}> = [
  { id: "stock_summary", title: "Stock Summary", icon: Package, desc: "Current stock by client and item", category: "Inventory", metric: "Stock value" },
  { id: "movement", title: "Daily Movement", icon: TrendingUp, desc: "GRN, DO, and gate movement trend", category: "Operations", metric: "Inbound vs outbound" },
  { id: "gate_in", title: "Gate In Detail", icon: Truck, desc: "Transporter and route wise gate-in logs", category: "Operations", metric: "Open arrivals" },
  { id: "slow_moving", title: "Slow Moving", icon: AlertCircle, desc: "Items with 60+ days in stock", category: "Exception", metric: "Ageing risk" },
  { id: "client_wise", title: "Client Analysis", icon: BarChart3, desc: "Client-wise stock and billing", category: "Finance", metric: "Client revenue" },
]

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0))
}

function loadSavedViews(): SavedView[] {
  if (typeof window === "undefined") return []
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as SavedView[]
  } catch {
    return []
  }
}

function escapeCsv(value: unknown) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function setDatePreset(preset: string) {
  const today = new Date()
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  if (preset === "today") return { from: iso(today), to: iso(today) }
  if (preset === "yesterday") {
    const y = new Date(today.getTime() - 86400000)
    return { from: iso(y), to: iso(y) }
  }
  if (preset === "last_7") return { from: iso(new Date(today.getTime() - 6 * 86400000)), to: iso(today) }
  if (preset === "last_30") return { from: iso(new Date(today.getTime() - 30 * 86400000)), to: iso(today) }
  if (preset === "this_month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) }
  return null
}

export default function ReportsPage() {
  const [reportType, setReportType] = useState<ReportType>("stock_summary")
  const [datePresetName, setDatePresetName] = useState("last_30")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [clientId, setClientId] = useState("all")
  const [warehouseId, setWarehouseId] = useState("all")
  const [reportSearch, setReportSearch] = useState("")
  const [tableSearch, setTableSearch] = useState("")
  const [sortKey, setSortKey] = useState("")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")
  const [comparePrevious, setComparePrevious] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [showColumnSettings, setShowColumnSettings] = useState(false)
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [applied, setApplied] = useState({ dateFrom, dateTo, clientId: "all", warehouseId: "all" })
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null)

  const clientsQuery = useQuery({
    queryKey: ["clients", "active", includeInactive],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; client_name: string }[]>(includeInactive ? "/clients" : "/clients?is_active=true")
      return res.data ?? []
    },
  })

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active", includeInactive],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; warehouse_name: string }[]>(includeInactive ? "/warehouses" : "/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const stockSummaryQuery = useQuery({
    queryKey: ["reports", "stock-summary", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ mode: "summary", client_id: applied.clientId })
      const res = await apiClient.get<StockSummaryRow[]>(`/reports/stock?${q.toString()}`)
      return res.data ?? []
    },
  })

  const movementQuery = useQuery({
    queryKey: ["reports", "movement", applied],
    queryFn: async () => {
      const q = new URLSearchParams({ date_from: applied.dateFrom, date_to: applied.dateTo })
      const res = await apiClient.get<MovementRow[]>(`/reports/movements?${q.toString()}`)
      return res.data ?? []
    },
  })

  const slowQuery = useQuery({
    queryKey: ["reports", "slow", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ mode: "slow", client_id: applied.clientId })
      const res = await apiClient.get<SlowMovingRow[]>(`/reports/stock?${q.toString()}`)
      return res.data ?? []
    },
  })

  const analyticsQuery = useQuery({
    queryKey: ["reports", "analytics", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ client_id: applied.clientId })
      const res = await apiClient.get<AnalyticsRow[]>(`/reports/analytics?${q.toString()}`)
      return res.data ?? []
    },
  })

  const gateInQuery = useQuery({
    queryKey: ["reports", "gate-in"],
    queryFn: async () => {
      const res = await apiClient.get<GateInReportRow[]>("/gate/in")
      return res.data ?? []
    },
  })

  const stockSummary = useMemo(() => stockSummaryQuery.data ?? [], [stockSummaryQuery.data])
  const movementReport = useMemo(() => movementQuery.data ?? [], [movementQuery.data])
  const slowMoving = useMemo(() => slowQuery.data ?? [], [slowQuery.data])
  const analytics = useMemo(() => analyticsQuery.data ?? [], [analyticsQuery.data])
  const gateInReport = useMemo(() => gateInQuery.data ?? [], [gateInQuery.data])

  const isLoading =
    stockSummaryQuery.isLoading ||
    movementQuery.isLoading ||
    gateInQuery.isLoading ||
    slowQuery.isLoading ||
    analyticsQuery.isLoading

  const kpis = useMemo(() => {
    const totalValue = stockSummary.reduce((sum, row) => sum + Number(row.value || 0), 0)
    const inStock = stockSummary.reduce((sum, row) => sum + Number(row.in_stock || 0), 0)
    const reserved = stockSummary.reduce((sum, row) => sum + Number(row.reserved || 0), 0)
    const dispatched = stockSummary.reduce((sum, row) => sum + Number(row.dispatched || 0), 0)
    const gateIns = gateInReport.length
    return [
      { label: "Total Stock Value", value: formatCurrency(totalValue), tone: "text-blue-700" },
      { label: "In Stock Units", value: inStock.toLocaleString(), tone: "text-emerald-700" },
      { label: "Reserved Units", value: reserved.toLocaleString(), tone: "text-amber-700" },
      { label: "Dispatched Units", value: dispatched.toLocaleString(), tone: "text-sky-700" },
      { label: "Slow Moving SKUs", value: slowMoving.length.toLocaleString(), tone: "text-red-700" },
      { label: "Open Gate Ins", value: gateIns.toLocaleString(), tone: "text-slate-900" },
    ]
  }, [stockSummary, slowMoving.length, gateInReport.length])

  const filteredReports = useMemo(() => {
    const term = reportSearch.trim().toLowerCase()
    return reportCards.filter((report) => !term || `${report.title} ${report.desc} ${report.category}`.toLowerCase().includes(term))
  }, [reportSearch])

  const activeReport = reportCards.find((report) => report.id === reportType) ?? reportCards[0]
  const dateInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo)

  const activeRows = useMemo(() => {
    const term = tableSearch.trim().toLowerCase()
    const filterText = (row: Record<string, unknown>) => !term || Object.values(row).join(" ").toLowerCase().includes(term)
    let rows: Array<Record<string, unknown>> = []
    if (reportType === "stock_summary") rows = stockSummary as unknown as Array<Record<string, unknown>>
    if (reportType === "movement") rows = movementReport as unknown as Array<Record<string, unknown>>
    if (reportType === "gate_in") rows = gateInReport as unknown as Array<Record<string, unknown>>
    if (reportType === "slow_moving") rows = slowMoving as unknown as Array<Record<string, unknown>>
    if (reportType === "client_wise") rows = analytics as unknown as Array<Record<string, unknown>>
    rows = rows.filter(filterText)
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        const an = Number(av)
        const bn = Number(bv)
        const result = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""))
        return sortDirection === "asc" ? result : -result
      })
    }
    return rows
  }, [reportType, stockSummary, movementReport, gateInReport, slowMoving, analytics, tableSearch, sortKey, sortDirection])

  const totalPages = Math.max(1, Math.ceil(activeRows.length / pageSize))
  const boundedPage = Math.min(page, totalPages)
  const rowStart = (boundedPage - 1) * pageSize
  const rowEnd = rowStart + pageSize
  const pagedRows = activeRows.slice(rowStart, rowEnd)

  const columns = useMemo(() => {
    if (reportType === "stock_summary") return ["client", "item", "in_stock", "reserved", "dispatched", "total", "value"]
    if (reportType === "movement") return ["date", "grn_count", "do_count", "gate_in", "gate_out", "items_received", "items_dispatched", "do_cases", "do_pallets", "do_weight_kg"]
    if (reportType === "gate_in") return ["gate_in_number", "vehicle_number", "transport_company", "lr_number", "e_way_bill_number", "from_location", "to_location", "vendor_name"]
    if (reportType === "slow_moving") return ["serial", "item", "client", "age_days", "status", "value"]
    return ["name", "stock", "billing", "grns", "dos"]
  }, [reportType])

  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(column))
  const totals = useMemo(() => {
    const total: Record<string, number> = {}
    for (const column of columns) {
      total[column] = activeRows.reduce((sum, row) => {
        const value = Number(row[column])
        return Number.isFinite(value) ? sum + value : sum
      }, 0)
    }
    return total
  }, [activeRows, columns])

  const chartData = useMemo(() => {
    if (reportType === "stock_summary") return stockSummary.slice(0, 8).map((row) => ({ label: row.item, value: Number(row.value || 0) }))
    if (reportType === "movement") return movementReport.slice().reverse().slice(-8).map((row) => ({ label: row.date.slice(5), value: row.items_received + row.items_dispatched }))
    if (reportType === "slow_moving") return slowMoving.slice(0, 8).map((row) => ({ label: row.item, value: row.age_days }))
    if (reportType === "client_wise") return analytics.slice(0, 8).map((row) => ({ label: row.name, value: Number(row.billing || 0) }))
    return gateInReport.slice(0, 8).map((row) => ({ label: row.gate_in_number, value: 1 }))
  }, [reportType, stockSummary, movementReport, slowMoving, analytics, gateInReport])

  const exportReport = (format: ExportFormat) => {
    const headers = visibleColumns
    const rows = activeRows.map((row) => headers.map((header) => row[header]))
    const csv = [headers, ...rows].map((line) => line.map(escapeCsv).join(",")).join("\n")
    const suffix = format === "excel" ? "xls" : format
    const title = `${activeReport.title} | ${applied.dateFrom} to ${applied.dateTo} | Generated ${new Date().toLocaleString()}`
    const content = format === "pdf" ? `${title}\n\n${csv}` : csv
    downloadFile(new Blob([content], { type: "text/plain;charset=utf-8" }), `${activeReport.id}-${applied.dateFrom}-${applied.dateTo}.${suffix}`)
    toast.success(`${activeReport.title} export started`)
  }

  const saveView = () => {
    const name = `${activeReport.title} - ${new Date().toLocaleDateString()}`
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      reportType,
      dateFrom,
      dateTo,
      clientId,
      warehouseId,
      datePreset: datePresetName,
    }
    const next = [view, ...savedViews].slice(0, 8)
    setSavedViews(next)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    toast.success("Report view saved")
  }

  const applyView = (id: string) => {
    const view = savedViews.find((entry) => entry.id === id)
    if (!view) return
    setReportType(view.reportType)
    setDateFrom(view.dateFrom)
    setDateTo(view.dateTo)
    setClientId(view.clientId)
    setWarehouseId(view.warehouseId)
    setDatePresetName(view.datePreset)
    setApplied({ dateFrom: view.dateFrom, dateTo: view.dateTo, clientId: view.clientId, warehouseId: view.warehouseId })
    setPage(1)
  }

  const applyFilters = () => {
    if (dateInvalid) {
      toast.error("From Date cannot be after To Date")
      return
    }
    setApplied({ dateFrom, dateTo, clientId, warehouseId })
    setLastGeneratedAt(new Date().toLocaleString())
    setPage(1)
  }

  const sortBy = (column: string) => {
    setSortKey(column)
    setSortDirection((current) => (sortKey === column && current === "desc" ? "asc" : "desc"))
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Reports & Analytics</h1>
          <p className="mt-1 text-slate-600">Warehouse performance workbench</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select onValueChange={(value) => exportReport(value as ExportFormat)}>
            <SelectTrigger className="w-44">
              <Download className="h-4 w-4" />
              <SelectValue placeholder={`Export ${activeReport.title}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="excel">Excel</SelectItem>
              <SelectItem value="pdf">PDF</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={saveView}>
            <Star className="h-4 w-4" />
            Save View
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium uppercase text-slate-500">{kpi.label}</p>
              <p className={`mt-2 text-xl font-semibold ${kpi.tone}`}>{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
        <Card className="self-start">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Report Library</CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input className="pl-9" value={reportSearch} onChange={(e) => setReportSearch(e.target.value)} placeholder="Search reports" />
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {filteredReports.map((report) => {
              const Icon = report.icon
              const active = report.id === reportType
              return (
                <button
                  key={report.id}
                  type="button"
                  onClick={() => {
                    setReportType(report.id)
                    setPage(1)
                    setSortKey("")
                  }}
                  className={`w-full rounded-md border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50" : "bg-white hover:bg-slate-50"}`}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-blue-600" />
                    <span className="text-sm font-semibold">{report.title}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="secondary">{report.category}</Badge>
                    <span className="text-xs text-slate-500">{report.metric}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{report.desc}</p>
                </button>
              )
            })}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="grid gap-3 lg:grid-cols-6">
                <div className="space-y-1">
                  <label className="text-sm text-slate-600">Preset</label>
                  <Select
                    value={datePresetName}
                    onValueChange={(value) => {
                      setDatePresetName(value)
                      const range = setDatePreset(value)
                      if (range) {
                        setDateFrom(range.from)
                        setDateTo(range.to)
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="yesterday">Yesterday</SelectItem>
                      <SelectItem value="last_7">Last 7 Days</SelectItem>
                      <SelectItem value="last_30">Last 30 Days</SelectItem>
                      <SelectItem value="this_month">This Month</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-slate-600">From Date</label>
                  <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setDatePresetName("custom") }} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-slate-600">To Date</label>
                  <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setDatePresetName("custom") }} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-slate-600">Client</label>
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
                <div className="space-y-1">
                  <label className="text-sm text-slate-600">Warehouse</label>
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
                <div className="flex items-end">
                  <Button className="w-full bg-blue-600 hover:bg-blue-700" onClick={applyFilters} disabled={dateInvalid}>
                    <RefreshCw className="h-4 w-4" />
                    Generate
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <button type="button" className={comparePrevious ? "font-medium text-blue-700" : ""} onClick={() => setComparePrevious((value) => !value)}>
                  Compare previous period: {comparePrevious ? "On" : "Off"}
                </button>
                <button type="button" className={includeInactive ? "font-medium text-blue-700" : ""} onClick={() => setIncludeInactive((value) => !value)}>
                  Include inactive clients/items: {includeInactive ? "On" : "Off"}
                </button>
                {lastGeneratedAt ? <span>Last generated: {lastGeneratedAt}</span> : null}
                <span>Data freshness: live query</span>
                {dateInvalid ? <span className="font-medium text-red-600">From Date cannot be after To Date</span> : null}
              </div>
            </CardContent>
          </Card>

          {savedViews.length ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <span className="font-medium">Saved views</span>
                {savedViews.map((view) => (
                  <Button key={view.id} variant="outline" size="sm" onClick={() => applyView(view.id)}>
                    {view.name}
                  </Button>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarDays className="h-4 w-4" />
                  {activeReport.title} Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex h-44 items-end gap-2">
                  {chartData.length ? chartData.map((point, index) => {
                    const max = Math.max(...chartData.map((entry) => entry.value), 1)
                    return (
                      <div key={`${point.label}-${index}`} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                        <div className="w-full rounded-t bg-blue-500" style={{ height: `${Math.max(8, (point.value / max) * 150)}px` }} />
                        <span className="w-full truncate text-center text-xs text-slate-500">{point.label}</span>
                      </div>
                    )
                  }) : <EmptyState label="No chart data for current filters" />}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Exceptions & Insights</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Insight label={`${slowMoving.length} SKUs have no movement in 60+ days`} tone={slowMoving.length ? "text-red-700" : "text-emerald-700"} />
                <Insight label={`${stockSummary.filter((row) => Number(row.value || 0) === 0).length} stock rows have zero value`} />
                <Insight label={`${stockSummary.filter((row) => Number(row.in_stock || 0) < 0).length} rows show negative stock`} />
                <Insight label={comparePrevious ? "Previous-period comparison enabled for review" : "Turn on comparison for trend review"} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle className="flex items-center gap-2">
                  <activeReport.icon className="h-5 w-5" />
                  {activeReport.title}
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <Input className="w-64 pl-9" value={tableSearch} onChange={(e) => { setTableSearch(e.target.value); setPage(1) }} placeholder="Search current report" />
                  </div>
                  <Button variant="outline" onClick={() => setShowColumnSettings((value) => !value)}>
                    <Settings2 className="h-4 w-4" />
                    Columns
                  </Button>
                </div>
              </div>
              {showColumnSettings ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {columns.map((column) => (
                    <Button
                      key={column}
                      variant={hiddenColumns.includes(column) ? "outline" : "secondary"}
                      size="sm"
                      onClick={() => setHiddenColumns((current) => current.includes(column) ? current.filter((entry) => entry !== column) : [...current, column])}
                    >
                      {column.replaceAll("_", " ")}
                    </Button>
                  ))}
                </div>
              ) : null}
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : activeRows.length ? (
                <>
                  <div className="mb-3 flex items-center justify-between text-sm text-slate-600">
                    <p>Showing {rowStart + 1}-{Math.min(rowEnd, activeRows.length)} of {activeRows.length}</p>
                    <div className="flex items-center gap-2">
                      <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}>
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">10 rows</SelectItem>
                          <SelectItem value="25">25 rows</SelectItem>
                          <SelectItem value="50">50 rows</SelectItem>
                          <SelectItem value="100">100 rows</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={boundedPage <= 1}>Previous</Button>
                      <span className="text-xs">Page {boundedPage} / {totalPages}</span>
                      <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={boundedPage >= totalPages}>Next</Button>
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        {visibleColumns.map((column) => (
                          <TableHead key={column} className={isNumericColumn(column) ? "text-right" : ""}>
                            <button type="button" className="inline-flex items-center gap-1" onClick={() => sortBy(column)}>
                              {column.replaceAll("_", " ")}
                              <ArrowUpDown className="h-3 w-3" />
                            </button>
                          </TableHead>
                        ))}
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedRows.map((row, index) => (
                        <TableRow key={index}>
                          {visibleColumns.map((column) => (
                            <TableCell key={column} className={isNumericColumn(column) ? "text-right" : ""}>
                              {formatCell(column, row[column])}
                            </TableCell>
                          ))}
                          <TableCell className="text-right">
                            <Button variant="ghost" size="icon-sm" title="Drill down to source records" onClick={() => toast.info("Drill-down view can open the source transaction screen when record IDs are exposed by the report API.")}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-slate-50 font-semibold">
                        {visibleColumns.map((column, index) => (
                          <TableCell key={column} className={isNumericColumn(column) ? "text-right" : ""}>
                            {index === 0 ? "Totals" : Number.isFinite(totals[column]) && totals[column] !== 0 ? formatCell(column, totals[column]) : ""}
                          </TableCell>
                        ))}
                        <TableCell />
                      </TableRow>
                    </TableBody>
                  </Table>
                </>
              ) : (
                <EmptyState label="No rows match the selected filters" />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function isNumericColumn(column: string) {
  return ["in_stock", "reserved", "dispatched", "total", "value", "grn_count", "do_count", "gate_in", "gate_out", "items_received", "items_dispatched", "do_cases", "do_pallets", "do_weight_kg", "age_days", "stock", "billing", "grns", "dos"].includes(column)
}

function formatCell(column: string, value: unknown) {
  if (column === "value" || column === "billing") return formatCurrency(Number(value || 0))
  if (column === "status") return <Badge className="bg-green-100 text-green-800">{String(value || "-")}</Badge>
  if (isNumericColumn(column)) return Number(value || 0).toLocaleString()
  return String(value ?? "-")
}

function Insight({ label, tone = "text-slate-700" }: { label: string; tone?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-slate-50 p-3">
      <AlertCircle className={`mt-0.5 h-4 w-4 ${tone}`} />
      <span className={tone}>{label}</span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed text-sm text-slate-500">
      {label}
    </div>
  )
}
