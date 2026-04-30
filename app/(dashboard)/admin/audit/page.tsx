"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Eye,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type AuditRow = {
  id: string
  company_id: number
  actor_user_id: number | null
  actor_type: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  before: JsonValue | null
  after: JsonValue | null
  ip: string | null
  user_agent: string | null
  created_at: string
}

const actionOptions = [
  { value: "all", label: "All actions" },
  { value: "settings.update", label: "Settings Updated" },
  { value: "stock.adjust", label: "Stock Adjusted" },
  { value: "CREATE", label: "Created" },
  { value: "UPDATE", label: "Updated" },
  { value: "DELETE", label: "Deleted" },
  { value: "LOGIN", label: "Login" },
  { value: "LOGOUT", label: "Logout" },
]

const entityOptions = [
  { value: "all", label: "All entities" },
  { value: "users", label: "Users" },
  { value: "clients", label: "Clients" },
  { value: "items", label: "Items" },
  { value: "warehouses", label: "Warehouses" },
  { value: "grn_header", label: "GRN" },
  { value: "do_header", label: "Delivery Orders" },
  { value: "stock_serial_numbers", label: "Stock Serials" },
  { value: "stock_putaway_movements", label: "Stock Movements" },
]

const pageSizeOptions = [25, 50, 100]

function dateInputValue(date: Date) {
  return date.toISOString().slice(0, 10)
}

function formatDateTime(value: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date)
}

function normalizeText(value: string | null | undefined) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\./g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatAction(action: string) {
  const match = actionOptions.find((option) => option.value === action)
  return match && match.value !== "all" ? match.label : normalizeText(action)
}

function formatActor(row: AuditRow) {
  const actorType = String(row.actor_type || "system").toLowerCase()
  if (actorType === "system") return row.actor_user_id ? `System #${row.actor_user_id}` : "System"
  if (actorType === "web") return row.actor_user_id ? `Web User #${row.actor_user_id}` : "Web Session"
  if (actorType === "mobile") return row.actor_user_id ? `Mobile User #${row.actor_user_id}` : "Mobile Session"
  return row.actor_user_id ? `${normalizeText(actorType)} #${row.actor_user_id}` : normalizeText(actorType)
}

function formatEntity(row: AuditRow) {
  const entity = row.entity_type ? normalizeText(row.entity_type) : "Unspecified"
  return row.entity_id ? `${entity} #${row.entity_id}` : entity
}

function getCategory(row: AuditRow) {
  const action = row.action.toLowerCase()
  const entity = String(row.entity_type || "").toLowerCase()
  if (action.includes("login") || action.includes("logout") || entity.includes("session")) return "Security"
  if (action.includes("settings") || entity.includes("settings") || entity.includes("policy")) return "Settings"
  if (entity.includes("stock") || entity.includes("grn") || entity.includes("do_")) return "Inventory"
  if (entity.includes("finance") || entity.includes("invoice") || entity.includes("billing")) return "Finance"
  if (entity.includes("user") || entity.includes("client")) return "Identity"
  return "System"
}

function categoryClass(category: string) {
  if (category === "Security") return "border-emerald-200 bg-emerald-50 text-emerald-700"
  if (category === "Settings") return "border-amber-200 bg-amber-50 text-amber-700"
  if (category === "Inventory") return "border-sky-200 bg-sky-50 text-sky-700"
  if (category === "Finance") return "border-violet-200 bg-violet-50 text-violet-700"
  if (category === "Identity") return "border-cyan-200 bg-cyan-50 text-cyan-700"
  return "border-slate-200 bg-slate-50 text-slate-700"
}

