"use client"

import { useMemo, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  MapPin,
  MoreHorizontal,
  Route,
  Plus,
  Search,
  Upload,
  Warehouse,
  X,
} from "lucide-react"
import * as XLSX from "xlsx"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { exportWarehouseTemplateToExcel, exportWarehousesToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TypeaheadInput } from "@/components/ui/typeahead-input"

type WarehouseRow = {
  id: number
  warehouse_code: string
  warehouse_name: string
  city?: string
  state?: string
  pincode?: string
  latitude?: number | string | null
  longitude?: number | string | null
  is_active: boolean
  created_at?: string | null
  updated_at?: string | null
  warehouse_type?: string
  manager_name?: string
  region_tag?: string
  total_zones?: number
  active_skus?: number
  open_grns?: number
  stock_value?: number | string
  capacity_total_units?: number
  capacity_used_units?: number
  capacity_used_pct?: number
  client_breakdown?: Array<{ client_name: string; units: number }>
}

type StatusFilter = "all" | "active" | "inactive" | "mapped" | "missing-coordinates" | "layout-missing"
type SortKey = "warehouse_code" | "warehouse_name" | "city" | "state" | "is_active" | "total_zones" | "active_skus"

const WarehouseLocationMap = dynamic(
  () => import("@/components/admin/WarehouseLocationMap"),
  { ssr: false }
)

const WAREHOUSES_PER_PAGE = 12

function blankForm() {
  return {
    warehouse_code: "",
    warehouse_name: "",
    city: "",
    state: "",
    pincode: "",
    latitude: "",
    longitude: "",
    is_active: true,
  }
}

