"use client"

import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowUpDown,
  Download,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Ship,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { useDO, useDOs, useDispatchDO, useReverseDO } from "@/hooks/use-do"
import { useAdminResource } from "@/hooks/use-admin"
import { downloadFile } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { DO_STATUSES, DO_STATUS_LABELS, type DOStatus } from "@/lib/do-status"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DODispatchDialog, type DeliveryOrder } from "@/components/do/DODispatchDialog"

type DOListRow = {
  id: number
  do_number: string
  request_date: string
  created_at: string
  dispatch_date?: string | null
  created_by_name?: string | null
  client_name: string
  warehouse_name: string
  status: DOStatus
  invoice_no?: string | null
  supplier_name?: string | null
  total_items: number
  total_quantity_requested: number
  total_quantity_dispatched: number
}

type SavedView = {
  id: string
  name: string
  status: DOStatus | "all"
  warehouse: string
  client: string
  exception: ExceptionFilter
  from: string
  to: string
  preset: string
}

type ConfirmAction =
  | { type: "cancel"; row: DOListRow }
  | { type: "reverse"; row: DOListRow }
  | null

type ExceptionFilter = "all" | "needs_action" | "old_draft" | "partial" | "zero_dispatch" | "delayed"

const STORAGE_KEY = "wmspro.do.list.savedViews"
const today = new Date()
const TODAY_ISO = today.toISOString().slice(0, 10)
const THIRTY_DAYS_AGO_ISO = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10)

const EXCEPTION_LABELS: Record<Exclude<ExceptionFilter, "all">, string> = {
  needs_action: "Needs Action",
  old_draft: "Old Draft",
  partial: "Partial Dispatch",
  zero_dispatch: "Zero Dispatch",
  delayed: "Delayed",
}

