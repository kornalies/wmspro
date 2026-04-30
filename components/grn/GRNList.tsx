"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  Smartphone,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { useCancelGRN, useConfirmDraftGRN, useGRNs } from "@/hooks/use-grn"
import { useAdminResource } from "@/hooks/use-admin"
import { downloadFile } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type GrnRow = {
  id: number
  grn_number: string
  grn_date: string
  client_name: string
  warehouse_name: string
  invoice_number: string
  total_items: number
  total_quantity: number
  total_value?: number
  status: string
  created_at: string
  created_by_name?: string | null
  supplier_name?: string | null
  supplier_gst?: string | null
  source_channel?: string | null
  invoice_quantity?: number | null
  received_quantity?: number | null
  damage_quantity?: number | null
}

type SavedView = {
  id: string
  name: string
  status: string
  warehouse: string
  client: string
  source: string
  from: string
  to: string
  preset: string
}

const STORAGE_KEY = "wmspro.grn.list.savedViews"
const TODAY = new Date()
const TODAY_ISO = TODAY.toISOString().slice(0, 10)
const THIRTY_DAYS_AGO_ISO = new Date(TODAY.getTime() - 30 * 86400000).toISOString().slice(0, 10)

function formatDate(dateStr: string): string {
  if (!dateStr) return "-"
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function formatDateTime(dateStr: string): string {
  if (!dateStr) return "-"
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
}

function loadSavedViews(): SavedView[] {
  if (typeof window === "undefined") return []
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as SavedView[]
  } catch {
    return []
  }
}

function datePreset(value: string) {
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  if (value === "today") return { from: TODAY_ISO, to: TODAY_ISO }
  if (value === "last_7") return { from: iso(new Date(TODAY.getTime() - 6 * 86400000)), to: TODAY_ISO }
  if (value === "last_30") return { from: THIRTY_DAYS_AGO_ISO, to: TODAY_ISO }
  if (value === "this_month") return { from: iso(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1)), to: TODAY_ISO }
  return null
}

function escapeCsv(value: unknown) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function sourceLabel(value?: string | null) {
  const source = String(value || "WEB_MANUAL").toUpperCase()
  if (source.includes("OCR")) return "OCR"
  if (source.includes("MOBILE")) return "MOBILE"
  return "WEB"
}

function hasVariance(row: GrnRow) {
  const invoice = Number(row.invoice_quantity ?? 0)
  const received = Number(row.received_quantity ?? row.total_quantity ?? 0)
  const damaged = Number(row.damage_quantity ?? 0)
  return damaged > 0 || (invoice > 0 && received > 0 && invoice !== received)
}

