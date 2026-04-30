"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Boxes,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  FileText,
  Layers3,
  Printer,
  Search,
  UserRound,
  X,
} from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { exportStockMovementsToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const PAGE_SIZE = 50

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type ClientOption = {
  id: number
  client_code?: string
  client_name?: string
}

type UserOption = {
  id: number
  username: string
  full_name?: string
  role?: string
}

type MovementRow = {
  id: number
  movement_ref: string
  stock_serial_id: number
  serial_number: string
  item_code: string
  item_name: string
  client_code?: string
  client_name?: string
  warehouse_id: number
  warehouse_name: string
  from_bin_location: string
  to_bin_location: string
  remarks?: string
  moved_by_user_id: number
  moved_by_name: string
  moved_by_username?: string
  moved_by_role?: string
  movement_source: string
  moved_at: string
}

type MovementResponse = {
  rows: MovementRow[]
  summary: {
    total: number
    moves_today: number
    unique_items: number
    unique_users: number
    most_active_warehouse: string
  }
}

type Filters = {
  warehouseId: string
  clientSearch: string
  clientId: string
  userSearch: string
  userId: string
  serial: string
  item: string
  fromBin: string
  toBin: string
  dateFrom: string
  dateTo: string
}

function blankFilters(): Filters {
  return {
    warehouseId: "all",
    clientSearch: "",
    clientId: "all",
    userSearch: "",
    userId: "all",
    serial: "",
    item: "",
    fromBin: "",
    toBin: "",
    dateFrom: "",
    dateTo: "",
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })
}

function getClientLabel(client: ClientOption) {
  const code = client.client_code?.trim()
  const name = client.client_name?.trim()
  if (code && name) return `${code} - ${name}`
  return name || code || `Client ${client.id}`
}

function getUserLabel(user: UserOption) {
  const name = user.full_name?.trim()
  if (name && name !== user.username) return `${name} (${user.username})`
  return user.username || `User ${user.id}`
}

function BinPill({ children }: { children: string }) {
  return (
    <Badge variant="outline" className="max-w-56 justify-start truncate font-mono text-xs">
      {children || "-"}
    </Badge>
  )
}

