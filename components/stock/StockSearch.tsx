"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Eye, Loader2, Package, Search } from "lucide-react"
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

export function StockSearch() {
  const PAGE_SIZE = 50
  const router = useRouter()
  const [filters, setFilters] = useState({
    serial: "",
    item: "",
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

  const { data, isLoading } = useStockSearch<StockItem>(appliedFilters, currentPage, PAGE_SIZE)
  const warehouses = warehousesQuery.data ?? []
  const rows = data?.rows ?? []
  const summary = data?.summary ?? { in_stock: 0, reserved: 0, dispatched: 0, avg_age_days: 0 }
  const pagination = data?.pagination ?? { page: currentPage, limit: PAGE_SIZE, total: 0, totalPages: 1 }
  const activePage = pagination.page
  const totalRows = pagination.total
  const totalPages = Math.max(1, pagination.totalPages)

  const handleExport = () => {
    exportStockToExcel(rows)
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
      IN_STOCK: "bg-green-100 text-green-800",
      RESERVED: "bg-yellow-100 text-yellow-800",
      DISPATCHED: "bg-blue-100 text-blue-800",
    }
    return <Badge className={config[status] || "bg-gray-100 text-gray-800"}>{status.replace("_", " ")}</Badge>
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Search Stock</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-6">
          <div className="space-y-2">
            <Label>Serial Number</Label>
            <TypeaheadInput
              value={filters.serial}
              onValueChange={(value) => setFilters({ ...filters, serial: value })}
              suggestions={rows.map((stock) => stock.serial_number)}
              placeholder="Search serial"
            />
          </div>

          <div className="space-y-2">
            <Label>Item Name</Label>
            <TypeaheadInput
              value={filters.item}
              onValueChange={(value) => setFilters({ ...filters, item: value })}
              suggestions={rows.map((stock) => stock.item_name)}
              placeholder="Search item"
            />
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={filters.status} onValueChange={(value) => setFilters({ ...filters, status: value })}>
              <SelectTrigger>
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
            />
          </div>

          <div className="space-y-2">
            <Label>Max Age (Days)</Label>
            <Input
              type="number"
              value={filters.maxAge}
              onChange={(e) => setFilters({ ...filters, maxAge: e.target.value })}
            />
          </div>

          <div className="flex gap-2 md:col-span-6">
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => {
                setAppliedFilters(filters)
                setCurrentPage(1)
              }}
            >
              <Search className="mr-2 h-4 w-4" />
              Search
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const reset = { serial: "", item: "", status: "all", warehouseId: "all", minAge: "", maxAge: "" }
                setFilters(reset)
                setAppliedFilters(reset)
                setCurrentPage(1)
              }}
            >
              Reset
            </Button>
            <Button variant="outline" className="ml-auto" onClick={handleExport}>
              <Download className="mr-2 h-4 w-4" />
              Export to Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Search Results ({totalRows})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
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
                  <TableRow key={stock.id}>
                    <TableCell className="font-mono text-sm">{stock.serial_number}</TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{stock.item_name}</div>
                        <div className="text-xs text-gray-500">{stock.item_code}</div>
                      </div>
                    </TableCell>
                    <TableCell>{stock.client_name}</TableCell>
                    <TableCell>{stock.warehouse_name}</TableCell>
                    <TableCell>{stock.bin_location || stock.zone_name}</TableCell>
                    <TableCell>{getStatusBadge(stock.status)}</TableCell>
                    <TableCell>{stock.received_date}</TableCell>
                    <TableCell className="text-right">
                      <span className={stock.age_days > 60 ? "font-semibold text-red-600" : ""}>
                        {stock.age_days}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedStock(stock)}
                          aria-label={`View details for ${stock.serial_number}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
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
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-gray-500">
                      No stock found for selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
          {!isLoading && totalRows > 0 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Showing {(activePage - 1) * PAGE_SIZE + 1}-
                {Math.min((activePage - 1) * PAGE_SIZE + rows.length, totalRows)} of {totalRows}
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
                      <span key={`ellipsis-${index}`} className="px-1 text-sm text-gray-500">
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

      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600">In Stock</p>
            <p className="text-2xl font-bold text-green-600">{summary.in_stock}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600">Reserved</p>
            <p className="text-2xl font-bold text-yellow-600">{summary.reserved}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600">Dispatched</p>
            <p className="text-2xl font-bold text-blue-600">{summary.dispatched}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600">Avg Age</p>
            <p className="text-2xl font-bold">{summary.avg_age_days} days</p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selectedStock} onOpenChange={(open) => !open && setSelectedStock(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Stock Details</DialogTitle>
          </DialogHeader>
          {selectedStock && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <p className="text-gray-500">Serial</p>
              <p className="font-mono">{selectedStock.serial_number}</p>
              <p className="text-gray-500">Item</p>
              <p>{selectedStock.item_name}</p>
              <p className="text-gray-500">Item Code</p>
              <p>{selectedStock.item_code}</p>
              <p className="text-gray-500">Client</p>
              <p>{selectedStock.client_name}</p>
              <p className="text-gray-500">Warehouse</p>
              <p>{selectedStock.warehouse_name}</p>
              <p className="text-gray-500">Location</p>
              <p>{selectedStock.bin_location || selectedStock.zone_name}</p>
              <p className="text-gray-500">Status</p>
              <div>{getStatusBadge(selectedStock.status)}</div>
              <p className="text-gray-500">Received</p>
              <p>{selectedStock.received_date}</p>
              <p className="text-gray-500">Age</p>
              <p>{selectedStock.age_days} days</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