function jsonPreview(value: JsonValue | null) {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

export default function AuditLogsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [action, setAction] = useState("all")
  const [customAction, setCustomAction] = useState("")
  const [actorUserId, setActorUserId] = useState("")
  const [entityType, setEntityType] = useState("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null)
  const didLoadInitialData = useRef(false)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages
  const activeAction = customAction.trim() || (action === "all" ? "" : action)

  const load = useCallback(
    async (targetPage = page, targetPageSize = pageSize) => {
      setLoading(true)
      setError("")
      const params = new URLSearchParams()
      if (activeAction) params.set("action", activeAction)
      if (actorUserId.trim()) params.set("actor_user_id", actorUserId.trim())
      if (entityType !== "all") params.set("entity_type", entityType)
      if (fromDate) params.set("from", `${fromDate}T00:00:00.000`)
      if (toDate) params.set("to", `${toDate}T23:59:59.999`)
      params.set("limit", String(targetPageSize))
      params.set("offset", String((targetPage - 1) * targetPageSize))

      try {
        const res = await fetch(`/api/admin/audit?${params.toString()}`, { cache: "no-store" })
        const json = await res.json()
        if (!res.ok) {
          const message = json?.error?.message || "Failed to fetch audit logs"
          setError(message)
          toast.error(message)
          return
        }
        setRows((json?.data?.rows || []) as AuditRow[])
        setTotal(Number(json?.data?.paging?.total || 0))
        setPage(targetPage)
      } catch {
        setError("Unable to reach the audit service")
        toast.error("Unable to reach the audit service")
      } finally {
        setLoading(false)
      }
    },
    [activeAction, actorUserId, entityType, fromDate, page, pageSize, toDate]
  )

  useEffect(() => {
    if (didLoadInitialData.current) return
    didLoadInitialData.current = true
    void load(1)
  }, [load])

  const showingFrom = rows.length && total > 0 ? (page - 1) * pageSize + 1 : 0
  const showingTo = (page - 1) * pageSize + rows.length

  const filteredSummary = useMemo(() => {
    const parts = []
    if (activeAction) parts.push(formatAction(activeAction))
    if (entityType !== "all") parts.push(normalizeText(entityType))
    if (actorUserId.trim()) parts.push(`Actor #${actorUserId.trim()}`)
    if (fromDate || toDate) parts.push(`${fromDate || "Start"} to ${toDate || "Now"}`)
    return parts.length ? parts.join(" / ") : "All audit events"
  }, [activeAction, actorUserId, entityType, fromDate, toDate])

  function resetFilters() {
    setAction("all")
    setCustomAction("")
    setActorUserId("")
    setEntityType("all")
    setFromDate("")
    setToDate("")
  }

  function applyQuickFilter(type: "today" | "7d" | "settings" | "security" | "inventory") {
    const now = new Date()
    if (type === "today") {
      const today = dateInputValue(now)
      setFromDate(today)
      setToDate(today)
      return
    }
    if (type === "7d") {
      const start = new Date(now)
      start.setDate(now.getDate() - 6)
      setFromDate(dateInputValue(start))
      setToDate(dateInputValue(now))
      return
    }
    if (type === "settings") {
      setAction("settings.update")
      setCustomAction("")
      setEntityType("all")
      return
    }
    if (type === "security") {
      setAction("all")
      setCustomAction("LOGIN")
      setEntityType("all")
      return
    }
    setAction("stock.adjust")
    setCustomAction("")
    setEntityType("stock_serial_numbers")
  }

  function exportCsv() {
    const header = ["Time", "Actor", "Category", "Action", "Entity", "IP", "User Agent", "Request ID"]
    const lines = rows.map((row) =>
      [
        formatDateTime(row.created_at),
        formatActor(row),
        getCategory(row),
        formatAction(row.action),
        formatEntity(row),
        row.ip || "",
        row.user_agent || "",
        row.id,
      ]
        .map(csvValue)
        .join(",")
    )
    const csv = [header.map(csvValue).join(","), ...lines].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `audit-logs-page-${page}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  function changePageSize(value: string) {
    const nextSize = Number(value)
    setPageSize(nextSize)
    void load(1, nextSize)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-slate-700" />
            <h1 className="text-2xl font-semibold tracking-normal text-slate-950">Audit Logs</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Track system, user, and data changes across this tenant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-md border-slate-200 bg-white px-2.5 py-1 text-slate-600">
            Immutable trail
          </Badge>
          <Badge variant="outline" className="rounded-md border-slate-200 bg-white px-2.5 py-1 text-slate-600">
            Server-side paging
          </Badge>
        </div>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="h-4 w-4" />
              Investigation Filters
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => applyQuickFilter("today")}>Today</Button>
              <Button variant="outline" size="sm" onClick={() => applyQuickFilter("7d")}>Last 7 days</Button>
              <Button variant="outline" size="sm" onClick={() => applyQuickFilter("settings")}>Settings</Button>
              <Button variant="outline" size="sm" onClick={() => applyQuickFilter("security")}>Security</Button>
              <Button variant="outline" size="sm" onClick={() => applyQuickFilter("inventory")}>Inventory</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1.1fr_1.1fr_0.9fr_0.9fr_0.9fr_auto]">
            <div className="space-y-2">
              <Label>Action</Label>
              <Select value={action} onValueChange={(value) => { setAction(value); setCustomAction("") }}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {actionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Advanced action code</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  value={customAction}
                  onChange={(event) => setCustomAction(event.target.value)}
                  placeholder="settings.update"
                  className="h-10 pl-9"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Entity</Label>
              <Select value={entityType} onValueChange={setEntityType}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {entityOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Actor ID</Label>
              <Input
                inputMode="numeric"
                value={actorUserId}
                onChange={(event) => setActorUserId(event.target.value.replace(/\D/g, ""))}
                placeholder="16"
                className="h-10"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label>From</Label>
                <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-10" />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-10" />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={() => void load(1)} disabled={loading} className="h-10">
                {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Filter className="h-4 w-4" />}
                Apply
              </Button>
              <Button variant="outline" size="icon" onClick={resetFilters} title="Reset filters">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t pt-3 text-sm text-slate-500 md:flex-row md:items-center md:justify-between">
            <span>{filteredSummary}</span>
            <span>Retention and export access follow tenant policy.</span>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-lg shadow-sm">
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium text-slate-900">
                Showing {showingFrom}-{showingTo} of {total.toLocaleString("en-IN")}
              </p>
              <p className="text-xs text-slate-500">Page {page} of {totalPages}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(pageSize)} onValueChange={changePageSize}>
                <SelectTrigger className="h-9 w-[112px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void load(page)} disabled={loading}>
                <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon-sm" onClick={() => void load(1)} disabled={loading || !canPrev} title="First page">
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon-sm" onClick={() => void load(page - 1)} disabled={loading || !canPrev} title="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon-sm" onClick={() => void load(page + 1)} disabled={loading || !canNext} title="Next page">
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon-sm" onClick={() => void load(totalPages)} disabled={loading || !canNext} title="Last page">
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {error ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <Table>
            <TableHeader className="sticky top-0 z-10 bg-slate-50 shadow-sm">
              <TableRow>
                <TableHead className="min-w-52">Time</TableHead>
                <TableHead className="min-w-40">Actor</TableHead>
                <TableHead className="min-w-32">Category</TableHead>
                <TableHead className="min-w-44">Action</TableHead>
                <TableHead className="min-w-64">Entity</TableHead>
                <TableHead className="min-w-32">IP</TableHead>
                <TableHead className="w-20 text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading
                ? Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={`skeleton-${index}`}>
                      <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-44" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="ml-auto h-8 w-8" /></TableCell>
                    </TableRow>
                  ))
                : rows.map((row) => {
                    const category = getCategory(row)
                    return (
                      <TableRow key={row.id} className="cursor-pointer" onClick={() => setSelectedRow(row)}>
                        <TableCell>
                          <div className="font-medium text-slate-900">{formatDateTime(row.created_at)}</div>
                          <div className="font-mono text-xs text-slate-500">{row.id}</div>
                        </TableCell>
                        <TableCell>
                          <div className="text-slate-900">{formatActor(row)}</div>
                          <div className="text-xs text-slate-500">{row.actor_type || "system"}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={categoryClass(category)}>{category}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-slate-900">{formatAction(row.action)}</div>
                          <div className="font-mono text-xs text-slate-500">{row.action}</div>
                        </TableCell>
                        <TableCell>{formatEntity(row)}</TableCell>
                        <TableCell>{row.ip || "-"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(event) => {
                              event.stopPropagation()
                              setSelectedRow(row)
                            }}
                            title="View audit details"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
              {!loading && !rows.length ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="mx-auto max-w-sm space-y-2">
                      <p className="font-medium text-slate-900">No audit logs found</p>
                      <p className="text-sm text-slate-500">Try a wider date range or clear the action/entity filters.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selectedRow} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
          {selectedRow ? (
            <>
              <DialogHeader>
                <DialogTitle>{formatAction(selectedRow.action)}</DialogTitle>
                <DialogDescription>
                  {formatEntity(selectedRow)} by {formatActor(selectedRow)} on {formatDateTime(selectedRow.created_at)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ["Request ID", selectedRow.id],
                  ["Company", selectedRow.company_id],
                  ["Actor", formatActor(selectedRow)],
                  ["Raw actor", `${selectedRow.actor_type || "system"}${selectedRow.actor_user_id ? `:${selectedRow.actor_user_id}` : ""}`],
                  ["IP address", selectedRow.ip || "-"],
                  ["User agent", selectedRow.user_agent || "-"],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-md border bg-slate-50 p-3">
                    <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
                    <p className="mt-1 break-words text-sm text-slate-900">{String(value)}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Before</p>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-slate-950 p-3 text-xs text-slate-100">
                    {jsonPreview(selectedRow.before)}
                  </pre>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">After</p>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-slate-950 p-3 text-xs text-slate-100">
                    {jsonPreview(selectedRow.after)}
                  </pre>
                </div>
              </div>

              <DialogFooter showCloseButton />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