export function GRNList() {
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [search, setSearch] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [datePresetName, setDatePresetName] = useState("last_30")
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [statusFilter, setStatusFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [clientFilter, setClientFilter] = useState("all")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [supplierSearch, setSupplierSearch] = useState("")
  const [sortKey, setSortKey] = useState<keyof GrnRow | "variance">("created_at")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [showColumns, setShowColumns] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [confirmTarget, setConfirmTarget] = useState<GrnRow | null>(null)
  const [cancelTarget, setCancelTarget] = useState<GrnRow | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)

  const { data, isLoading, error, isFetching, refetch } = useGRNs({
    page,
    limit,
    status: statusFilter,
    search,
    warehouse_id: warehouseFilter,
    client_id: clientFilter,
    date_from: dateFrom,
    date_to: dateTo,
  })
  const warehousesQuery = useAdminResource("warehouses")
  const clientsQuery = useAdminResource("clients")
  const cancelMutation = useCancelGRN()
  const confirmDraftMutation = useConfirmDraftGRN()

  const rows = useMemo(() => data?.data ?? [], [data?.data])
  const pagination = data?.pagination
  const total = pagination?.total ?? rows.length
  const totalPages = pagination?.totalPages ?? 1
  const warehouses = (((warehousesQuery.data as Array<{ id: number; warehouse_code?: string; warehouse_name?: string; is_active?: boolean }> | undefined) ?? [])).filter((warehouse) => warehouse.is_active !== false)
  const clients = (((clientsQuery.data as Array<{ id: number; client_name?: string; is_active?: boolean }> | undefined) ?? [])).filter((client) => client.is_active !== false)

  const visibleRows = useMemo(() => {
    const supplierTerm = supplierSearch.trim().toLowerCase()
    return [...rows]
      .filter((row) => sourceFilter === "all" || sourceLabel(row.source_channel) === sourceFilter)
      .filter((row) => !supplierTerm || `${row.supplier_name ?? ""} ${row.supplier_gst ?? ""}`.toLowerCase().includes(supplierTerm))
      .sort((a, b) => {
        const av = sortKey === "variance" ? Number(hasVariance(a)) : a[sortKey]
        const bv = sortKey === "variance" ? Number(hasVariance(b)) : b[sortKey]
        const an = Number(av)
        const bn = Number(bv)
        const result = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""))
        return sortDir === "asc" ? result : -result
      })
  }, [rows, sourceFilter, supplierSearch, sortKey, sortDir])

  const selectedRows = visibleRows.filter((row) => selectedIds.includes(row.id))
  const counts = useMemo(() => {
    const confirmed = rows.filter((grn) => grn.status === "CONFIRMED" || grn.status === "COMPLETED").length
    const draft = rows.filter((grn) => grn.status === "DRAFT").length
    const cancelled = rows.filter((grn) => grn.status === "CANCELLED").length
    const variance = rows.filter(hasVariance).length
    return { total, confirmed, draft, cancelled, variance }
  }, [rows, total])

  const columns: Array<{ key: keyof GrnRow | "source" | "variance"; label: string; numeric?: boolean }> = [
    { key: "grn_number", label: "GRN Number" },
    { key: "grn_date", label: "Date" },
    { key: "client_name", label: "Client" },
    { key: "warehouse_name", label: "Warehouse" },
    { key: "invoice_number", label: "Invoice No." },
    { key: "supplier_name", label: "Supplier" },
    { key: "created_at", label: "Created On" },
    { key: "created_by_name", label: "Created By" },
    { key: "total_items", label: "Items", numeric: true },
    { key: "total_quantity", label: "Quantity", numeric: true },
    { key: "source", label: "Source" },
    { key: "variance", label: "Variance" },
    { key: "status", label: "Status" },
  ]
  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(String(column.key)))

  const totals = visibleRows.reduce(
    (acc, row) => ({ items: acc.items + Number(row.total_items || 0), quantity: acc.quantity + Number(row.total_quantity || 0) }),
    { items: 0, quantity: 0 }
  )

  const dateInvalid = dateFrom > dateTo
  const duplicateInvoices = useMemo(() => {
    const seen = new Map<string, number>()
    for (const row of rows) {
      const key = `${row.client_name}|${row.supplier_gst || row.supplier_name || ""}|${row.invoice_number}`.toLowerCase()
      seen.set(key, (seen.get(key) || 0) + 1)
    }
    return Array.from(seen.values()).filter((count) => count > 1).length
  }, [rows])

  const sortBy = (key: keyof GrnRow | "variance") => {
    setSortKey(key)
    setSortDir((current) => (sortKey === key && current === "desc" ? "asc" : "desc"))
  }

  const applySearch = () => {
    setSearch(searchInput.trim())
    setPage(1)
  }

  const saveView = () => {
    const view: SavedView = {
      id: crypto.randomUUID(),
      name: `GRN ${statusFilter === "all" ? "Workbench" : statusFilter} - ${new Date().toLocaleDateString()}`,
      status: statusFilter,
      warehouse: warehouseFilter,
      client: clientFilter,
      source: sourceFilter,
      from: dateFrom,
      to: dateTo,
      preset: datePresetName,
    }
    const next = [view, ...savedViews].slice(0, 6)
    setSavedViews(next)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    toast.success("GRN view saved")
  }

  const applyView = (id: string) => {
    const view = savedViews.find((item) => item.id === id)
    if (!view) return
    setStatusFilter(view.status)
    setWarehouseFilter(view.warehouse)
    setClientFilter(view.client)
    setSourceFilter(view.source)
    setDateFrom(view.from)
    setDateTo(view.to)
    setDatePresetName(view.preset)
    setPage(1)
  }

  const exportRows = (format: "csv" | "excel" | "pdf") => {
    const rowsToExport = selectedRows.length ? selectedRows : visibleRows
    const headers = visibleColumns.map((column) => column.label)
    const lines = rowsToExport.map((row) => visibleColumns.map((column) => renderRawCell(row, column.key)))
    const csv = [headers, ...lines].map((line) => line.map(escapeCsv).join(",")).join("\n")
    const extension = format === "excel" ? "xls" : format
    const content = format === "pdf" ? `GRN Export\n${dateFrom} to ${dateTo}\nGenerated ${new Date().toLocaleString()}\n\n${csv}` : csv
    downloadFile(new Blob([content], { type: "text/plain;charset=utf-8" }), `grn-export-${dateFrom}-${dateTo}.${extension}`)
    toast.success("Export started")
  }

  const toggleAll = () => {
    const visibleIds = visibleRows.map((row) => row.id)
    const allSelected = visibleIds.every((id) => selectedIds.includes(id))
    setSelectedIds(allSelected ? selectedIds.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...selectedIds, ...visibleIds])))
  }

  const getStatusBadge = (status: string) => {
    const normalized = status === "COMPLETED" ? "CONFIRMED" : status
    const classes: Record<string, string> = {
      CONFIRMED: "bg-green-100 text-green-800 border-green-200",
      DRAFT: "bg-amber-100 text-amber-800 border-amber-200",
      CANCELLED: "bg-red-100 text-red-800 border-red-200",
      PENDING_APPROVAL: "bg-blue-100 text-blue-800 border-blue-200",
    }
    return <Badge className={classes[normalized] || "bg-gray-100 text-gray-800 border-gray-200"}>{normalized}</Badge>
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">GRN Operations</h1>
          <p className="mt-1 text-slate-600">Lifecycle workbench for incoming goods receipts</p>
          <p className="mt-1 text-xs text-slate-500">Last refreshed: {lastRefreshed || "Live"} {isFetching ? "- refreshing..." : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link href="/grn/mobile-approvals"><Smartphone className="h-4 w-4" /> Mobile Approval</Link></Button>
          <Button asChild variant="outline"><Link href="/grn/new?mode=scan"><Upload className="h-4 w-4" /> Scan Invoice</Link></Button>
          <Button asChild className="bg-blue-600 hover:bg-blue-700"><Link href="/grn/new?mode=manual">Create GRN</Link></Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Total GRNs" value={counts.total} tone="text-blue-700" />
        <Metric label="Confirmed" value={counts.confirmed} tone="text-emerald-700" />
        <Metric label="Draft" value={counts.draft} tone="text-amber-700" />
        <Metric label="Cancelled" value={counts.cancelled} tone="text-red-700" />
        <Metric label="Variance / QC" value={counts.variance} tone={counts.variance ? "text-red-700" : "text-emerald-700"} />
        <Metric label="Duplicate Invoice Risk" value={duplicateInvoices} tone={duplicateInvoices ? "text-red-700" : "text-slate-900"} />
      </div>

      <div className="rounded-md border bg-white p-4 shadow-sm">
        <div className="grid gap-3 xl:grid-cols-[1fr_170px_170px_180px_180px_160px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && applySearch()}
              className="pl-9"
              placeholder="Search GRN, invoice, client"
            />
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
          <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(1) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="CONFIRMED">Confirmed</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={warehouseFilter} onValueChange={(value) => { setWarehouseFilter(value); setPage(1) }}>
            <SelectTrigger><SelectValue placeholder="All Warehouses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Warehouses</SelectItem>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.warehouse_name || warehouse.warehouse_code || `Warehouse ${warehouse.id}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={clientFilter} onValueChange={(value) => { setClientFilter(value); setPage(1) }}>
            <SelectTrigger><SelectValue placeholder="All Clients" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={String(client.id)}>{client.client_name || `Client ${client.id}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={applySearch} disabled={dateInvalid} className="bg-blue-600 hover:bg-blue-700">
            Apply Filters
          </Button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[160px_1fr_1fr_auto]">
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              <SelectItem value="WEB">Web</SelectItem>
              <SelectItem value="MOBILE">Mobile</SelectItem>
              <SelectItem value="OCR">OCR</SelectItem>
            </SelectContent>
          </Select>
          <Input value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setDatePresetName("custom") }} type="date" />
          <Input value={dateTo} onChange={(event) => { setDateTo(event.target.value); setDatePresetName("custom") }} type="date" />
          <Input value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} placeholder="Supplier / GST filter" />
        </div>
        {dateInvalid ? <p className="mt-2 text-sm text-red-600">From Date cannot be after To Date.</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { refetch(); setLastRefreshed(new Date().toLocaleString()) }}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          <Button variant="outline" size="sm" onClick={saveView}>Save View</Button>
          <Select onValueChange={(value) => exportRows(value as "csv" | "excel" | "pdf")}>
            <SelectTrigger className="h-8 w-40"><Download className="h-4 w-4" /><SelectValue placeholder="Export" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="excel">Excel</SelectItem>
              <SelectItem value="pdf">PDF</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setShowColumns((value) => !value)}><Settings2 className="h-4 w-4" /> Columns</Button>
          {selectedIds.length ? <Badge variant="secondary">{selectedIds.length} selected</Badge> : null}
          {savedViews.map((view) => (
            <Button key={view.id} variant="ghost" size="sm" onClick={() => applyView(view.id)}>{view.name}</Button>
          ))}
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

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Failed to load GRNs: {error.message}</div>
      ) : null}

      {selectedRows.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-slate-50 p-3 text-sm">
          <span>{selectedRows.length} GRN(s) selected</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => exportRows("csv")}>Export Selected</Button>
            <Button variant="outline" size="sm" onClick={() => toast.info("Bulk print can be wired to a combined PDF once print API supports multiple GRNs.")}>Print Selected</Button>
            <Button variant="outline" size="sm" onClick={() => selectedRows.find((row) => row.status === "DRAFT") ? setConfirmTarget(selectedRows.find((row) => row.status === "DRAFT") ?? null) : toast.info("No draft GRNs selected")}>Confirm Draft</Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="w-10"><input type="checkbox" checked={visibleRows.length > 0 && visibleRows.every((row) => selectedIds.includes(row.id))} onChange={toggleAll} /></TableHead>
                {visibleColumns.map((column) => (
                  <TableHead key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => column.key !== "source" && sortBy(column.key === "variance" ? "variance" : column.key as keyof GrnRow)}>
                      {column.label}
                      {column.key !== "source" ? <ArrowUpDown className="h-3 w-3" /> : null}
                    </button>
                  </TableHead>
                ))}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.length === 0 ? (
                <TableRow><TableCell colSpan={visibleColumns.length + 2} className="py-12 text-center text-muted-foreground">No GRNs match the current filters</TableCell></TableRow>
              ) : visibleRows.map((grn) => (
                <TableRow key={grn.id} className="cursor-pointer hover:bg-slate-50" onClick={() => window.location.assign(`/grn/${grn.id}`)}>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(grn.id)}
                      onChange={() => setSelectedIds((current) => current.includes(grn.id) ? current.filter((id) => id !== grn.id) : [...current, grn.id])}
                    />
                  </TableCell>
                  {visibleColumns.map((column) => (
                    <TableCell key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                      {renderCell(grn, column.key, getStatusBadge)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="icon-sm" title="View GRN"><Link href={`/grn/${grn.id}`}><Eye className="h-4 w-4" /></Link></Button>
                      <Button asChild variant="ghost" size="icon-sm" title="Print GRN"><Link href={`/grn/print/${grn.id}`}><FileText className="h-4 w-4" /></Link></Button>
                      {grn.status === "DRAFT" ? (
                        <>
                          <Button asChild variant="ghost" size="icon-sm" title="Edit Draft"><Link href={`/grn/${grn.id}/edit`}><Pencil className="h-4 w-4 text-amber-700" /></Link></Button>
                          <Button variant="ghost" size="icon-sm" title="Confirm Draft" disabled={confirmDraftMutation.isPending} onClick={() => setConfirmTarget(grn)}><CheckCircle2 className="h-4 w-4 text-green-600" /></Button>
                        </>
                      ) : null}
                      <Button variant="ghost" size="icon-sm" title="Cancel GRN" disabled={cancelMutation.isPending || grn.status === "CANCELLED"} onClick={() => setCancelTarget(grn)}><XCircle className="h-4 w-4 text-red-600" /></Button>
                      <Button variant="ghost" size="icon-sm" title="More actions" onClick={() => toast.info("More actions: attachments, audit trail, and lifecycle timeline can open from the detail page.")}><MoreHorizontal className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {visibleRows.length ? (
                <TableRow className="bg-slate-50 font-semibold">
                  <TableCell />
                  {visibleColumns.map((column, index) => (
                    <TableCell key={String(column.key)} className={column.numeric ? "text-right" : ""}>
                      {index === 0 ? "Totals" : column.key === "total_items" ? totals.items.toLocaleString() : column.key === "total_quantity" ? totals.quantity.toLocaleString() : ""}
                    </TableCell>
                  ))}
                  <TableCell />
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-slate-500">Page {page} of {totalPages} ({total} records){isFetching ? " - refreshing..." : ""}</p>
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
          <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</Button>
          <Button variant="outline" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>Next</Button>
        </div>
      </div>

      <Dialog open={Boolean(confirmTarget)} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Draft GRN</DialogTitle>
            <DialogDescription>This will post stock to inventory for {confirmTarget?.grn_number}. Continue?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>Cancel</Button>
            <Button
              disabled={!confirmTarget || confirmDraftMutation.isPending}
              onClick={async () => {
                if (!confirmTarget) return
                await confirmDraftMutation.mutateAsync(confirmTarget.id)
                setConfirmTarget(null)
              }}
            >
              Confirm GRN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(cancelTarget)} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></div>
            <DialogTitle>Cancel GRN</DialogTitle>
            <DialogDescription>Cancel {cancelTarget?.grn_number}? This action is audited and may affect receipt reporting.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Keep GRN</Button>
            <Button
              variant="destructive"
              disabled={!cancelTarget || cancelMutation.isPending}
              onClick={async () => {
                if (!cancelTarget) return
                await cancelMutation.mutateAsync(cancelTarget.id)
                setCancelTarget(null)
              }}
            >
              <Trash2 className="h-4 w-4" />
              Cancel GRN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone}`}>{value.toLocaleString()}</p>
    </div>
  )
}

function renderRawCell(row: GrnRow, key: keyof GrnRow | "source" | "variance") {
  if (key === "source") return sourceLabel(row.source_channel)
  if (key === "variance") return hasVariance(row) ? "Variance" : "OK"
  return row[key]
}

function renderCell(row: GrnRow, key: keyof GrnRow | "source" | "variance", statusBadge: (status: string) => React.ReactNode) {
  if (key === "grn_number") return <span className="font-medium text-blue-700">{row.grn_number}</span>
  if (key === "grn_date") return formatDate(row.grn_date)
  if (key === "created_at") return formatDateTime(row.created_at)
  if (key === "invoice_number") return <span className="font-mono text-sm">{row.invoice_number}</span>
  if (key === "status") return statusBadge(row.status)
  if (key === "source") return <Badge variant="secondary">{sourceLabel(row.source_channel)}</Badge>
  if (key === "variance") {
    return hasVariance(row) ? <Badge className="bg-red-100 text-red-700">Variance</Badge> : <Badge className="bg-emerald-100 text-emerald-800">OK</Badge>
  }
  if (key === "total_items" || key === "total_quantity") return Number(row[key] || 0).toLocaleString()
  return String(row[key] ?? "-")
}