function toNumber(value: unknown) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function hasCoordinates(warehouse: WarehouseRow) {
  const lat = Number(warehouse.latitude)
  const lng = Number(warehouse.longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

function coordinateStatus(warehouse: WarehouseRow) {
  return hasCoordinates(warehouse) ? "Mapped" : "Missing Coordinates"
}

function computeCapacityPct(warehouse: WarehouseRow) {
  const used = toNumber(warehouse.capacity_used_units)
  const total = toNumber(warehouse.capacity_total_units)
  if (total > 0) return Math.max(0, Math.min(100, (used / total) * 100))
  return Math.max(0, Math.min(100, toNumber(warehouse.capacity_used_pct)))
}

function formatInr(value: unknown) {
  const amount = toNumber(value)
  if (amount >= 10000000) return `INR ${(amount / 10000000).toFixed(1)} Cr`
  if (amount >= 100000) return `INR ${(amount / 100000).toFixed(1)} L`
  return `INR ${Math.round(amount).toLocaleString("en-IN")}`
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function directionsUrl(warehouse: WarehouseRow, destination: string) {
  const origin = hasCoordinates(warehouse)
    ? `${warehouse.latitude},${warehouse.longitude}`
    : [warehouse.warehouse_name, warehouse.city, warehouse.state, warehouse.pincode].filter(Boolean).join(", ")
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`
}

function parseLatLng(value: string) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null
  }
  return { lat, lng }
}

function calculateDistanceKm(warehouse: WarehouseRow, destination: string) {
  if (!hasCoordinates(warehouse)) return null
  const destinationPoint = parseLatLng(destination)
  if (!destinationPoint) return null

  const lat1 = Number(warehouse.latitude) * (Math.PI / 180)
  const lat2 = destinationPoint.lat * (Math.PI / 180)
  const deltaLat = (destinationPoint.lat - Number(warehouse.latitude)) * (Math.PI / 180)
  const deltaLng = (destinationPoint.lng - Number(warehouse.longitude)) * (Math.PI / 180)
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return 6371 * c
}

function readinessWarnings(warehouse: WarehouseRow) {
  return [
    !hasCoordinates(warehouse) ? "Missing coordinates" : "",
    toNumber(warehouse.total_zones) <= 0 ? "Zone layout missing" : "",
    !warehouse.manager_name || warehouse.manager_name === "Unassigned" ? "Manager unassigned" : "",
    !warehouse.city || !warehouse.state ? "Location incomplete" : "",
  ].filter(Boolean)
}

export default function WarehousesPage() {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const warehousesQuery = useAdminResource("warehouses")
  const saveMutation = useSaveAdminResource("warehouses")
  const deleteMutation = useDeleteAdminResource("warehouses")

  const [viewMode, setViewMode] = useState<"list" | "map">("list")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [regionFilter, setRegionFilter] = useState("all")
  const [stateFilter, setStateFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("warehouse_name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editWarehouse, setEditWarehouse] = useState<WarehouseRow | null>(null)
  const [detailsWarehouse, setDetailsWarehouse] = useState<WarehouseRow | null>(null)
  const [actionWarehouse, setActionWarehouse] = useState<WarehouseRow | null>(null)
  const [deactivateWarehouse, setDeactivateWarehouse] = useState<WarehouseRow | null>(null)
  const [distanceWarehouse, setDistanceWarehouse] = useState<WarehouseRow | null>(null)
  const [destinationPin, setDestinationPin] = useState("")
  const [form, setForm] = useState(blankForm)

  const warehouses = (warehousesQuery.data as WarehouseRow[] | undefined) ?? []
  const selectedWarehouses = warehouses.filter((warehouse) => selectedIds.includes(warehouse.id))
  const searchSuggestions = useMemo(
    () =>
      warehouses.flatMap((warehouse) => [
        warehouse.warehouse_name,
        warehouse.warehouse_code,
        warehouse.city || "",
        warehouse.state || "",
        warehouse.manager_name || "",
        warehouse.region_tag || "",
      ]),
    [warehouses]
  )
  const regionOptions = useMemo(
    () => Array.from(new Set(warehouses.map((warehouse) => warehouse.region_tag).filter(Boolean))) as string[],
    [warehouses]
  )
  const stateOptions = useMemo(
    () => Array.from(new Set(warehouses.map((warehouse) => warehouse.state).filter(Boolean))) as string[],
    [warehouses]
  )

  const duplicateWarnings = useMemo(() => {
    const code = form.warehouse_code.trim().toLowerCase()
    const name = form.warehouse_name.trim().toLowerCase()
    return warehouses
      .filter((warehouse) => warehouse.id !== editWarehouse?.id)
      .flatMap((warehouse) => [
        code && warehouse.warehouse_code.trim().toLowerCase() === code ? "Warehouse code already exists" : "",
        name && warehouse.warehouse_name.trim().toLowerCase() === name ? "Warehouse name already exists" : "",
      ])
      .filter(Boolean)
  }, [editWarehouse, form.warehouse_code, form.warehouse_name, warehouses])

  const metrics = useMemo(() => {
    const active = warehouses.filter((warehouse) => warehouse.is_active).length
    const mapped = warehouses.filter(hasCoordinates).length
    return {
      active,
      inactive: warehouses.length - active,
      mapped,
      missingCoordinates: warehouses.length - mapped,
      layoutConfigured: warehouses.filter((warehouse) => toNumber(warehouse.total_zones) > 0).length,
      totalZones: warehouses.reduce((sum, warehouse) => sum + toNumber(warehouse.total_zones), 0),
    }
  }, [warehouses])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = warehouses.filter((warehouse) => {
      const matchesSearch =
        !q ||
        [
          warehouse.warehouse_name,
          warehouse.warehouse_code,
          warehouse.city,
          warehouse.state,
          warehouse.manager_name,
          warehouse.region_tag,
        ].some((value) => String(value || "").toLowerCase().includes(q))
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && warehouse.is_active) ||
        (statusFilter === "inactive" && !warehouse.is_active) ||
        (statusFilter === "mapped" && hasCoordinates(warehouse)) ||
        (statusFilter === "missing-coordinates" && !hasCoordinates(warehouse)) ||
        (statusFilter === "layout-missing" && toNumber(warehouse.total_zones) <= 0)
      const matchesRegion = regionFilter === "all" || warehouse.region_tag === regionFilter
      const matchesState = !stateFilter || warehouse.state === stateFilter
      return matchesSearch && matchesStatus && matchesRegion && matchesState
    })

    return [...rows].sort((a, b) => {
      const leftRaw = a[sortKey]
      const rightRaw = b[sortKey]
      const left = typeof leftRaw === "number" ? leftRaw : String(leftRaw ?? "").toLowerCase()
      const right = typeof rightRaw === "number" ? rightRaw : String(rightRaw ?? "").toLowerCase()
      const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right))
      return sortDir === "asc" ? result : -result
    })
  }, [regionFilter, search, sortDir, sortKey, stateFilter, statusFilter, warehouses])

  const totalPages = Math.max(1, Math.ceil(filtered.length / WAREHOUSES_PER_PAGE))
  const effectivePage = Math.min(currentPage, totalPages)
  const paginatedWarehouses = filtered.slice((effectivePage - 1) * WAREHOUSES_PER_PAGE, effectivePage * WAREHOUSES_PER_PAGE)
  const allVisibleSelected = paginatedWarehouses.length > 0 && paginatedWarehouses.every((warehouse) => selectedIds.includes(warehouse.id))

  const activeWarehouses = warehouses.filter((warehouse) => warehouse.is_active)

  const openCreate = () => {
    setEditWarehouse(null)
    setForm(blankForm())
    setIsDialogOpen(true)
  }

  const openEdit = (warehouse: WarehouseRow) => {
    setEditWarehouse(warehouse)
    setForm({
      warehouse_code: warehouse.warehouse_code,
      warehouse_name: warehouse.warehouse_name,
      city: warehouse.city || "",
      state: warehouse.state || "",
      pincode: warehouse.pincode || "",
      latitude: warehouse.latitude != null ? String(warehouse.latitude) : "",
      longitude: warehouse.longitude != null ? String(warehouse.longitude) : "",
      is_active: warehouse.is_active,
    })
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.warehouse_code || !form.warehouse_name || duplicateWarnings.length > 0) return
    const payload = editWarehouse ? { id: editWarehouse.id, ...form } : form
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir("asc")
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const toggleVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !paginatedWarehouses.some((warehouse) => warehouse.id === id)))
      return
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...paginatedWarehouses.map((warehouse) => warehouse.id)])))
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setRegionFilter("all")
    setStateFilter("")
    setCurrentPage(1)
  }

  const handleImport = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    for (const row of rows) {
      const payload = {
        warehouse_code: String(row["Warehouse Code"] || "").trim().toUpperCase(),
        warehouse_name: String(row["Warehouse Name"] || "").trim(),
        city: String(row.City || "").trim(),
        state: String(row.State || "").trim(),
        pincode: String(row.Pincode || "").trim(),
        latitude: String(row.Latitude || "").trim(),
        longitude: String(row.Longitude || "").trim(),
        is_active: String(row.Status || "Active").toLowerCase() !== "inactive",
      }
      if (payload.warehouse_code && payload.warehouse_name) {
        await saveMutation.mutateAsync(payload)
      }
    }
    if (importInputRef.current) importInputRef.current.value = ""
  }

  return (
    <div className="w-full space-y-6 overflow-x-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Warehouse Management</h1>
          <p className="mt-1 text-gray-500">Manage warehouse locations, readiness, layout, and operating health</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleImport(file)
            }}
          />
          <Button asChild variant="outline"><Link href="/admin/zone-layouts">Zone Layout</Link></Button>
          <Button variant="outline" onClick={() => exportWarehouseTemplateToExcel()}><FileSpreadsheet className="mr-2 h-4 w-4" />Template</Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Import</Button>
          <Button variant="outline" onClick={() => exportWarehousesToExcel(filtered)}><Download className="mr-2 h-4 w-4" />Export</Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Warehouse</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Metric icon={<Warehouse className="h-4 w-4" />} label="Total" value={warehouses.length} />
        <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={metrics.active} tone="green" />
        <Metric icon={<MapPin className="h-4 w-4" />} label="Mapped" value={metrics.mapped} />
        <Metric icon={<AlertTriangle className="h-4 w-4" />} label="Missing Coordinates" value={metrics.missingCoordinates} tone="amber" />
        <Metric icon={<Boxes className="h-4 w-4" />} label="Layout Configured" value={metrics.layoutConfigured} />
        <Metric icon={<Boxes className="h-4 w-4" />} label="Zones/Bins" value={metrics.totalZones} />
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            {[
              ["all", "All"],
              ["active", "Active"],
              ["inactive", "Inactive"],
              ["mapped", "Mapped"],
              ["missing-coordinates", "Missing Coordinates"],
              ["layout-missing", "Layout Missing"],
            ].map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={statusFilter === value ? "default" : "outline"}
                onClick={() => {
                  setStatusFilter(value as StatusFilter)
                  setCurrentPage(1)
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-2 xl:col-span-2">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <TypeaheadInput
                  className="pl-9"
                  value={search}
                  onValueChange={(value) => {
                    setSearch(value)
                    setCurrentPage(1)
                  }}
                  suggestions={searchSuggestions}
                  placeholder="Code, name, city, state, manager, region"
                />
              </div>
            </div>
            <FilterSelect label="Region" value={regionFilter} onChange={setRegionFilter} options={regionOptions.map((region) => ({ value: region, label: region }))} />
            <div className="space-y-2">
              <Label>State</Label>
              <TypeaheadInput value={stateFilter} onValueChange={(value) => { setStateFilter(value); setCurrentPage(1) }} suggestions={stateOptions} placeholder="All states" />
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={clearFilters}><X className="mr-2 h-4 w-4" />Clear</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-blue-900">{selectedIds.length} warehouse(s) selected</p>
          <Button size="sm" variant="outline" onClick={() => exportWarehousesToExcel(selectedWarehouses)}>Export selected</Button>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>Clear selection</Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant={viewMode === "list" ? "default" : "outline"} onClick={() => setViewMode("list")}>List</Button>
        <Button variant={viewMode === "map" ? "default" : "outline"} onClick={() => setViewMode("map")}>Map</Button>
      </div>

      {viewMode === "map" && (
        <Card>
          <CardContent className="pt-6">
            <WarehouseLocationMap
              warehouses={activeWarehouses}
              onSelectWarehouse={(warehouseId) => {
                const selected = warehouses.find((warehouse) => warehouse.id === warehouseId)
                if (selected) setDetailsWarehouse(selected)
              }}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b p-4">
            <div>
              <p className="font-semibold">Warehouse Directory</p>
              <p className="text-sm text-slate-500">
                Showing {filtered.length === 0 ? 0 : (effectivePage - 1) * WAREHOUSES_PER_PAGE + 1}-{Math.min(effectivePage * WAREHOUSES_PER_PAGE, filtered.length)} of {filtered.length}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={toggleVisible}>
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </Button>
          </div>
          <div className="max-h-[620px] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-white">
                <TableRow className="bg-gray-50">
                  <TableHead className="w-[44px]"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /></TableHead>
                  <SortableHead label="Code" active={sortKey === "warehouse_code"} dir={sortDir} onClick={() => sortBy("warehouse_code")} />
                  <SortableHead label="Warehouse" active={sortKey === "warehouse_name"} dir={sortDir} onClick={() => sortBy("warehouse_name")} />
                  <SortableHead label="City" active={sortKey === "city"} dir={sortDir} onClick={() => sortBy("city")} />
                  <TableHead>Coordinates</TableHead>
                  <TableHead>Readiness</TableHead>
                  <TableHead>Operations</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Client Mix</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedWarehouses.map((warehouse) => {
                  const warnings = readinessWarnings(warehouse)
                  const capacityPct = computeCapacityPct(warehouse)
                  return (
                    <TableRow key={warehouse.id} className="hover:bg-blue-50/40">
                      <TableCell><input type="checkbox" checked={selectedIds.includes(warehouse.id)} onChange={() => toggleSelect(warehouse.id)} /></TableCell>
                      <TableCell className="font-mono font-semibold">{warehouse.warehouse_code}</TableCell>
                      <TableCell className="min-w-64">
                        <button className="flex items-center gap-2 text-left" onClick={() => setDetailsWarehouse(warehouse)}>
                          <Warehouse className="h-4 w-4 text-slate-400" />
                          <span className="font-medium">{warehouse.warehouse_name}</span>
                        </button>
                        <div className="mt-1 text-xs text-slate-500">{warehouse.manager_name || "Manager unassigned"}</div>
                      </TableCell>
                      <TableCell>{[warehouse.city, warehouse.state].filter(Boolean).join(", ") || "-"}</TableCell>
                      <TableCell>
                        <CoordinateBadge warehouse={warehouse} />
                        <button
                          type="button"
                          className="mt-1 block text-xs text-blue-700 hover:underline"
                          onClick={() => {
                            setDistanceWarehouse(warehouse)
                            setDestinationPin("")
                          }}
                        >
                          Pin-to-pin distance
                        </button>
                      </TableCell>
                      <TableCell className="min-w-52">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className={warnings.length === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                            {warnings.length === 0 ? "Ready" : `${warnings.length} issue(s)`}
                          </Badge>
                          {warnings.slice(0, 2).map((warning) => (
                            <Badge key={warning} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{warning}</Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-44 text-sm">
                        Zones {toNumber(warehouse.total_zones).toLocaleString("en-IN")}<br />
                        SKUs {toNumber(warehouse.active_skus).toLocaleString("en-IN")} · GRNs {toNumber(warehouse.open_grns).toLocaleString("en-IN")}
                      </TableCell>
                      <TableCell className="min-w-44">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span>{toNumber(warehouse.capacity_used_units).toLocaleString("en-IN")} / {toNumber(warehouse.capacity_total_units).toLocaleString("en-IN")}</span>
                          <span className="font-semibold">{capacityPct.toFixed(1)}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-200">
                          <div className="h-2 rounded-full bg-blue-600" style={{ width: `${capacityPct}%` }} />
                        </div>
                      </TableCell>
                      <TableCell className="min-w-48">
                        {(warehouse.client_breakdown ?? []).length > 0 ? (
                          <div className="space-y-1">
                            {(warehouse.client_breakdown ?? []).slice(0, 3).map((client) => (
                              <div key={`${warehouse.id}-${client.client_name}`} className="flex justify-between gap-2 text-xs">
                                <span className="truncate">{client.client_name}</span>
                                <span className="font-medium">{client.units}</span>
                              </div>
                            ))}
                          </div>
                        ) : <span className="text-xs text-slate-500">No client stock</span>}
                      </TableCell>
                      <TableCell>
                        <Badge className={warehouse.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                          {warehouse.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon-sm" onClick={() => setActionWarehouse(warehouse)} aria-label={`Actions for ${warehouse.warehouse_name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-12 text-center text-sm text-slate-500">
                      No warehouses found. Add or import a warehouse to begin.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {filtered.length > 0 && (
            <div className="flex items-center justify-between border-t p-4">
              <p className="text-sm text-gray-600">Page {effectivePage} of {totalPages}</p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={effectivePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</Button>
                <Button variant="outline" size="sm" disabled={effectivePage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!actionWarehouse} onOpenChange={(open) => !open && setActionWarehouse(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Warehouse Actions</DialogTitle>
            <DialogDescription>{actionWarehouse?.warehouse_name}</DialogDescription>
          </DialogHeader>
          {actionWarehouse && (
            <div className="grid gap-2">
              <Button variant="outline" onClick={() => { setDetailsWarehouse(actionWarehouse); setActionWarehouse(null) }}><Eye className="mr-2 h-4 w-4" />View Details</Button>
              <Button variant="outline" onClick={() => { openEdit(actionWarehouse); setActionWarehouse(null) }}>Edit</Button>
              <Button asChild variant="outline" onClick={() => setActionWarehouse(null)}><Link href="/admin/zone-layouts">Configure Zone Layout</Link></Button>
              <Button asChild variant="outline" onClick={() => setActionWarehouse(null)}><Link href={`/stock/search?warehouse_id=${actionWarehouse.id}`}>View Stock</Link></Button>
              <Button asChild variant="outline" onClick={() => setActionWarehouse(null)}><Link href="/gate/in">View Gate Logs</Link></Button>
              <Button variant="outline" onClick={() => { setDistanceWarehouse(actionWarehouse); setDestinationPin(""); setActionWarehouse(null) }}><Route className="mr-2 h-4 w-4" />Pin-to-pin Distance</Button>
              <Button variant="outline" className="text-rose-600" onClick={() => { setDeactivateWarehouse(actionWarehouse); setActionWarehouse(null) }}>Deactivate</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!distanceWarehouse} onOpenChange={(open) => !open && setDistanceWarehouse(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Pin-to-pin distance</DialogTitle>
            <DialogDescription>
              Calculate or open directions from {distanceWarehouse?.warehouse_name} to a client/customer location.
            </DialogDescription>
          </DialogHeader>
          {distanceWarehouse && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-slate-50 p-3 text-sm">
                <p className="font-medium">Origin</p>
                <p className="mt-1 text-slate-600">
                  {hasCoordinates(distanceWarehouse)
                    ? `${distanceWarehouse.latitude}, ${distanceWarehouse.longitude}`
                    : [distanceWarehouse.warehouse_name, distanceWarehouse.city, distanceWarehouse.state, distanceWarehouse.pincode].filter(Boolean).join(", ")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Client / Customer Pin or Address</Label>
                <Input
                  value={destinationPin}
                  onChange={(event) => setDestinationPin(event.target.value)}
                  placeholder="e.g. 13.0674, 80.2376 or customer address"
                />
                <p className="text-xs text-slate-500">
                  Enter `latitude, longitude` for straight-line distance, or an address to open route directions.
                </p>
              </div>
              {calculateDistanceKm(distanceWarehouse, destinationPin) !== null && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                  Approx. straight-line distance: {calculateDistanceKm(distanceWarehouse, destinationPin)?.toFixed(2)} km
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDistanceWarehouse(null)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              disabled={!distanceWarehouse || !destinationPin.trim()}
              onClick={() => {
                if (!distanceWarehouse || !destinationPin.trim()) return
                window.open(directionsUrl(distanceWarehouse, destinationPin.trim()), "_blank", "noopener,noreferrer")
              }}
            >
              <Route className="mr-2 h-4 w-4" />
              Open Route
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deactivateWarehouse} onOpenChange={(open) => !open && setDeactivateWarehouse(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate warehouse?</DialogTitle>
            <DialogDescription>This keeps history intact and removes the warehouse from active operations.</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Check stock, assigned users, active clients, open GRNs/DOs, and configured zones before deactivating {deactivateWarehouse?.warehouse_name}.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateWarehouse(null)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => {
              if (deactivateWarehouse) deleteMutation.mutate(deactivateWarehouse.id)
              setDeactivateWarehouse(null)
            }}>Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailsWarehouse} onOpenChange={(open) => !open && setDetailsWarehouse(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-3rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{detailsWarehouse?.warehouse_name}</DialogTitle>
            <DialogDescription>{detailsWarehouse?.warehouse_code}</DialogDescription>
          </DialogHeader>
          {detailsWarehouse && <WarehouseDetails warehouse={detailsWarehouse} />}
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editWarehouse ? "Edit Warehouse" : "Add Warehouse"}</DialogTitle>
            <DialogDescription>{editWarehouse ? "Update warehouse profile and coordinates." : "Create a warehouse profile."}</DialogDescription>
          </DialogHeader>
          {duplicateWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {Array.from(new Set(duplicateWarnings)).join(", ")}
            </div>
          )}
          <div className="grid gap-4 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Code *" value={form.warehouse_code} onChange={(value) => setForm({ ...form, warehouse_code: value.toUpperCase() })} />
              <Field label="Warehouse Name *" value={form.warehouse_name} onChange={(value) => setForm({ ...form, warehouse_name: value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="City" value={form.city} onChange={(value) => setForm({ ...form, city: value })} />
              <Field label="State" value={form.state} onChange={(value) => setForm({ ...form, state: value })} />
            </div>
            <Field label="Pincode" value={form.pincode} onChange={(value) => setForm({ ...form, pincode: value })} />
            <div className="grid grid-cols-2 gap-4">
              <Field label="Latitude" value={form.latitude} onChange={(value) => setForm({ ...form, latitude: value })} />
              <Field label="Longitude" value={form.longitude} onChange={(value) => setForm({ ...form, longitude: value })} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.is_active ? "active" : "inactive"} onValueChange={(value) => setForm({ ...form, is_active: value === "active" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700" disabled={duplicateWarnings.length > 0 || saveMutation.isPending}>
              Save Warehouse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({ icon, label, value, tone = "blue" }: { icon: ReactNode; label: string; value: number; tone?: "blue" | "green" | "amber" | "rose" }) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    rose: "bg-rose-50 text-rose-600",
  }[tone]
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-600">{label}</p>
          <span className={`rounded-md p-2 ${toneClass}`}>{icon}</span>
        </div>
        <p className="mt-3 text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function SortableHead({ label, active, dir, onClick }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  return (
    <TableHead>
      <button type="button" className="font-semibold hover:text-blue-700" onClick={onClick}>
        {label}{active ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </TableHead>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function CoordinateBadge({ warehouse }: { warehouse: WarehouseRow }) {
  const mapped = hasCoordinates(warehouse)
  return (
    <Badge variant="outline" className={mapped ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
      {coordinateStatus(warehouse)}
    </Badge>
  )
}

function WarehouseDetails({ warehouse }: { warehouse: WarehouseRow }) {
  const warnings = readinessWarnings(warehouse)
  const capacityPct = computeCapacityPct(warehouse)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge className={warehouse.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{warehouse.is_active ? "Active" : "Inactive"}</Badge>
        <CoordinateBadge warehouse={warehouse} />
        <Badge variant="outline" className={warnings.length === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
          {warnings.length === 0 ? "Ready" : `${warnings.length} setup issue(s)`}
        </Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Detail title="Profile" rows={[
          ["Code", warehouse.warehouse_code],
          ["Name", warehouse.warehouse_name],
          ["Type", warehouse.warehouse_type || "Secondary"],
          ["Region", warehouse.region_tag || "Unassigned"],
          ["Manager", warehouse.manager_name || "Unassigned"],
          ["Created", formatDate(warehouse.created_at)],
          ["Updated", formatDate(warehouse.updated_at)],
        ]} />
        <Detail title="Location" rows={[
          ["City", warehouse.city || "-"],
          ["State", warehouse.state || "-"],
          ["Pincode", warehouse.pincode || "-"],
          ["Coordinates", hasCoordinates(warehouse) ? `${warehouse.latitude}, ${warehouse.longitude}` : "Missing"],
        ]} />
        <Detail title="Operational KPIs" rows={[
          ["Zones/Bins", toNumber(warehouse.total_zones).toLocaleString("en-IN")],
          ["Active SKUs", toNumber(warehouse.active_skus).toLocaleString("en-IN")],
          ["Open GRNs", toNumber(warehouse.open_grns).toLocaleString("en-IN")],
          ["Stock Value", formatInr(warehouse.stock_value)],
          ["Capacity", `${capacityPct.toFixed(1)}% used`],
        ]} />
        <Detail title="Setup Checklist" rows={[
          ["Profile", warehouse.warehouse_code && warehouse.warehouse_name ? "Configured" : "Missing"],
          ["Coordinates", hasCoordinates(warehouse) ? "Mapped" : "Missing"],
          ["Zones", toNumber(warehouse.total_zones) > 0 ? "Configured" : "Missing"],
          ["Users", warehouse.manager_name && warehouse.manager_name !== "Unassigned" ? "Assigned" : "Missing"],
          ["Clients", (warehouse.client_breakdown ?? []).length > 0 ? "Stock linked" : "No active stock"],
        ]} />
      </div>
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Setup warnings: {warnings.join(", ")}
        </div>
      )}
    </div>
  )
}

function Detail({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="mb-3 text-sm font-semibold uppercase text-slate-500">{title}</p>
      <div className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
            <span className="text-slate-500">{label}</span>
            <span className="min-w-0 break-words font-medium">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
