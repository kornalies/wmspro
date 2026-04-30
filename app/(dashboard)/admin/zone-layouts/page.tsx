"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  Archive,
  Boxes,
  Building2,
  CheckCircle2,
  Copy,
  Download,
  Edit,
  FileSpreadsheet,
  Grid3X3,
  Layers3,
  Package,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { exportZoneLayoutsToExcel, exportZoneLayoutTemplateToExcel } from "@/lib/export-utils"
import { useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

type ZoneLayoutRow = {
  id: number
  warehouse_id: number
  warehouse_name?: string
  zone_code: string
  zone_name: string
  rack_code: string
  rack_name: string
  bin_code: string
  bin_name: string
  capacity_units?: number | null
  stock_count?: number | null
  sort_order?: number
  is_active: boolean
}

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type FilterKey = "all" | "active" | "inactive" | "missing_capacity" | "with_stock"
type ViewMode = "table" | "hierarchy"

const emptyForm = {
  warehouse_id: "",
  zone_code: "",
  zone_name: "",
  rack_code: "",
  rack_name: "",
  bin_code: "",
  bin_name: "",
  capacity_units: "",
  sort_order: "0",
}

const field = (value: unknown, fallback = "-") => {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  return text.length ? text : fallback
}

const normalize = (value: string) => value.trim().toUpperCase()

export default function ZoneLayoutsPage() {
  const saveMutation = useSaveAdminResource("zone-layouts")
  const deleteMutation = useDeleteAdminResource("zone-layouts")

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const [search, setSearch] = useState("")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [zoneFilter, setZoneFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState<FilterKey>("all")
  const [viewMode, setViewMode] = useState<ViewMode>("table")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<ZoneLayoutRow | null>(null)
  const [detailRow, setDetailRow] = useState<ZoneLayoutRow | null>(null)
  const [form, setForm] = useState(emptyForm)

  const layoutsQuery = useQuery({
    queryKey: ["admin", "zone-layouts", warehouseFilter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (warehouseFilter !== "all") params.set("warehouse_id", warehouseFilter)
      const query = params.toString()
      const res = await apiClient.get<ZoneLayoutRow[]>(`/zone-layouts${query ? `?${query}` : ""}`)
      return res.data ?? []
    },
  })

  const rows = useMemo(() => layoutsQuery.data ?? [], [layoutsQuery.data])
  const warehouses = useMemo(() => warehousesQuery.data ?? [], [warehousesQuery.data])
  const warehouseMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.warehouse_name])), [warehouses])

  const zones = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of rows) map.set(row.zone_code, `${row.zone_code} - ${row.zone_name}`)
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  const metrics = useMemo(() => {
    const warehouseCount = new Set(rows.map((row) => row.warehouse_id)).size
    const zoneCount = new Set(rows.map((row) => `${row.warehouse_id}:${row.zone_code}`)).size
    const rackCount = new Set(rows.map((row) => `${row.warehouse_id}:${row.zone_code}:${row.rack_code}`)).size
    const configuredCapacity = rows.reduce((sum, row) => sum + Number(row.capacity_units || 0), 0)
    const inactiveBins = rows.filter((row) => !row.is_active).length
    return {
      warehouseCount,
      zoneCount,
      rackCount,
      binCount: rows.length,
      configuredCapacity,
      inactiveBins,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim()
    return rows.filter((row) => {
      const warehouseName = row.warehouse_name ?? warehouseMap.get(row.warehouse_id) ?? ""
      const haystack = [
        warehouseName,
        row.zone_code,
        row.zone_name,
        row.rack_code,
        row.rack_name,
        row.bin_code,
        row.bin_name,
      ].join(" ").toLowerCase()

      if (term && !haystack.includes(term)) return false
      if (zoneFilter !== "all" && row.zone_code !== zoneFilter) return false
      if (statusFilter === "active" && !row.is_active) return false
      if (statusFilter === "inactive" && row.is_active) return false
      if (statusFilter === "missing_capacity" && Number(row.capacity_units || 0) > 0) return false
      if (statusFilter === "with_stock" && Number(row.stock_count || 0) <= 0) return false
      return true
    })
  }, [rows, search, statusFilter, warehouseMap, zoneFilter])

  const searchSuggestions = useMemo(
    () =>
      Array.from(
        new Set(
          rows.flatMap((row) => {
            const warehouseName = row.warehouse_name ?? warehouseMap.get(row.warehouse_id) ?? ""
            return [
              row.zone_code,
              row.zone_name,
              row.rack_code,
              row.rack_name,
              row.bin_code,
              row.bin_name,
              warehouseName,
            ].filter(Boolean)
          })
        )
      ),
    [rows, warehouseMap]
  )

  const hierarchy = useMemo(() => {
    const warehouseGroups = new Map<
      string,
      {
        name: string
        zones: Map<string, { name: string; racks: Map<string, { name: string; bins: ZoneLayoutRow[] }> }>
      }
    >()

    for (const row of filtered) {
      const warehouseName = row.warehouse_name ?? warehouseMap.get(row.warehouse_id) ?? "Unassigned Warehouse"
      const warehouseKey = `${row.warehouse_id}:${warehouseName}`
      if (!warehouseGroups.has(warehouseKey)) {
        warehouseGroups.set(warehouseKey, { name: warehouseName, zones: new Map() })
      }
      const warehouse = warehouseGroups.get(warehouseKey)!
      if (!warehouse.zones.has(row.zone_code)) {
        warehouse.zones.set(row.zone_code, { name: row.zone_name, racks: new Map() })
      }
      const zone = warehouse.zones.get(row.zone_code)!
      if (!zone.racks.has(row.rack_code)) {
        zone.racks.set(row.rack_code, { name: row.rack_name, bins: [] })
      }
      zone.racks.get(row.rack_code)!.bins.push(row)
    }

    return Array.from(warehouseGroups.entries())
  }, [filtered, warehouseMap])

  const filterChips: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: "All", count: rows.length },
    { key: "active", label: "Active", count: rows.filter((row) => row.is_active).length },
    { key: "inactive", label: "Inactive", count: rows.filter((row) => !row.is_active).length },
    { key: "missing_capacity", label: "Missing Capacity", count: rows.filter((row) => !row.capacity_units).length },
    { key: "with_stock", label: "With Stock", count: rows.filter((row) => Number(row.stock_count || 0) > 0).length },
  ]

  const openCreate = () => {
    setEditRow(null)
    setForm(emptyForm)
    setIsDialogOpen(true)
  }

  const openEdit = (row: ZoneLayoutRow) => {
    setEditRow(row)
    setForm({
      warehouse_id: String(row.warehouse_id),
      zone_code: row.zone_code,
      zone_name: row.zone_name,
      rack_code: row.rack_code,
      rack_name: row.rack_name,
      bin_code: row.bin_code,
      bin_name: row.bin_name,
      capacity_units: row.capacity_units?.toString() ?? "",
      sort_order: String(row.sort_order ?? 0),
    })
    setIsDialogOpen(true)
  }

  const openDuplicate = (row: ZoneLayoutRow) => {
    setEditRow(null)
    setForm({
      warehouse_id: String(row.warehouse_id),
      zone_code: row.zone_code,
      zone_name: row.zone_name,
      rack_code: row.rack_code,
      rack_name: row.rack_name,
      bin_code: `${row.bin_code}-COPY`,
      bin_name: `${row.bin_name} Copy`,
      capacity_units: row.capacity_units?.toString() ?? "",
      sort_order: String((row.sort_order ?? 0) + 1),
    })
    setIsDialogOpen(true)
  }

  const resetFilters = () => {
    setSearch("")
    setWarehouseFilter("all")
    setZoneFilter("all")
    setStatusFilter("all")
  }

  const handleSave = async () => {
    if (!form.warehouse_id || !form.zone_code || !form.zone_name || !form.rack_code || !form.rack_name || !form.bin_code || !form.bin_name) {
      toast.error("Complete all required layout fields")
      return
    }

    const duplicate = rows.find(
      (row) =>
        row.id !== editRow?.id &&
        String(row.warehouse_id) === form.warehouse_id &&
        normalize(row.zone_code) === normalize(form.zone_code) &&
        normalize(row.rack_code) === normalize(form.rack_code) &&
        normalize(row.bin_code) === normalize(form.bin_code)
    )

    if (duplicate) {
      toast.error("This warehouse, zone, rack, and bin combination already exists")
      return
    }

    const payload = {
      warehouse_id: Number(form.warehouse_id),
      zone_code: normalize(form.zone_code),
      zone_name: form.zone_name.trim(),
      rack_code: normalize(form.rack_code),
      rack_name: form.rack_name.trim(),
      bin_code: normalize(form.bin_code),
      bin_name: form.bin_name.trim(),
      capacity_units: form.capacity_units ? Number(form.capacity_units) : undefined,
      sort_order: Number(form.sort_order || 0),
      ...(editRow ? { id: editRow.id, is_active: editRow.is_active } : {}),
    }

    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const handleDeactivate = async (row: ZoneLayoutRow) => {
    const stockCount = Number(row.stock_count || 0)
    const message =
      stockCount > 0
        ? `${row.bin_code} has ${stockCount} stock unit(s). Deactivate only after stock is moved. Continue anyway?`
        : `Deactivate ${row.bin_code}?`

    if (!window.confirm(message)) return
    await deleteMutation.mutateAsync(row.id)
    setDetailRow(null)
  }

  const capacityBadge = (row: ZoneLayoutRow) => {
    const capacity = Number(row.capacity_units || 0)
    if (!capacity) {
      return <Badge className="border-amber-200 bg-amber-50 text-amber-700">Missing</Badge>
    }
    return <span className="font-medium">{capacity.toLocaleString()} units</span>
  }

  const utilization = (row: ZoneLayoutRow) => {
    const capacity = Number(row.capacity_units || 0)
    const stock = Number(row.stock_count || 0)
    const pct = capacity > 0 ? Math.min(100, Math.round((stock / capacity) * 100)) : 0
    return { stock, pct }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Zone Layout Management</h1>
          <p className="mt-1 text-gray-500">Configure warehouse hierarchy from warehouse to zone, rack, and bin.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="rounded-md px-2.5 py-1">Warehouse</Badge>
            <span className="text-gray-400">/</span>
            <Badge variant="outline" className="rounded-md px-2.5 py-1">Zone</Badge>
            <span className="text-gray-400">/</span>
            <Badge variant="outline" className="rounded-md px-2.5 py-1">Rack</Badge>
            <span className="text-gray-400">/</span>
            <Badge variant="outline" className="rounded-md px-2.5 py-1">Bin</Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportZoneLayoutTemplateToExcel}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Template
          </Button>
          <Button variant="outline" onClick={() => toast.info("Use the downloaded template to prepare zone layout imports.")}>
            <Upload className="mr-2 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" onClick={() => exportZoneLayoutsToExcel(filtered)}>
            <Download className="mr-2 h-4 w-4" /> Export
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Add Bin Layout
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>{editRow ? "Edit Bin Layout" : "Add Bin Layout"}</DialogTitle>
                <DialogDescription>Each bin must be unique within the selected warehouse, zone, and rack.</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 pt-2">
                <div className="space-y-2">
                  <Label>Warehouse *</Label>
                  <Select value={form.warehouse_id} onValueChange={(value) => setForm({ ...form, warehouse_id: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select warehouse" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((warehouse) => (
                        <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                          {warehouse.warehouse_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Zone Code *</Label>
                    <Input value={form.zone_code} onChange={(e) => setForm({ ...form, zone_code: e.target.value.toUpperCase() })} className="uppercase" />
                  </div>
                  <div className="space-y-2">
                    <Label>Zone Name *</Label>
                    <Input value={form.zone_name} onChange={(e) => setForm({ ...form, zone_name: e.target.value })} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Rack Code *</Label>
                    <Input value={form.rack_code} onChange={(e) => setForm({ ...form, rack_code: e.target.value.toUpperCase() })} className="uppercase" />
                  </div>
                  <div className="space-y-2">
                    <Label>Rack Name *</Label>
                    <Input value={form.rack_name} onChange={(e) => setForm({ ...form, rack_name: e.target.value })} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Bin Code *</Label>
                    <Input value={form.bin_code} onChange={(e) => setForm({ ...form, bin_code: e.target.value.toUpperCase() })} className="uppercase" />
                  </div>
                  <div className="space-y-2">
                    <Label>Bin Name *</Label>
                    <Input value={form.bin_name} onChange={(e) => setForm({ ...form, bin_name: e.target.value })} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Capacity Units</Label>
                    <Input type="number" min={0} value={form.capacity_units} onChange={(e) => setForm({ ...form, capacity_units: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Sort Order</Label>
                    <Input type="number" min={0} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} className="bg-blue-600" disabled={saveMutation.isPending}>
                  Save Layout
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        {[
          { label: "Warehouses", value: metrics.warehouseCount, icon: Building2, tone: "bg-blue-50 text-blue-700" },
          { label: "Zones", value: metrics.zoneCount, icon: Layers3, tone: "bg-violet-50 text-violet-700" },
          { label: "Racks", value: metrics.rackCount, icon: Grid3X3, tone: "bg-cyan-50 text-cyan-700" },
          { label: "Bins", value: metrics.binCount, icon: Boxes, tone: "bg-emerald-50 text-emerald-700" },
          { label: "Capacity", value: metrics.configuredCapacity.toLocaleString(), icon: Archive, tone: "bg-slate-100 text-slate-700" },
          { label: "Inactive", value: metrics.inactiveBins, icon: AlertTriangle, tone: "bg-amber-50 text-amber-700" },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-sm text-slate-600">{metric.label}</p>
                <p className="mt-2 text-2xl font-bold">{metric.value}</p>
              </div>
              <div className={`rounded-lg p-2 ${metric.tone}`}>
                <metric.icon className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap gap-2">
            {filterChips.map((chip) => (
              <Button
                key={chip.key}
                variant={statusFilter === chip.key ? "default" : "outline"}
                className={statusFilter === chip.key ? "bg-slate-950 text-white hover:bg-slate-900" : ""}
                onClick={() => setStatusFilter(chip.key)}
              >
                {chip.label}
                <span className="ml-2 rounded-full bg-white/20 px-1.5 text-xs">{chip.count}</span>
              </Button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_240px_220px_auto]">
            <div className="space-y-2">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <TypeaheadInput
                  className="pl-9"
                  value={search}
                  onValueChange={setSearch}
                  suggestions={searchSuggestions}
                  placeholder="Zone, rack, bin, warehouse"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                      {warehouse.warehouse_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Zone</Label>
              <Select value={zoneFilter} onValueChange={setZoneFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All zones</SelectItem>
                  {zones.map(([code, label]) => (
                    <SelectItem key={code} value={code}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={resetFilters}>
                <X className="mr-2 h-4 w-4" /> Clear
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant={viewMode === "table" ? "default" : "outline"} className={viewMode === "table" ? "bg-slate-950" : ""} onClick={() => setViewMode("table")}>
          List
        </Button>
        <Button variant={viewMode === "hierarchy" ? "default" : "outline"} className={viewMode === "hierarchy" ? "bg-slate-950" : ""} onClick={() => setViewMode("hierarchy")}>
          Hierarchy
        </Button>
      </div>

      {viewMode === "table" ? (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Bin Layout Directory</h2>
                <p className="text-sm text-slate-500">Showing {filtered.length ? `1-${filtered.length}` : "0"} of {rows.length} bin layouts</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead>Rack</TableHead>
                    <TableHead>Bin</TableHead>
                    <TableHead>Capacity</TableHead>
                    <TableHead>Utilization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const usage = utilization(row)
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.warehouse_name ?? warehouseMap.get(row.warehouse_id)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Layers3 className="h-4 w-4 text-slate-400" />
                            <div>
                              <div className="font-mono text-sm">{row.zone_code}</div>
                              <div className="text-xs text-slate-500">{row.zone_name}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-sm">{row.rack_code}</div>
                          <div className="text-xs text-slate-500">{row.rack_name}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-sm">{row.bin_code}</div>
                          <div className="text-xs text-slate-500">{row.bin_name}</div>
                        </TableCell>
                        <TableCell>{capacityBadge(row)}</TableCell>
                        <TableCell>
                          <div className="min-w-[130px]">
                            <div className="flex justify-between text-xs text-slate-500">
                              <span>{usage.stock.toLocaleString()} stock</span>
                              <span>{row.capacity_units ? `${usage.pct}%` : "N/A"}</span>
                            </div>
                            <div className="mt-1 h-2 rounded-full bg-slate-100">
                              <div className="h-2 rounded-full bg-blue-600" style={{ width: `${usage.pct}%` }} />
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className={row.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                            {row.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setDetailRow(row)}>View</Button>
                            <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Edit layout">
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openDuplicate(row)} title="Duplicate layout">
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDeactivate(row)} title="Deactivate layout">
                              <Archive className="h-4 w-4 text-red-600" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {!filtered.length && (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <Package className="h-10 w-10 text-slate-300" />
                          <h3 className="mt-3 font-semibold">No bin layouts configured</h3>
                          <p className="mt-1 text-sm text-slate-500">Add the first zone, rack, and bin for this warehouse setup.</p>
                          <Button className="mt-4 bg-blue-600" onClick={openCreate}>
                            <Plus className="mr-2 h-4 w-4" /> Add Bin Layout
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {hierarchy.map(([warehouseKey, warehouse]) => (
            <Card key={warehouseKey}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-blue-600" />
                  <h2 className="text-lg font-semibold">{warehouse.name}</h2>
                  <Badge variant="outline">{Array.from(warehouse.zones.values()).length} zones</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {Array.from(warehouse.zones.entries()).map(([zoneCode, zone]) => (
                  <div key={zoneCode} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-violet-100 text-violet-800">{zoneCode}</Badge>
                      <span className="font-semibold">{zone.name}</span>
                      <span className="text-sm text-slate-500">{zone.racks.size} racks</span>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from(zone.racks.entries()).map(([rackCode, rack]) => (
                        <div key={rackCode} className="rounded-md bg-slate-50 p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-mono text-sm font-semibold">{rackCode}</p>
                              <p className="text-xs text-slate-500">{rack.name}</p>
                            </div>
                            <Badge variant="outline">{rack.bins.length} bins</Badge>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {rack.bins.map((bin) => (
                              <button
                                key={bin.id}
                                type="button"
                                onClick={() => setDetailRow(bin)}
                                className="rounded-md border bg-white px-2.5 py-1.5 text-left text-xs hover:border-blue-300 hover:bg-blue-50"
                              >
                                <span className="block font-mono font-semibold">{bin.bin_code}</span>
                                <span className="text-slate-500">{bin.capacity_units ? `${bin.capacity_units} units` : "Missing capacity"}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
          {!hierarchy.length && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Layers3 className="h-10 w-10 text-slate-300" />
                <h3 className="mt-3 font-semibold">No hierarchy to display</h3>
                <p className="mt-1 text-sm text-slate-500">Clear filters or add a bin layout to build the hierarchy.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={Boolean(detailRow)} onOpenChange={(open) => !open && setDetailRow(null)}>
        <DialogContent className="sm:max-w-2xl">
          {detailRow && (
            <>
              <DialogHeader>
                <DialogTitle>{detailRow.bin_code} - {detailRow.bin_name}</DialogTitle>
                <DialogDescription>{field(detailRow.warehouse_name ?? warehouseMap.get(detailRow.warehouse_id))}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Hierarchy</h3>
                  <div className="mt-3 space-y-3 text-sm">
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Zone</span><span className="text-right font-medium">{detailRow.zone_code} - {detailRow.zone_name}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Rack</span><span className="text-right font-medium">{detailRow.rack_code} - {detailRow.rack_name}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Bin</span><span className="text-right font-medium">{detailRow.bin_code} - {detailRow.bin_name}</span></div>
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Operations</h3>
                  <div className="mt-3 space-y-3 text-sm">
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Capacity</span><span className="text-right font-medium">{detailRow.capacity_units ? `${detailRow.capacity_units.toLocaleString()} units` : "Missing"}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Current Stock</span><span className="text-right font-medium">{Number(detailRow.stock_count || 0).toLocaleString()}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Status</span><Badge className={detailRow.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{detailRow.is_active ? "Active" : "Inactive"}</Badge></div>
                  </div>
                </div>
              </div>
              {Number(detailRow.stock_count || 0) > 0 && (
                <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  Move stock out of this bin before deactivating it.
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => openDuplicate(detailRow)}>
                  <Copy className="mr-2 h-4 w-4" /> Duplicate
                </Button>
                <Button variant="outline" onClick={() => openEdit(detailRow)}>
                  <Edit className="mr-2 h-4 w-4" /> Edit
                </Button>
                <Button variant="outline" onClick={() => handleDeactivate(detailRow)}>
                  <Archive className="mr-2 h-4 w-4" /> Deactivate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