function formatDate(value: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function formatDateTime(value: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

function datePreset(value: string) {
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  if (value === "today") return { from: TODAY_ISO, to: TODAY_ISO }
  if (value === "last_7") return { from: iso(new Date(today.getTime() - 6 * 86400000)), to: TODAY_ISO }
  if (value === "last_30") return { from: THIRTY_DAYS_AGO_ISO, to: TODAY_ISO }
  if (value === "this_month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: TODAY_ISO }
  return null
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

function ageInDays(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000))
}

function fulfillment(row: DOListRow) {
  const requested = Number(row.total_quantity_requested || 0)
  const dispatched = Number(row.total_quantity_dispatched || 0)
  return requested > 0 ? Math.min(100, Math.round((dispatched / requested) * 100)) : 0
}

function exceptionTags(row: DOListRow) {
  const tags: Array<Exclude<ExceptionFilter, "all">> = []
  const percent = fulfillment(row)
  const oldDraft = row.status === "DRAFT" && ageInDays(row.created_at || row.request_date) >= 3
  if (oldDraft) tags.push("old_draft")
  if (row.status === "PARTIALLY_FULFILLED" || (percent > 0 && percent < 100)) tags.push("partial")
  if (row.status !== "CANCELLED" && row.status !== "COMPLETED" && Number(row.total_quantity_dispatched || 0) === 0) tags.push("zero_dispatch")
  if (row.dispatch_date && new Date(row.dispatch_date) < new Date(TODAY_ISO) && row.status !== "COMPLETED" && row.status !== "CANCELLED") tags.push("delayed")
  return tags
}

function rawCell(row: DOListRow, key: keyof DOListRow | "progress" | "exceptions") {
  if (key === "request_date") return formatDate(row.request_date)
  if (key === "created_at") return formatDateTime(row.created_at)
  if (key === "progress") return `${fulfillment(row)}%`
  if (key === "exceptions") return exceptionTags(row).map((tag) => EXCEPTION_LABELS[tag]).join("; ") || "OK"
  return row[key]
}

export default function DOPage() {
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [datePresetName, setDatePresetName] = useState("last_30")
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [statusFilter, setStatusFilter] = useState<DOStatus | "all">("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [clientFilter, setClientFilter] = useState("all")
  const [exceptionFilter, setExceptionFilter] = useState<ExceptionFilter>("all")
  const [sortKey, setSortKey] = useState<keyof DOListRow | "progress" | "exceptions">("created_at")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [showColumns, setShowColumns] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isDispatchOpen, setIsDispatchOpen] = useState(false)

  const listQuery = useDOs({
    page,
    limit,
    search,
    status: statusFilter,
    warehouse_id: warehouseFilter,
    client_id: clientFilter,
    date_from: dateFrom,
    date_to: dateTo,
  })
  const detailsQuery = useDO(selectedId)
  const dispatchMutation = useDispatchDO(selectedId || 0)
  const reverseMutation = useReverseDO()
  const warehousesQuery = useAdminResource("warehouses")
  const clientsQuery = useAdminResource("clients")

  const rows = useMemo(() => (listQuery.data?.data as DOListRow[] | undefined) ?? [], [listQuery.data?.data])
  const pagination = listQuery.data?.pagination
  const total = pagination?.total ?? rows.length
  const totalPages = pagination?.totalPages ?? 1

  const warehouses = (((warehousesQuery.data as Array<{
    id: number
    warehouse_code?: string
    warehouse_name?: string
    is_active?: boolean
  }> | undefined) ?? [])).filter((warehouse) => warehouse.is_active !== false)

  const clients = (((clientsQuery.data as Array<{
    id: number
    client_name?: string
    is_active?: boolean
  }> | undefined) ?? [])).filter((client) => client.is_active !== false)

  const searchSuggestions = useMemo(
    () => rows.flatMap((row) => [row.do_number, row.client_name, row.invoice_no || ""]).filter(Boolean),
    [rows]
  )

  const columns: Array<{ key: keyof DOListRow | "progress" | "exceptions"; label: string; numeric?: boolean; className?: string }> = [
    { key: "do_number", label: "DO Number" },
    { key: "request_date", label: "Request Date" },
    { key: "client_name", label: "Client" },
    { key: "warehouse_name", label: "Warehouse" },
    { key: "invoice_no", label: "Invoice" },
    { key: "created_at", label: "Created On" },
    { key: "created_by_name", label: "Created By" },
    { key: "total_items", label: "Items", numeric: true },
    { key: "total_quantity_requested", label: "Requested", numeric: true },
    { key: "total_quantity_dispatched", label: "Dispatched", numeric: true },
    { key: "progress", label: "Progress" },
    { key: "exceptions", label: "Exceptions" },
    { key: "status", label: "Status" },
  ]
  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(String(column.key)))

  const visibleRows = useMemo(() => {
    return [...rows]
      .filter((row) => {
        if (exceptionFilter === "all") return true
        const tags = exceptionTags(row)
        if (exceptionFilter === "needs_action") return tags.length > 0
        return tags.includes(exceptionFilter)
      })
      .sort((a, b) => {
        const av = rawCell(a, sortKey)
        const bv = rawCell(b, sortKey)
        const an = Number(av)
        const bn = Number(bv)
        const result = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""))
        return sortDir === "asc" ? result : -result
      })
  }, [rows, exceptionFilter, sortDir, sortKey])

  const selectedRows = visibleRows.filter((row) => selectedIds.includes(row.id))
  const selectedDO = useMemo<DeliveryOrder | null>(() => {
    if (!detailsQuery.data?.data) return null
    return detailsQuery.data.data as DeliveryOrder
  }, [detailsQuery.data])

  const counts = useMemo(() => {
    const exceptionCount = rows.filter((row) => exceptionTags(row).length > 0).length
    return {
      total,
      pending: rows.filter((row) => row.status === "PENDING" || row.status === "DRAFT").length,
      picked: rows.filter((row) => row.status === "PICKED").length,
      staged: rows.filter((row) => row.status === "STAGED").length,
      completed: rows.filter((row) => row.status === "COMPLETED").length,
      partial: rows.filter((row) => row.status === "PARTIALLY_FULFILLED").length,
      exceptions: exceptionCount,
    }
  }, [rows, total])

  const totals = visibleRows.reduce(
    (acc, row) => ({
      items: acc.items + Number(row.total_items || 0),
      requested: acc.requested + Number(row.total_quantity_requested || 0),
      dispatched: acc.dispatched + Number(row.total_quantity_dispatched || 0),
    }),
    { items: 0, requested: 0, dispatched: 0 }
  )

  const dateInvalid = dateFrom > dateTo

  const sortBy = (key: keyof DOListRow | "progress" | "exceptions") => {
    setSortKey(key)
    setSortDir((current) => (sortKey === key && current === "desc" ? "asc" : "desc"))
  }

  const applySearch = () => {
    setSearch(searchInput.trim())
    setPage(1)
  }

  const setStatusFromMetric = (status: DOStatus | "all", exception: ExceptionFilter = "all") => {
    setStatusFilter(status)
    setExceptionFilter(exception)
    setPage(1)
  }

  const saveView = () => {
    const view: SavedView = {
      id: crypto.randomUUID(),
      name: `DO ${statusFilter === "all" ? "Workbench" : DO_STATUS_LABELS[statusFilter]} - ${new Date().toLocaleDateString()}`,
      status: statusFilter,
      warehouse: warehouseFilter,
      client: clientFilter,
      exception: exceptionFilter,
      from: dateFrom,
      to: dateTo,
      preset: datePresetName,
    }
    const next = [view, ...savedViews].slice(0, 6)
    setSavedViews(next)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    toast.success("DO view saved")
  }

  const applyView = (id: string) => {
    const view = savedViews.find((item) => item.id === id)
    if (!view) return
    setStatusFilter(view.status)
    setWarehouseFilter(view.warehouse)
    setClientFilter(view.client)
    setExceptionFilter(view.exception)
    setDateFrom(view.from)
    setDateTo(view.to)
    setDatePresetName(view.preset)
    setPage(1)
  }

  const exportRows = (format: "csv" | "excel" | "pdf") => {
    const rowsToExport = selectedRows.length ? selectedRows : visibleRows
    const headers = visibleColumns.map((column) => column.label)
    const lines = rowsToExport.map((row) => visibleColumns.map((column) => rawCell(row, column.key)))
    const csv = [headers, ...lines].map((line) => line.map(escapeCsv).join(",")).join("\n")
    const extension = format === "excel" ? "xls" : format
    const content = format === "pdf"
      ? `Delivery Order Export\n${dateFrom} to ${dateTo}\nGenerated ${new Date().toLocaleString()}\n\n${csv}`
      : csv
    downloadFile(new Blob([content], { type: "text/plain;charset=utf-8" }), `do-export-${dateFrom}-${dateTo}.${extension}`)
    toast.success("Export started")
  }

  const toggleAll = () => {
    const visibleIds = visibleRows.map((row) => row.id)
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
    setSelectedIds(allSelected ? selectedIds.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...selectedIds, ...visibleIds])))
  }

  const openDispatch = (id: number) => {
    setSelectedId(id)
    setIsDispatchOpen(true)
  }

  const handleDispatch = async (data: Parameters<typeof dispatchMutation.mutateAsync>[0]) => {
    if (!selectedId) return
    await dispatchMutation.mutateAsync(data)
    setIsDispatchOpen(false)
    setSelectedId(null)
  }

  const handleConfirmedAction = async () => {
    if (!confirmAction) return
    const reason = window.prompt(confirmAction.type === "cancel" ? "Cancellation reason (optional):" : "Reversal reason (optional):")?.trim()
    await reverseMutation.mutateAsync({
      id: confirmAction.row.id,
      reason: reason || undefined,
    })
    setConfirmAction(null)
  }

  const getStatusBadge = (status: DOStatus) => {
    const classes: Record<DOStatus, string> = {
      DRAFT: "border-blue-200 bg-blue-50 text-blue-800",
      PENDING: "border-cyan-200 bg-cyan-50 text-cyan-800",
      PICKED: "border-indigo-200 bg-indigo-50 text-indigo-800",
      STAGED: "border-violet-200 bg-violet-50 text-violet-800",
      PARTIALLY_FULFILLED: "border-amber-200 bg-amber-50 text-amber-800",
      COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-800",
      CANCELLED: "border-rose-200 bg-rose-50 text-rose-800",
    }
    return <Badge className={classes[status]}>{DO_STATUS_LABELS[status]}</Badge>
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Delivery Orders</h1>
            <p className="mt-1 text-slate-600 dark:text-slate-300">Outbound fulfillment workbench for picking, staging, dispatch, and exceptions</p>
            <p className="mt-1 text-xs text-slate-500">Last refreshed: {lastRefreshed || "Live"} {listQuery.isFetching ? "- refreshing..." : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/do/waves">
                <Ship className="h-4 w-4" />
                Waves
              </Link>
            </Button>
            <Button asChild className="bg-blue-600 hover:bg-blue-700">
              <Link href="/do/new">
                <Plus className="h-4 w-4" />
                Create DO
              </Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <Metric label="Total DOs" value={counts.total} detail={`${visibleRows.length} in current view`} tone="text-blue-700" onClick={() => setStatusFromMetric("all")} />
          <Metric label="Pending" value={counts.pending} detail="Draft + pending" tone="text-amber-700" onClick={() => setStatusFromMetric("all", "zero_dispatch")} />
          <Metric label="Picked" value={counts.picked} detail="Awaiting staging" tone="text-indigo-700" onClick={() => setStatusFromMetric("PICKED")} />
          <Metric label="Staged" value={counts.staged} detail="Ready to dispatch" tone="text-violet-700" onClick={() => setStatusFromMetric("STAGED")} />
          <Metric label="Completed" value={counts.completed} detail="Dispatched" tone="text-emerald-700" onClick={() => setStatusFromMetric("COMPLETED")} />
          <Metric label="Partial" value={counts.partial} detail="Needs review" tone="text-orange-700" onClick={() => setStatusFromMetric("PARTIALLY_FULFILLED")} />
          <Metric label="Exceptions" value={counts.exceptions} detail="Operational risk" tone={counts.exceptions ? "text-red-700" : "text-slate-900"} onClick={() => setStatusFromMetric("all", "needs_action")} />
        </div>

        <div className="rounded-md border bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="grid gap-3 xl:grid-cols-[1fr_170px_170px_180px_180px_170px]">
            <div className="flex gap-2">
              <TypeaheadInput
                value={searchInput}
                onValueChange={setSearchInput}
                suggestions={searchSuggestions}
                onKeyDown={(event) => event.key === "Enter" && applySearch()}
                placeholder="Search DO number, client, or invoice"
              />
              <Button variant="secondary" onClick={applySearch} aria-label="Apply search">
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <Select
              value={datePresetName}
              onValueChange={(value) => {
                setDatePresetName(value)
                const range = datePreset(value)
                if (range) {
                  setDateFrom(range.from)
                  setDateTo(range.to)
                }
                setPage(1)
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="last_7">Last 7 Days</SelectItem>
                <SelectItem value="last_30">Last 30 Days</SelectItem>
                <SelectItem value="this_month">This Month</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value as DOStatus | "all"); setPage(1) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                {DO_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>{DO_STATUS_LABELS[status]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={warehouseFilter} onValueChange={(value) => { setWarehouseFilter(value); setPage(1) }}>
              <SelectTrigger><SelectValue placeholder="All Warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name || warehouse.warehouse_code || `Warehouse ${warehouse.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={clientFilter} onValueChange={(value) => { setClientFilter(value); setPage(1) }}>
              <SelectTrigger><SelectValue placeholder="All Clients" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clients</SelectItem>
                {clients.map((client) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.client_name || `Client ${client.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={exceptionFilter} onValueChange={(value) => setExceptionFilter(value as ExceptionFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Exceptions</SelectItem>
                <SelectItem value="needs_action">Needs Action</SelectItem>
                <SelectItem value="old_draft">Old Draft</SelectItem>
                <SelectItem value="partial">Partial Dispatch</SelectItem>
                <SelectItem value="zero_dispatch">Zero Dispatch</SelectItem>
                <SelectItem value="delayed">Delayed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <Input value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setDatePresetName("custom"); setPage(1) }} type="date" />
            <Input value={dateTo} onChange={(event) => { setDateTo(event.target.value); setDatePresetName("custom"); setPage(1) }} type="date" />
            <Button onClick={applySearch} disabled={dateInvalid} className="bg-blue-600 hover:bg-blue-700">Apply Filters</Button>
          </div>
          {dateInvalid ? <p className="mt-2 text-sm text-red-600">From Date cannot be after To Date.</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { listQuery.refetch(); setLastRefreshed(new Date().toLocaleString()) }}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={saveView}>Save View</Button>
            <Select onValueChange={(value) => exportRows(value as "csv" | "excel" | "pdf")}>
              <SelectTrigger className="h-8 w-40">
                <Download className="h-4 w-4" />
                <SelectValue placeholder="Export" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="excel">Excel</SelectItem>
                <SelectItem value="pdf">PDF</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setShowColumns((value) => !value)}>
              <Settings2 className="h-4 w-4" />
              Columns
            </Button>
            {savedViews.map((view) => (
              <Button key={view.id} variant="ghost" size="sm" onClick={() => applyView(view.id)}>{view.name}</Button>
            ))}
            {selectedIds.length ? <Badge variant="secondary">{selectedIds.length} selected</Badge> : null}
          </div>
          {showColumns ? (
            <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
              {columns.map((column) => (
                <Button
                  key={String(column.key)}
                  variant={hiddenColumns.includes(String(column.key)) ? "outline" : "secondary"}
                  size="sm"
                  onClick={() => setHiddenColumns((current) => current.includes(String(column.key)) ? current.filter((entry) => entry !== String(column.key)) : [...current, String(column.key)])}
                >
                  {column.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {listQuery.error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Failed to load delivery orders: {listQuery.error.message}
          </div>
        ) : null}

        {selectedRows.length ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
            <span>{selectedRows.length} delivery order(s) selected</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => exportRows("csv")}>Export Selected</Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}>Print View</Button>
              <Button variant="outline" size="sm" onClick={() => toast.info("Assign picker can be enabled once picker ownership is added to DO workflow.")}>Assign Picker</Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/do/waves">Create Wave</Link>
              </Button>
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-900">
                  <TableHead className="w-10">
                    <input type="checkbox" checked={visibleRows.length > 0 && visibleRows.every((row) => selectedIds.includes(row.id))} onChange={toggleAll} />
                  </TableHead>
                  {visibleColumns.map((column) => (
                    <TableHead key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                      <button type="button" className="inline-flex items-center gap-1 whitespace-nowrap" onClick={() => sortBy(column.key)}>
                        {column.label}
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="sticky right-0 bg-slate-50 text-right dark:bg-slate-900">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={visibleColumns.length + 2} className="py-12 text-center text-slate-500 dark:text-slate-400">
                      No delivery orders match the current filters
                    </TableCell>
                  </TableRow>
                ) : visibleRows.map((row) => (
                  <TableRow key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(row.id)}
                        onChange={() => setSelectedIds((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])}
                      />
                    </TableCell>
                    {visibleColumns.map((column) => (
                      <TableCell key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                        {renderCell(row, column.key, getStatusBadge)}
                      </TableCell>
                    ))}
                    <TableCell className="sticky right-0 bg-white text-right dark:bg-slate-950">
                      <RowActions
                        row={row}
                        onFulfill={() => openDispatch(row.id)}
                        onCancel={() => setConfirmAction({ type: "cancel", row })}
                        onReverse={() => setConfirmAction({ type: "reverse", row })}
                        isPending={reverseMutation.isPending}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {visibleRows.length ? (
                  <TableRow className="bg-slate-50 font-semibold dark:bg-slate-900">
                    <TableCell />
                    {visibleColumns.map((column, index) => (
                      <TableCell key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                        {index === 0
                          ? "Totals"
                          : column.key === "total_items"
                            ? totals.items.toLocaleString()
                            : column.key === "total_quantity_requested"
                              ? totals.requested.toLocaleString()
                              : column.key === "total_quantity_dispatched"
                                ? totals.dispatched.toLocaleString()
                                : ""}
                      </TableCell>
                    ))}
                    <TableCell className="sticky right-0 bg-slate-50 dark:bg-slate-900" />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-slate-500">
            Page {page} of {totalPages} ({total} records){listQuery.isFetching ? " - refreshing..." : ""}
          </p>
          <div className="flex items-center gap-2">
            <Select value={String(limit)} onValueChange={(value) => { setLimit(Number(value)); setPage(1) }}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 rows</SelectItem>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Previous</Button>
            <Button variant="outline" onClick={() => setPage((current) => current + 1)} disabled={page >= totalPages}>Next</Button>
          </div>
        </div>
      </div>

      <DODispatchDialog
        key={selectedId ?? 0}
        deliveryOrder={selectedDO}
        isOpen={isDispatchOpen}
        onClose={() => {
          setIsDispatchOpen(false)
          setSelectedId(null)
        }}
        onDispatch={handleDispatch}
      />

      <Dialog open={Boolean(confirmAction)} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <DialogTitle>{confirmAction?.type === "cancel" ? "Cancel Delivery Order" : "Reverse Delivery Order"}</DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "cancel"
                ? `Cancel ${confirmAction.row.do_number}? Reserved or dispatched stock will be released back to inventory.`
                : `Reverse ${confirmAction?.row.do_number}? Dispatched stock will be restored and the DO will be cancelled.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>Keep DO</Button>
            <Button variant="destructive" disabled={!confirmAction || reverseMutation.isPending} onClick={handleConfirmedAction}>
              {confirmAction?.type === "cancel" ? "Cancel DO" : "Reverse DO"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Metric({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string
  value: number
  detail: string
  tone: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="rounded-md border bg-white p-4 text-left shadow-sm transition hover:border-blue-300 hover:bg-blue-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900"
      onClick={onClick}
    >
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone}`}>{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </button>
  )
}

function RowActions({
  row,
  onFulfill,
  onCancel,
  onReverse,
  isPending,
}: {
  row: DOListRow
  onFulfill: () => void
  onCancel: () => void
  onReverse: () => void
  isPending: boolean
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button asChild variant="ghost" size="icon-sm" title="Open fulfillment">
        <Link href={`/do/${encodeURIComponent(row.do_number)}/fulfill`}>
          <Eye className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild variant="ghost" size="icon-sm" title="Print dispatch note">
        <a href={`/api/do/${encodeURIComponent(row.do_number)}/download?profile=dispatch_note`} target="_blank" rel="noopener noreferrer">
          <Printer className="h-4 w-4 text-slate-700 dark:text-slate-300" />
        </a>
      </Button>
      <Button asChild variant="ghost" size="icon-sm" title="Print packing slip">
        <a href={`/api/do/${encodeURIComponent(row.do_number)}/download?profile=packing_slip`} target="_blank" rel="noopener noreferrer">
          <FileText className="h-4 w-4 text-indigo-700 dark:text-indigo-300" />
        </a>
      </Button>
      {(row.status === "STAGED" || row.status === "PARTIALLY_FULFILLED") ? (
        <Button variant="ghost" size="icon-sm" className="text-blue-600" title="Record dispatch" onClick={onFulfill}>
          <Package className="h-4 w-4" />
        </Button>
      ) : null}
      {row.status !== "COMPLETED" && row.status !== "CANCELLED" ? (
        <Button variant="ghost" size="icon-sm" className="text-red-600" title="Cancel DO" disabled={isPending} onClick={onCancel}>
          <XCircle className="h-4 w-4" />
        </Button>
      ) : null}
      {row.status === "COMPLETED" ? (
        <Button variant="ghost" size="icon-sm" className="text-red-600" title="Reverse DO" disabled={isPending} onClick={onReverse}>
          <RotateCcw className="h-4 w-4" />
        </Button>
      ) : null}
      <Button variant="ghost" size="icon-sm" title="More actions" onClick={() => toast.info("Timeline, audit log, attachments, and carrier events can open from the fulfillment detail.")}>
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  )
}

function renderCell(
  row: DOListRow,
  key: keyof DOListRow | "progress" | "exceptions",
  statusBadge: (status: DOStatus) => ReactNode
) {
  if (key === "do_number") {
    return (
      <Link href={`/do/${encodeURIComponent(row.do_number)}/fulfill`} className="font-mono font-medium text-blue-700 hover:underline dark:text-blue-300">
        {row.do_number}
      </Link>
    )
  }
  if (key === "request_date") return formatDate(row.request_date)
  if (key === "created_at") return formatDateTime(row.created_at)
  if (key === "invoice_no") return <span className="font-mono text-sm">{row.invoice_no || "-"}</span>
  if (key === "status") return statusBadge(row.status)
  if (key === "progress") {
    const percent = fulfillment(row)
    return (
      <div className="flex min-w-32 items-center gap-2">
        <div className="h-2 flex-1 rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className={`h-2 rounded-full ${percent === 100 ? "bg-emerald-500" : percent > 0 ? "bg-amber-500" : "bg-slate-300"}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="w-9 text-xs text-slate-500">{percent}%</span>
      </div>
    )
  }
  if (key === "exceptions") {
    const tags = exceptionTags(row)
    if (!tags.length) return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">OK</Badge>
    return (
      <div className="flex flex-wrap gap-1">
        {tags.slice(0, 2).map((tag) => (
          <Badge key={tag} className="border-red-200 bg-red-50 text-red-700">{EXCEPTION_LABELS[tag]}</Badge>
        ))}
        {tags.length > 2 ? <Badge variant="secondary">+{tags.length - 2}</Badge> : null}
      </div>
    )
  }
  if (key === "total_items" || key === "total_quantity_requested" || key === "total_quantity_dispatched") {
    return Number(row[key] || 0).toLocaleString()
  }
  return String(row[key] ?? "-")
}
