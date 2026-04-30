"use client"

import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Filter,
  Loader2,
  PackageCheck,
  Search,
  Send,
  X,
} from "lucide-react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
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
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type ZoneLayoutOption = {
  id: number
  zone_code: string
  rack_code: string
  bin_code: string
  zone_name: string
}

type ClientOption = {
  id: number
  client_code?: string
  client_name?: string
}

type PutawayStockRow = {
  id: number
  serial_number: string
  item_code: string
  item_name: string
  client_name: string
  warehouse_name: string
  status: string
  received_date: string
  age_days: number
  zone_layout_id: number | null
  current_bin_location: string
}

type AppliedFilters = {
  serial: string
  item: string
  clientId: string
  quickFilter: QuickFilter
}

type QuickFilter = "all" | "unassigned" | "aged" | "selected"

function getBinLabel(layout: ZoneLayoutOption) {
  return `${layout.zone_code}/${layout.rack_code}/${layout.bin_code}`
}

function getClientLabel(client: ClientOption) {
  const code = client.client_code?.trim()
  const name = client.client_name?.trim()
  if (code && name) return `${code} - ${name}`
  return name || code || `Client ${client.id}`
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
      {status.replace("_", " ")}
    </Badge>
  )
}

export default function TransferForm() {
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  const initialWarehouseId = searchParams.get("warehouse_id")?.trim() || ""
  const initialSerialFilter = searchParams.get("serial")?.trim() || ""
  const initialItemFilter = searchParams.get("item")?.trim() || ""
  const initialFromZoneLayoutId = searchParams.get("from_zone_layout_id")?.trim() || "all"

  const [warehouseId, setWarehouseId] = useState(initialWarehouseId)
  const [warehouseSearch, setWarehouseSearch] = useState<string | null>(null)
  const [serialFilter, setSerialFilter] = useState(initialSerialFilter)
  const [itemFilter, setItemFilter] = useState(initialItemFilter)
  const [clientSearch, setClientSearch] = useState("")
  const [clientId, setClientId] = useState("all")
  const [fromZoneLayoutId, setFromZoneLayoutId] = useState(initialFromZoneLayoutId)
  const [fromBinSearch, setFromBinSearch] = useState<string | null>(null)
  const [toZoneLayoutId, setToZoneLayoutId] = useState("")
  const [toBinSearch, setToBinSearch] = useState("")
  const [remarks, setRemarks] = useState("")
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all")
  const [applied, setApplied] = useState<AppliedFilters>({
    serial: initialSerialFilter,
    item: initialItemFilter,
    clientId: "all",
    quickFilter: "all",
  })
  const [selectedStockIds, setSelectedStockIds] = useState<number[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const clientsQuery = useQuery({
    queryKey: ["stock-putaway", "clients"],
    queryFn: async () => {
      const res = await apiClient.get<ClientOption[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const layoutsQuery = useQuery({
    queryKey: ["zone-layouts", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const res = await apiClient.get<ZoneLayoutOption[]>(
        `/zone-layouts?warehouse_id=${warehouseId}&is_active=true`
      )
      return res.data ?? []
    },
  })

  const stockQuery = useQuery({
    queryKey: ["stock", "putaway", warehouseId, applied.serial, applied.item, applied.clientId, fromZoneLayoutId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const params = new URLSearchParams({ warehouse_id: warehouseId })
      if (applied.serial) params.set("serial", applied.serial)
      if (applied.item) params.set("item", applied.item)
      if (applied.clientId !== "all") params.set("client_id", applied.clientId)
      if (fromZoneLayoutId !== "all") params.set("from_zone_layout_id", fromZoneLayoutId)

      const res = await apiClient.get<PutawayStockRow[]>(`/stock/putaway?${params.toString()}`)
      return res.data ?? []
    },
  })

  const warehouses = warehousesQuery.data ?? []
  const clients = clientsQuery.data ?? []
  const layouts = layoutsQuery.data ?? []
  const stockRows = useMemo(() => (stockQuery.data as PutawayStockRow[] | undefined) ?? [], [stockQuery.data])

  const warehouseSuggestions = useMemo(() => warehouses.map((warehouse) => warehouse.warehouse_name), [warehouses])
  const clientSuggestions = useMemo(() => clients.map(getClientLabel), [clients])
  const binSuggestions = useMemo(() => layouts.map(getBinLabel), [layouts])
  const initialWarehouseLabel = useMemo(() => {
    if (!initialWarehouseId) return ""
    return warehouses.find((warehouse) => String(warehouse.id) === initialWarehouseId)?.warehouse_name ?? ""
  }, [initialWarehouseId, warehouses])
  const initialFromBinLabel = useMemo(() => {
    if (!initialFromZoneLayoutId || initialFromZoneLayoutId === "all") return ""
    const match = layouts.find((layout) => String(layout.id) === initialFromZoneLayoutId)
    return match ? getBinLabel(match) : ""
  }, [initialFromZoneLayoutId, layouts])
  const destinationBin = useMemo(
    () => layouts.find((layout) => String(layout.id) === toZoneLayoutId),
    [layouts, toZoneLayoutId]
  )
  const destinationBinLabel = destinationBin ? getBinLabel(destinationBin) : ""
  const warehouseSearchValue = warehouseSearch ?? initialWarehouseLabel
  const fromBinSearchValue = fromBinSearch ?? initialFromBinLabel

  const resolveWarehouseId = (value: string) => {
    const normalized = value.trim().toLowerCase()
    const match = warehouses.find((warehouse) => warehouse.warehouse_name.trim().toLowerCase() === normalized)
    return match ? String(match.id) : ""
  }

  const resolveClientId = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return "all"

    const exactMatch = clients.find((client) => {
      const label = getClientLabel(client).toLowerCase()
      const name = client.client_name?.trim().toLowerCase()
      const code = client.client_code?.trim().toLowerCase()
      return label === normalized || name === normalized || code === normalized
    })
    return exactMatch ? String(exactMatch.id) : "all"
  }

  const resolveBinId = (value: string) => {
    const normalized = value.trim().toLowerCase()
    const match = layouts.find((layout) => getBinLabel(layout).toLowerCase() === normalized)
    return match ? String(match.id) : ""
  }

  const visibleRows = useMemo(() => {
    return stockRows.filter((row) => {
      if (applied.quickFilter === "unassigned") return !row.zone_layout_id
      if (applied.quickFilter === "aged") return Number(row.age_days) >= 30
      if (applied.quickFilter === "selected") return selectedStockIds.includes(row.id)
      return true
    })
  }, [applied.quickFilter, selectedStockIds, stockRows])

  const selectableRows = useMemo(
    () => visibleRows.filter((row) => !toZoneLayoutId || String(row.zone_layout_id || "") !== toZoneLayoutId),
    [toZoneLayoutId, visibleRows]
  )
  const selectedRows = useMemo(
    () => stockRows.filter((row) => selectedStockIds.includes(row.id)),
    [selectedStockIds, stockRows]
  )
  const selectedMoveRows = useMemo(
    () => selectedRows.filter((row) => !toZoneLayoutId || String(row.zone_layout_id || "") !== toZoneLayoutId),
    [selectedRows, toZoneLayoutId]
  )
  const sameDestinationCount = selectedRows.length - selectedMoveRows.length
  const canMove = Boolean(toZoneLayoutId) && selectedMoveRows.length > 0
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedStockIds.includes(row.id))

  const transferMutation = useMutation({
    mutationFn: async () =>
      apiClient.post("/stock/putaway", {
        stock_ids: selectedMoveRows.map((row) => row.id),
        to_zone_layout_id: Number(toZoneLayoutId),
        remarks: remarks || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["stock", "putaway"] })
      qc.invalidateQueries({ queryKey: ["stock", "search"] })
      qc.invalidateQueries({ queryKey: ["stock", "movements"] })
      setSelectedStockIds([])
      setRemarks("")
      setConfirmOpen(false)
      const moved = (res.data as { moved_count?: number } | undefined)?.moved_count ?? 0
      const attempted = selectedMoveRows.length
      const skipped = Math.max(0, attempted - moved)
      toast.success(
        skipped > 0
          ? `Put away completed for ${moved} serial(s); ${skipped} skipped.`
          : `Put away completed for ${moved} serial(s).`
      )
    },
    onError: (error) => handleError(error, "Put away transfer failed"),
  })

  const toggleSelection = (row: PutawayStockRow) => {
    const isSameDestination = toZoneLayoutId && String(row.zone_layout_id || "") === toZoneLayoutId
    if (isSameDestination) return
    setSelectedStockIds((prev) =>
      prev.includes(row.id) ? prev.filter((item) => item !== row.id) : [...prev, row.id]
    )
  }

  const toggleSelectVisible = () => {
    if (allVisibleSelected) {
      setSelectedStockIds((prev) => prev.filter((id) => !selectableRows.some((row) => row.id === id)))
      return
    }
    setSelectedStockIds((prev) => Array.from(new Set([...prev, ...selectableRows.map((row) => row.id)])))
  }

  const applyFilters = () => {
    const nextClientId = resolveClientId(clientSearch)
    setClientId(nextClientId)
    setApplied({
      serial: serialFilter.trim(),
      item: itemFilter.trim(),
      clientId: nextClientId,
      quickFilter,
    })
  }

  const resetFilters = () => {
    setSerialFilter("")
    setItemFilter("")
    setClientSearch("")
    setClientId("all")
    setQuickFilter("all")
    setApplied({ serial: "", item: "", clientId: "all", quickFilter: "all" })
  }

  const stepState = [
    { label: "Choose warehouse/bin", complete: Boolean(warehouseId && toZoneLayoutId) },
    { label: "Find stock", complete: stockRows.length > 0 },
    { label: "Select serials", complete: selectedMoveRows.length > 0 },
    { label: "Move stock", complete: false },
  ]

  return (
    <div className="space-y-5 pb-20">
      <div className="grid gap-3 lg:grid-cols-4">
        {stepState.map((step, index) => (
          <div
            key={step.label}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
          >
            <div className="flex items-center gap-3">
              <span
                className={
                  step.complete
                    ? "flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                    : "flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600"
                }
              >
                {step.complete ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-950 dark:text-slate-50">{step.label}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {step.complete ? "Ready" : "Pending"}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="border-b border-slate-100 pb-4 dark:border-slate-800">
          <CardTitle className="flex items-center gap-2 text-base">
            <PackageCheck className="h-4 w-4 text-blue-600" />
            Put Away Setup
          </CardTitle>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Select a warehouse, choose a destination bin, then search for stock to move.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 pt-5 lg:grid-cols-3">
          <div className="space-y-2">
            <Label>Warehouse *</Label>
            <TypeaheadInput
              value={warehouseSearchValue}
              onValueChange={(value) => {
                setWarehouseSearch(value)
                const nextWarehouseId = resolveWarehouseId(value)
                setWarehouseId(nextWarehouseId)
                setFromZoneLayoutId("all")
                setFromBinSearch("")
                setToZoneLayoutId("")
                setToBinSearch("")
                setSelectedStockIds([])
              }}
              suggestions={warehouseSuggestions}
              placeholder="Search warehouse"
            />
          </div>

          <div className="space-y-2">
            <Label>From Bin</Label>
            <TypeaheadInput
              value={fromBinSearchValue}
              onValueChange={(value) => {
                setFromBinSearch(value)
                setFromZoneLayoutId(value.trim() ? resolveBinId(value) || "all" : "all")
              }}
              suggestions={binSuggestions}
              placeholder="Any source bin"
              disabled={!warehouseId}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>To Bin *</Label>
              {!toZoneLayoutId && <span className="text-xs font-medium text-rose-600">Required</span>}
            </div>
            <TypeaheadInput
              value={toBinSearch}
              onValueChange={(value) => {
                setToBinSearch(value)
                setToZoneLayoutId(resolveBinId(value))
                setSelectedStockIds([])
              }}
              suggestions={binSuggestions}
              placeholder="Search destination bin"
              disabled={!warehouseId}
              className={!toZoneLayoutId ? "border-rose-200 bg-rose-50/40" : ""}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="h-4 w-4 text-slate-500" />
              Stock Finder
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Filter stock by serial, item, client, and operational shortcuts.
            </p>
          </div>
          <Badge variant="outline">{visibleRows.length} visible</Badge>
        </CardHeader>
        <CardContent className="grid gap-4 pt-5 lg:grid-cols-4">
          <div className="space-y-2">
            <Label>Serial Filter</Label>
            <TypeaheadInput
              value={serialFilter}
              onValueChange={setSerialFilter}
              suggestions={stockRows.map((row) => row.serial_number)}
              placeholder="Search serial"
            />
          </div>
          <div className="space-y-2">
            <Label>Item Filter</Label>
            <TypeaheadInput
              value={itemFilter}
              onValueChange={setItemFilter}
              suggestions={stockRows.flatMap((row) => [row.item_code, row.item_name])}
              placeholder="Item code/name"
            />
          </div>
          <div className="space-y-2">
            <Label>Client Filter</Label>
            <TypeaheadInput
              value={clientSearch}
              onValueChange={(value) => {
                setClientSearch(value)
                setClientId(resolveClientId(value))
              }}
              suggestions={clientSuggestions}
              maxSuggestions={100}
              placeholder="Search client"
            />
          </div>
          <div className="space-y-2">
            <Label>Remarks</Label>
            <Input
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Reason for movement"
            />
          </div>
          <div className="flex flex-wrap gap-2 lg:col-span-4">
            {[
              ["all", "All stock"],
              ["unassigned", "Unassigned only"],
              ["aged", "Recently aged"],
              ["selected", "Selected only"],
            ].map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={quickFilter === value ? "default" : "outline"}
                onClick={() => setQuickFilter(value as QuickFilter)}
              >
                {label}
              </Button>
            ))}
            <Button type="button" variant="outline" className="ml-auto" onClick={applyFilters} disabled={!warehouseId}>
              <Search className="mr-2 h-4 w-4" />
              Search Stock
            </Button>
            <Button type="button" variant="outline" onClick={resetFilters}>
              <X className="mr-2 h-4 w-4" />
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {!toZoneLayoutId && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-semibold">Destination bin is required before moving stock.</p>
            <p>Select the To Bin first so rows already in that bin can be protected from accidental moves.</p>
          </div>
        </div>
      )}

      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div>
            <CardTitle className="text-base">Available Stock</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {stockQuery.isLoading
                ? "Loading serials..."
                : `${visibleRows.length} visible serials, ${selectedMoveRows.length} selected for movement`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={toggleSelectVisible} disabled={selectableRows.length === 0}>
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setSelectedStockIds([])} disabled={selectedStockIds.length === 0}>
              Clear selection
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {stockQuery.isLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading stock
            </div>
          ) : (
            <div className="max-h-[560px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-slate-50 shadow-sm dark:bg-slate-900">
                  <TableRow>
                    <TableHead className="w-[48px]">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectVisible} />
                    </TableHead>
                    <TableHead>Serial</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Current Bin</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => {
                    const selected = selectedStockIds.includes(row.id)
                    const sameDestination = Boolean(toZoneLayoutId && String(row.zone_layout_id || "") === toZoneLayoutId)
                    return (
                      <TableRow
                        key={row.id}
                        className={
                          selected
                            ? "bg-blue-50 hover:bg-blue-50 dark:bg-blue-950/30"
                            : "hover:bg-slate-50 dark:hover:bg-slate-900/70"
                        }
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={sameDestination}
                            title={sameDestination ? "Already in destination bin" : "Select serial"}
                            onChange={() => toggleSelection(row)}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{row.serial_number}</TableCell>
                        <TableCell className="min-w-56">
                          <div className="font-medium text-slate-950 dark:text-slate-50">{row.item_name}</div>
                          <div className="text-xs text-slate-500">{row.item_code}</div>
                        </TableCell>
                        <TableCell className="min-w-40">{row.client_name}</TableCell>
                        <TableCell className="min-w-48">{row.warehouse_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">
                            {row.current_bin_location}
                          </Badge>
                          {sameDestination && (
                            <div className="mt-1 text-xs text-amber-600">Already in destination</div>
                          )}
                        </TableCell>
                        <TableCell><StatusBadge status={row.status} /></TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(row.received_date)}</TableCell>
                        <TableCell className="text-right">{row.age_days}d</TableCell>
                      </TableRow>
                    )
                  })}
                  {visibleRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="py-12 text-center text-sm text-slate-500">
                        {warehouseId
                          ? "No stock found. Adjust filters or clear quick filters to broaden the search."
                          : "Choose a warehouse and destination bin, then search stock to begin."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedStockIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-6 py-3 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
            <ClipboardCheck className="h-5 w-5 text-blue-600" />
            <div>
              <p className="text-sm font-semibold text-slate-950 dark:text-slate-50">
                {selectedMoveRows.length} selected for movement
              </p>
              <p className="text-xs text-slate-500">
                Destination: {destinationBinLabel || "Select destination bin"}
                {sameDestinationCount > 0 ? ` · ${sameDestinationCount} skipped because already in destination` : ""}
              </p>
            </div>
            <Button type="button" variant="outline" className="ml-auto" onClick={() => setSelectedStockIds([])}>
              Clear selection
            </Button>
            <Button
              type="button"
              className="bg-blue-600 hover:bg-blue-700"
              disabled={!canMove || transferMutation.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              Move Selected
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm put away movement</DialogTitle>
            <DialogDescription>
              {selectedMoveRows.length} serial(s) will be moved to {destinationBinLabel || "the selected bin"}.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-slate-50 p-3 text-sm dark:bg-slate-900">
            <p className="font-medium">Movement summary</p>
            <p className="mt-1 text-slate-600 dark:text-slate-300">
              Source: {fromBinSearch || "Mixed source bins"} · Destination: {destinationBinLabel}
            </p>
            {sameDestinationCount > 0 && (
              <p className="mt-2 text-amber-700">{sameDestinationCount} selected serial(s) are already in the destination bin and will be skipped.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              disabled={transferMutation.isPending || !canMove}
              onClick={() => transferMutation.mutate()}
            >
              {transferMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirm Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