export default function MovementHistory() {
  const [filters, setFilters] = useState<Filters>(blankFilters)
  const [applied, setApplied] = useState<Filters>(blankFilters)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [viewMode, setViewMode] = useState<"serial" | "batch">("serial")
  const [selectedMovement, setSelectedMovement] = useState<MovementRow | null>(null)
  const [currentPage, setCurrentPage] = useState(1)

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const clientsQuery = useQuery({
    queryKey: ["movement-log", "clients"],
    queryFn: async () => {
      const res = await apiClient.get<ClientOption[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const usersQuery = useQuery({
    queryKey: ["movement-log", "users"],
    queryFn: async () => {
      const res = await apiClient.get<UserOption[]>("/users")
      return res.data ?? []
    },
  })

  const movementsQuery = useQuery({
    queryKey: ["stock", "movements", applied, currentPage],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (applied.warehouseId !== "all") params.set("warehouse_id", applied.warehouseId)
      if (applied.clientId !== "all") params.set("client_id", applied.clientId)
      if (applied.userId !== "all") params.set("user_id", applied.userId)
      if (applied.serial) params.set("serial", applied.serial)
      if (applied.item) params.set("item", applied.item)
      if (applied.fromBin) params.set("from_bin", applied.fromBin)
      if (applied.toBin) params.set("to_bin", applied.toBin)
      if (applied.dateFrom) params.set("date_from", applied.dateFrom)
      if (applied.dateTo) params.set("date_to", applied.dateTo)
      params.set("page", String(currentPage))
      params.set("limit", String(PAGE_SIZE))

      const res = await apiClient.get<MovementResponse>(`/stock/movements?${params.toString()}`)
      return {
        rows: res.data?.rows ?? [],
        summary:
          res.data?.summary ??
          { total: 0, moves_today: 0, unique_items: 0, unique_users: 0, most_active_warehouse: "-" },
        pagination: res.pagination ?? { page: currentPage, limit: PAGE_SIZE, total: 0, totalPages: 1 },
      }
    },
  })

  const warehouses = warehousesQuery.data ?? []
  const clients = clientsQuery.data ?? []
  const users = usersQuery.data ?? []
  const rows = movementsQuery.data?.rows ?? []
  const summary =
    movementsQuery.data?.summary ??
    { total: 0, moves_today: 0, unique_items: 0, unique_users: 0, most_active_warehouse: "-" }
  const pagination = movementsQuery.data?.pagination ?? { page: currentPage, limit: PAGE_SIZE, total: 0, totalPages: 1 }
  const activePage = pagination.page
  const totalPages = Math.max(1, pagination.totalPages)
  const displayedStart = pagination.total > 0 ? (activePage - 1) * PAGE_SIZE + 1 : 0
  const displayedEnd = Math.min((activePage - 1) * PAGE_SIZE + rows.length, pagination.total)

  const clientSuggestions = useMemo(() => clients.map(getClientLabel), [clients])
  const userSuggestions = useMemo(() => users.map(getUserLabel), [users])
  const serialSuggestions = useMemo(
    () => rows.flatMap((row) => [row.serial_number, row.item_code, row.item_name, row.from_bin_location, row.to_bin_location]),
    [rows]
  )

  const activeChips = useMemo(() => {
    const chips: Array<{ key: keyof Filters; label: string }> = []
    if (applied.warehouseId !== "all") {
      chips.push({
        key: "warehouseId",
        label: warehouses.find((warehouse) => String(warehouse.id) === applied.warehouseId)?.warehouse_name || "Warehouse",
      })
    }
    if (applied.clientSearch) chips.push({ key: "clientSearch", label: `Client: ${applied.clientSearch}` })
    if (applied.userSearch) chips.push({ key: "userSearch", label: `User: ${applied.userSearch}` })
    if (applied.serial) chips.push({ key: "serial", label: `Serial: ${applied.serial}` })
    if (applied.item) chips.push({ key: "item", label: `Item: ${applied.item}` })
    if (applied.fromBin) chips.push({ key: "fromBin", label: `From: ${applied.fromBin}` })
    if (applied.toBin) chips.push({ key: "toBin", label: `To: ${applied.toBin}` })
    if (applied.dateFrom) chips.push({ key: "dateFrom", label: `From date: ${applied.dateFrom}` })
    if (applied.dateTo) chips.push({ key: "dateTo", label: `To date: ${applied.dateTo}` })
    return chips
  }, [applied, warehouses])

  const groupedRows = useMemo(() => {
    const groups = new Map<string, { key: string; rows: MovementRow[]; first: MovementRow }>()
    for (const row of rows) {
      const minute = row.moved_at.slice(0, 16)
      const key = [minute, row.moved_by_user_id, row.warehouse_id, row.from_bin_location, row.to_bin_location, row.remarks || ""].join("|")
      const existing = groups.get(key)
      if (existing) {
        existing.rows.push(row)
      } else {
        groups.set(key, { key, rows: [row], first: row })
      }
    }
    return Array.from(groups.values())
  }, [rows])

  const resolveClientId = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return "all"
    const match = clients.find((client) => {
      const label = getClientLabel(client).toLowerCase()
      const code = client.client_code?.trim().toLowerCase()
      const name = client.client_name?.trim().toLowerCase()
      return label === normalized || code === normalized || name === normalized
    })
    return match ? String(match.id) : "all"
  }

  const resolveUserId = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return "all"
    const match = users.find((user) => {
      const label = getUserLabel(user).toLowerCase()
      const name = user.full_name?.trim().toLowerCase()
      const username = user.username?.trim().toLowerCase()
      return label === normalized || name === normalized || username === normalized
    })
    return match ? String(match.id) : "all"
  }

  const applyFilters = () => {
    const next = {
      ...filters,
      clientId: resolveClientId(filters.clientSearch),
      userId: resolveUserId(filters.userSearch),
      serial: filters.serial.trim(),
      item: filters.item.trim(),
      fromBin: filters.fromBin.trim(),
      toBin: filters.toBin.trim(),
    }
    setFilters(next)
    setApplied(next)
    setCurrentPage(1)
  }

  const clearFilters = () => {
    const next = blankFilters()
    setFilters(next)
    setApplied(next)
    setCurrentPage(1)
  }

  const clearChip = (key: keyof Filters) => {
    const next = { ...applied, [key]: "" }
    if (key === "warehouseId") next.warehouseId = "all"
    if (key === "clientSearch") next.clientId = "all"
    if (key === "userSearch") next.userId = "all"
    setFilters(next)
    setApplied(next)
    setCurrentPage(1)
  }

  const pageItems = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const items: Array<number | "..."> = [1]
    const start = Math.max(2, activePage - 1)
    const end = Math.min(totalPages - 1, activePage + 1)
    if (start > 2) items.push("...")
    for (let page = start; page <= end; page += 1) items.push(page)
    if (end < totalPages - 1) items.push("...")
    items.push(totalPages)
    return items
  }, [activePage, totalPages])

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={<FileText className="h-4 w-4" />} label="Total Moves" value={summary.total} />
        <MetricCard icon={<CalendarDays className="h-4 w-4" />} label="Moves Today" value={summary.moves_today} />
        <MetricCard icon={<Boxes className="h-4 w-4" />} label="Unique Items" value={summary.unique_items} />
        <MetricCard icon={<UserRound className="h-4 w-4" />} label="Unique Users" value={summary.unique_users} />
        <MetricCard icon={<Layers3 className="h-4 w-4" />} label="Top Warehouse" value={summary.most_active_warehouse} compact />
      </div>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="text-base">Audit Filters</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Search by warehouse, client, serial, item, bins, user, and movement date.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setFiltersOpen((value) => !value)}>
            {filtersOpen ? <ChevronUp className="mr-2 h-4 w-4" /> : <ChevronDown className="mr-2 h-4 w-4" />}
            Filters
          </Button>
        </CardHeader>
        {filtersOpen && (
          <CardContent className="grid gap-4 pt-5 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select
                value={filters.warehouseId}
                onValueChange={(value) => setFilters({ ...filters, warehouseId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {warehouses.map((wh) => (
                    <SelectItem key={wh.id} value={String(wh.id)}>
                      {wh.warehouse_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Client</Label>
              <TypeaheadInput
                value={filters.clientSearch}
                onValueChange={(value) => setFilters({ ...filters, clientSearch: value, clientId: resolveClientId(value) })}
                suggestions={clientSuggestions}
                maxSuggestions={100}
                placeholder="Search client"
              />
            </div>
            <div className="space-y-2">
              <Label>User</Label>
              <TypeaheadInput
                value={filters.userSearch}
                onValueChange={(value) => setFilters({ ...filters, userSearch: value, userId: resolveUserId(value) })}
                suggestions={userSuggestions}
                maxSuggestions={100}
                placeholder="Search user"
              />
            </div>
            <div className="space-y-2">
              <Label>Serial</Label>
              <TypeaheadInput
                value={filters.serial}
                onValueChange={(value) => setFilters({ ...filters, serial: value })}
                suggestions={serialSuggestions}
                placeholder="Serial number"
              />
            </div>
            <div className="space-y-2">
              <Label>Item</Label>
              <TypeaheadInput
                value={filters.item}
                onValueChange={(value) => setFilters({ ...filters, item: value })}
                suggestions={serialSuggestions}
                placeholder="Item code/name"
              />
            </div>
            <div className="space-y-2">
              <Label>From Bin</Label>
              <TypeaheadInput
                value={filters.fromBin}
                onValueChange={(value) => setFilters({ ...filters, fromBin: value })}
                suggestions={serialSuggestions}
                placeholder="Source bin"
              />
            </div>
            <div className="space-y-2">
              <Label>To Bin</Label>
              <TypeaheadInput
                value={filters.toBin}
                onValueChange={(value) => setFilters({ ...filters, toBin: value })}
                suggestions={serialSuggestions}
                placeholder="Destination bin"
              />
            </div>
            <div className="space-y-2">
              <Label>Date From</Label>
              <Input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Date To</Label>
              <Input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </div>
            <div className="flex items-end gap-2 xl:col-span-3">
              <Button onClick={applyFilters} className="bg-blue-600 hover:bg-blue-700">
                <Search className="mr-2 h-4 w-4" />
                Apply Filters
              </Button>
              <Button variant="outline" onClick={clearFilters}>
                <X className="mr-2 h-4 w-4" />
                Clear
              </Button>
            </div>
          </CardContent>
        )}
        {activeChips.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 px-6 py-3 dark:border-slate-800">
            {activeChips.map((chip) => (
              <Badge key={`${chip.key}-${chip.label}`} variant="outline" className="gap-2 bg-blue-50 text-blue-700">
                {chip.label}
                <button type="button" onClick={() => clearChip(chip.key)} aria-label={`Clear ${chip.label}`}>
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </Card>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="text-base">Movement Results</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {pagination.total > 0
                ? `Showing ${displayedStart}-${displayedEnd} of ${pagination.total} audit records`
                : "No movement records found for these filters"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant={viewMode === "serial" ? "default" : "outline"} size="sm" onClick={() => setViewMode("serial")}>
              Serial view
            </Button>
            <Button variant={viewMode === "batch" ? "default" : "outline"} size="sm" onClick={() => setViewMode("batch")}>
              Grouped view
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportStockMovementsToExcel(rows)} disabled={rows.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[620px] overflow-auto">
            {viewMode === "serial" ? (
              <MovementTable rows={rows} isLoading={movementsQuery.isLoading} onSelect={setSelectedMovement} />
            ) : (
              <GroupedMovementTable groups={groupedRows} isLoading={movementsQuery.isLoading} onSelect={setSelectedMovement} />
            )}
          </div>
          {pagination.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
              <p className="text-sm text-slate-500">
                Page {activePage} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={activePage === 1}>
                  Previous
                </Button>
                <div className="flex items-center gap-1">
                  {pageItems.map((item, index) =>
                    item === "..." ? (
                      <span key={`ellipsis-${index}`} className="px-1 text-sm text-slate-500">...</span>
                    ) : (
                      <Button
                        key={item}
                        variant={item === activePage ? "default" : "outline"}
                        size="sm"
                        className="min-w-9"
                        onClick={() => setCurrentPage(item)}
                      >
                        {item}
                      </Button>
                    )
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={activePage === totalPages}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedMovement} onOpenChange={(open) => !open && setSelectedMovement(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Movement Details</DialogTitle>
            <DialogDescription>{selectedMovement?.movement_ref}</DialogDescription>
          </DialogHeader>
          {selectedMovement && (
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Exact Timestamp" value={formatTimestamp(selectedMovement.moved_at)} />
              <Detail label="Source" value={selectedMovement.movement_source} />
              <Detail label="Serial" value={selectedMovement.serial_number} mono />
              <Detail label="Movement ID" value={selectedMovement.movement_ref} mono />
              <Detail label="Item" value={`${selectedMovement.item_name} (${selectedMovement.item_code})`} />
              <Detail label="Client" value={selectedMovement.client_name || "-"} />
              <Detail label="Warehouse" value={selectedMovement.warehouse_name} />
              <Detail label="User" value={selectedMovement.moved_by_name || selectedMovement.moved_by_username || "-"} />
              <Detail label="Role" value={selectedMovement.moved_by_role || "-"} />
              <Detail label="Username" value={selectedMovement.moved_by_username || "-"} />
              <Detail label="From Bin" value={selectedMovement.from_bin_location} mono />
              <Detail label="To Bin" value={selectedMovement.to_bin_location} mono />
              <div className="sm:col-span-2">
                <Detail label="Remarks" value={selectedMovement.remarks || "-"} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MetricCard({
  icon,
  label,
  value,
  compact,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  compact?: boolean
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <span className="rounded-md bg-blue-50 p-2 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">{icon}</span>
      </div>
      <p className={compact ? "mt-3 truncate text-lg font-semibold text-slate-950 dark:text-slate-50" : "mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50"}>
        {value}
      </p>
    </div>
  )
}

function MovementTable({
  rows,
  isLoading,
  onSelect,
}: {
  rows: MovementRow[]
  isLoading: boolean
  onSelect: (row: MovementRow) => void
}) {
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-slate-50 shadow-sm dark:bg-slate-900">
        <TableRow>
          <TableHead>Moved At</TableHead>
          <TableHead>Movement</TableHead>
          <TableHead>Serial</TableHead>
          <TableHead>Item</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Warehouse</TableHead>
          <TableHead>Movement Path</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading && (
          <TableRow>
            <TableCell colSpan={10} className="py-12 text-center text-sm text-slate-500">Loading movement records...</TableCell>
          </TableRow>
        )}
        {!isLoading && rows.map((row) => (
          <TableRow key={row.id} className="hover:bg-blue-50/40 dark:hover:bg-blue-950/20">
            <TableCell className="whitespace-nowrap" title={formatTimestamp(row.moved_at)}>
              <div>{formatDate(row.moved_at)}</div>
              <div className="text-xs text-slate-500">{formatTime(row.moved_at)}</div>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.movement_ref}</TableCell>
            <TableCell>
              <button className="font-mono text-xs text-blue-700 hover:underline" onClick={() => onSelect(row)}>
                {row.serial_number}
              </button>
            </TableCell>
            <TableCell className="min-w-56">
              <div className="font-medium">{row.item_name}</div>
              <div className="text-xs text-slate-500">{row.item_code}</div>
            </TableCell>
            <TableCell className="min-w-40">{row.client_name || "-"}</TableCell>
            <TableCell className="min-w-44">{row.warehouse_name}</TableCell>
            <TableCell className="min-w-72">
              <div className="flex items-center gap-2">
                <BinPill>{row.from_bin_location}</BinPill>
                <span className="text-slate-400">-&gt;</span>
                <BinPill>{row.to_bin_location}</BinPill>
              </div>
            </TableCell>
            <TableCell>
              <div>{row.moved_by_name || row.moved_by_username || "-"}</div>
              <div className="text-xs text-slate-500">{row.moved_by_username || row.moved_by_role || ""}</div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{row.movement_source || "web"}</Badge>
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="icon-sm" onClick={() => onSelect(row)} aria-label={`View ${row.movement_ref}`}>
                <Eye className="h-4 w-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {!isLoading && rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={10} className="py-12 text-center text-sm text-slate-500">
              No movements found for these filters. Try expanding the date range or clearing filters.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

function GroupedMovementTable({
  groups,
  isLoading,
  onSelect,
}: {
  groups: Array<{ key: string; rows: MovementRow[]; first: MovementRow }>
  isLoading: boolean
  onSelect: (row: MovementRow) => void
}) {
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-slate-50 shadow-sm dark:bg-slate-900">
        <TableRow>
          <TableHead>Moved At</TableHead>
          <TableHead>Batch</TableHead>
          <TableHead>Serials</TableHead>
          <TableHead>Item Sample</TableHead>
          <TableHead>Warehouse</TableHead>
          <TableHead>Movement Path</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Remarks</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading && (
          <TableRow>
            <TableCell colSpan={8} className="py-12 text-center text-sm text-slate-500">Loading movement records...</TableCell>
          </TableRow>
        )}
        {!isLoading && groups.map((group) => (
          <TableRow key={group.key} className="hover:bg-blue-50/40 dark:hover:bg-blue-950/20">
            <TableCell className="whitespace-nowrap" title={formatTimestamp(group.first.moved_at)}>
              <div>{formatDate(group.first.moved_at)}</div>
              <div className="text-xs text-slate-500">{formatTime(group.first.moved_at)}</div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{group.rows.length} serials</Badge>
            </TableCell>
            <TableCell>
              <button className="font-mono text-xs text-blue-700 hover:underline" onClick={() => onSelect(group.first)}>
                {group.first.serial_number}
              </button>
              {group.rows.length > 1 && <div className="text-xs text-slate-500">+{group.rows.length - 1} more</div>}
            </TableCell>
            <TableCell className="min-w-56">
              <div className="font-medium">{group.first.item_name}</div>
              <div className="text-xs text-slate-500">{group.first.item_code}</div>
            </TableCell>
            <TableCell>{group.first.warehouse_name}</TableCell>
            <TableCell className="min-w-72">
              <div className="flex items-center gap-2">
                <BinPill>{group.first.from_bin_location}</BinPill>
                <span className="text-slate-400">-&gt;</span>
                <BinPill>{group.first.to_bin_location}</BinPill>
              </div>
            </TableCell>
            <TableCell>{group.first.moved_by_name || group.first.moved_by_username || "-"}</TableCell>
            <TableCell>{group.first.remarks || "-"}</TableCell>
          </TableRow>
        ))}
        {!isLoading && groups.length === 0 && (
          <TableRow>
            <TableCell colSpan={8} className="py-12 text-center text-sm text-slate-500">
              No movement batches found for these filters.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className={mono ? "mt-1 break-words font-mono text-sm" : "mt-1 break-words text-sm"}>{value}</p>
    </div>
  )
}
