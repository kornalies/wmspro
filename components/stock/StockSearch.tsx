"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Boxes,
  Clock3,
  Download,
  Eye,
  Filter,
  Loader2,
  Package,
  RefreshCcw,
  Search,
} from "lucide-react"
import { useRouter } from "next/navigation"

import { useStockSearch } from "@/hooks/use-stock"
import { apiClient } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { exportStockToExcel } from "@/lib/export-utils"

type StockItem = {
  id: number
  warehouse_id: number
  serial_number: string
  item_name: string
  item_code: string
  client_name: string
  warehouse_name: string
  zone_name: string
  rack_name?: string
  bin_name?: string
  bin_location?: string
  status: "IN_STOCK" | "RESERVED" | "DISPATCHED"
  received_date: string
  age_days: number
}

type WarehouseOption = {
  id: number
  warehouse_name?: string
  warehouse_code?: string
}

type ClientOption = {
  id: number
  client_name?: string
  client_code?: string
}

function getClientLabel(client: ClientOption) {
  const name = client.client_name?.trim()
  const code = client.client_code?.trim()

  if (code && name) return `${code} - ${name}`
  return name || code || `Client ${client.id}`
}

function formatReceivedDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

export function StockSearch() {
  const PAGE_SIZE = 50
  const router = useRouter()
  const [filters, setFilters] = useState({
    serial: "",
    item: "",
    clientSearch: "",
    clientId: "all",
    status: "all",
    warehouseId: "all",
    minAge: "",
    maxAge: "",
  })
  const [appliedFilters, setAppliedFilters] = useState(filters)
  const [selectedStock, setSelectedStock] = useState<StockItem | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const warehousesQuery = useQuery({
    queryKey: ["stock-search", "warehouses"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })
  const clientsQuery = useQuery({
    queryKey: ["stock-search", "clients"],
    queryFn: async () => {
      const res = await apiClient.get<ClientOption[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const { data, isLoading } = useStockSearch<StockItem>(appliedFilters, currentPage, PAGE_SIZE)
  const warehouses = warehousesQuery.data ?? []
  const clients = clientsQuery.data ?? []
  const clientSuggestions = useMemo(() => clients.map(getClientLabel), [clients])
  const rows = data?.rows ?? []
  const summary = data?.summary ?? { in_stock: 0, reserved: 0, dispatched: 0, avg_age_days: 0 }
  const pagination = data?.pagination ?? { page: currentPage, limit: PAGE_SIZE, total: 0, totalPages: 1 }
  const activePage = pagination.page
  const totalRows = pagination.total
  const totalPages = Math.max(1, pagination.totalPages)
  const hasActiveFilters =
    Boolean(appliedFilters.serial) ||
    Boolean(appliedFilters.item) ||
    Boolean(appliedFilters.clientSearch) ||
    appliedFilters.status !== "all" ||
    appliedFilters.warehouseId !== "all" ||
    Boolean(appliedFilters.minAge) ||
    Boolean(appliedFilters.maxAge)
  const displayedStart = totalRows > 0 ? (activePage - 1) * PAGE_SIZE + 1 : 0
  const displayedEnd = Math.min((activePage - 1) * PAGE_SIZE + rows.length, totalRows)

  const handleExport = () => {
    exportStockToExcel(rows)
  }

  const resolveClientId = (searchText: string) => {
    const normalized = searchText.trim().toLowerCase()
    if (!normalized) return "all"

    const exactMatch = clients.find((client) => {
      const label = getClientLabel(client).toLowerCase()
      const name = client.client_name?.trim().toLowerCase()
      const code = client.client_code?.trim().toLowerCase()
      return label === normalized || name === normalized || code === normalized
    })
    if (exactMatch) return String(exactMatch.id)

    const partialMatches = clients.filter((client) => getClientLabel(client).toLowerCase().includes(normalized))
    return partialMatches.length === 1 ? String(partialMatches[0].id) : "all"
  }

  const handleMoveToTransfer = (stock: StockItem) => {
    const params = new URLSearchParams({
      warehouse_id: String(stock.warehouse_id),
      serial: stock.serial_number,
      item: stock.item_code,
    })
    router.push(`/stock/transfer?${params.toString()}`)
  }

  const pageItems = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }

    const items: Array<number | "..."> = [1]
    const start = Math.max(2, activePage - 1)
    const end = Math.min(totalPages - 1, activePage + 1)

    if (start > 2) items.push("...")
    for (let page = start; page <= end; page += 1) {
      items.push(page)
    }
    if (end < totalPages - 1) items.push("...")
    items.push(totalPages)

    return items
  }, [activePage, totalPages])

  const getStatusBadge = (status: string) => {
    const config: Record<string, string> = {
      IN_STOCK: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
      RESERVED: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
      DISPATCHED: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200",
    }
    return (
      <Badge
        variant="outline"
        className={config[status] || "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"}
      >
        {status.replace("_", " ")}
      </Badge>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">In Stock</p>
            <span className="rounded-md bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300">
              <Boxes className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
            {summary.in_stock}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Reserved</p>
            <span className="rounded-md bg-amber-50 p-2 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300">
              <Package className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
            {summary.reserved}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Dispatched</p>
            <span className="rounded-md bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300">
              <Download className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
            {summary.dispatched}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Average Age</p>
            <span className="rounded-md bg-violet-50 p-2 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300">
              <Clock3 className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
            {summary.avg_age_days} <span className="text-sm font-medium text-slate-500">days</span>
          </p>
        </div>
      </div>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="h-4 w-4 text-slate-500" />
              Inventory Filters
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Narrow results by serial, item, client, warehouse, status, or stock age.
            </p>
          </div>
          {hasActiveFilters && (
            <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
              Filtered view
            </Badge>
          )}
        </CardHeader>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2 xl:grid-cols-12">
          <div className="space-y-2">
            <Label>Serial Number</Label>
            <TypeaheadInput
              value={filters.serial}
              onValueChange={(value) => setFilters({ ...filters, serial: value })}
              suggestions={rows.map((stock) => stock.serial_number)}
              placeholder="Search serial"
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label>Item Name</Label>
            <TypeaheadInput
              value={filters.item}
              onValueChange={(value) => setFilters({ ...filters, item: value })}
              suggestions={rows.map((stock) => stock.item_name)}
              placeholder="Search item"
              className="h-10"
            />
          </div>

          <div className="space-y-2 xl:col-span-2">
            <Label>Client</Label>
            <TypeaheadInput
              value={filters.clientSearch}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  clientSearch: value,
                  clientId: resolveClientId(value),
                })
              }
              suggestions={clientSuggestions}
              maxSuggestions={100}
              placeholder="Search client"
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={filters.status} onValueChange={(value) => setFilters({ ...filters, status: value })}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="IN_STOCK">In Stock</SelectItem>
                <SelectItem value="RESERVED">Reserved</SelectItem>
                <SelectItem value="DISPATCHED">Dispatched</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 xl:col-span-2">
            <Label>Warehouse</Label>
            <Select
              value={filters.warehouseId}
              onValueChange={(value) => setFilters({ ...filters, warehouseId: value })}
            >
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name || warehouse.warehouse_code || `Warehouse ${warehouse.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Min Age (Days)</Label>
            <Input
              type="number"
              value={filters.minAge}
              onChange={(e) => setFilters({ ...filters, minAge: e.target.value })}
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label>Max Age (Days)</Label>
            <Input
              type="number"
              value={filters.maxAge}
              onChange={(e) => setFilters({ ...filters, maxAge: e.target.value })}
              className="h-10"
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4 md:col-span-2 xl:col-span-12 dark:border-slate-800">
            <Button
              className="bg-blue-600 px-5 hover:bg-blue-700"
              onClick={() => {
                const nextFilters = { ...filters, clientId: resolveClientId(filters.clientSearch) }
                setFilters(nextFilters)
                setAppliedFilters(nextFilters)
                setCurrentPage(1)
              }}
            >
              <Search className="mr-2 h-4 w-4" />
              Search
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const reset = {
                  serial: "",
                  item: "",
                  clientSearch: "",
                  clientId: "all",
                  status: "all",
                  warehouseId: "all",
                  minAge: "",
                  maxAge: "",
                }
                setFilters(reset)
                setAppliedFilters(reset)
                setCurrentPage(1)
              }}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
            <Button variant="outline" className="ml-auto" onClick={handleExport}>
              <Download className="mr-2 h-4 w-4" />
              Export to Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="text-base">Inventory Results</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {totalRows > 0
                ? `Showing ${displayedStart}-${displayedEnd} of ${totalRows} serials`
                : "No serials match the selected filters"}
            </p>
          </div>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
            {totalRows} results
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b bg-slate-50/80 hover:bg-slate-50/80 dark:bg-slate-900/60 dark:hover:bg-slate-900/60">
                  <TableHead>Serial Number</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead className="text-right">Age (Days)</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((stock) => (
                  <TableRow key={stock.id} className="hover:bg-blue-50/40 dark:hover:bg-blue-950/20">
                    <TableCell className="whitespace-nowrap font-mono text-sm text-slate-800 dark:text-slate-100">
                      {stock.serial_number}
                    </TableCell>
                    <TableCell>
                      <div className="min-w-56">
                        <div className="font-medium text-slate-950 dark:text-slate-50">{stock.item_name}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{stock.item_code}</div>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-40">{stock.client_name}</TableCell>
                    <TableCell className="min-w-48">{stock.warehouse_name}</TableCell>
                    <TableCell className="min-w-48 font-mono text-xs text-slate-700 dark:text-slate-300">
                      {stock.bin_location || stock.zone_name}
                    </TableCell>
                    <TableCell>{getStatusBadge(stock.status)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatReceivedDate(stock.received_date)}</TableCell>
                    <TableCell className="text-right">
                      <span className={stock.age_days > 60 ? "font-semibold text-rose-600 dark:text-rose-300" : ""}>
                        {stock.age_days}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setSelectedStock(stock)}
                          aria-label={`View details for ${stock.serial_number}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleMoveToTransfer(stock)}
                          aria-label={`Move ${stock.serial_number} to transfer`}
                        >
                          <Package className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                      No stock found for selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>
          )}
          {!isLoading && totalRows > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Showing {displayedStart}-{displayedEnd} of {totalRows}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={activePage === 1}
                >
                  Previous
                </Button>
                <div className="flex items-center gap-1">
                  {pageItems.map((item, index) =>
                    item === "..." ? (
                      <span key={`ellipsis-${index}`} className="px-1 text-sm text-slate-500 dark:text-slate-400">
                        ...
                      </span>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={activePage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedStock} onOpenChange={(open) => !open && setSelectedStock(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Stock Details</DialogTitle>
          </DialogHeader>
          {selectedStock && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <p className="text-slate-500 dark:text-slate-400">Serial</p>
              <p className="font-mono">{selectedStock.serial_number}</p>
              <p className="text-slate-500 dark:text-slate-400">Item</p>
              <p>{selectedStock.item_name}</p>
              <p className="text-slate-500 dark:text-slate-400">Item Code</p>
              <p>{selectedStock.item_code}</p>
              <p className="text-slate-500 dark:text-slate-400">Client</p>
              <p>{selectedStock.client_name}</p>
              <p className="text-slate-500 dark:text-slate-400">Warehouse</p>
              <p>{selectedStock.warehouse_name}</p>
              <p className="text-slate-500 dark:text-slate-400">Location</p>
              <p>{selectedStock.bin_location || selectedStock.zone_name}</p>
              <p className="text-slate-500 dark:text-slate-400">Status</p>
              <div>{getStatusBadge(selectedStock.status)}</div>
              <p className="text-slate-500 dark:text-slate-400">Received</p>
              <p>{selectedStock.received_date}</p>
              <p className="text-slate-500 dark:text-slate-400">Age</p>
              <p>{selectedStock.age_days} days</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
