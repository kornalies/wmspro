"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  Archive,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit,
  FileSpreadsheet,
  Grid3X3,
  Layers3,
  Plus,
  Rows3,
  Search,
  Upload,
  X,
} from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import {
  BIN_STATUSES,
  binStatusLabel,
  DEFAULT_BIN_STATUS,
  DEFAULT_ZONE_TYPE,
  ZONE_TYPES,
  zoneTypeLabel,
} from "@/lib/zone-layouts"
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
import { TypeaheadInput } from "@/components/ui/typeahead-input"

type ZoneLayoutRow = {
  id: number
  warehouse_id: number
  warehouse_name?: string
  zone_code: string
  zone_name: string
  zone_type: string
  rack_code: string
  rack_name: string
  bin_code: string
  bin_name: string
  bin_status: string
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

const emptyForm = {
  warehouse_id: "",
  zone_code: "",
  zone_name: "",
  zone_type: DEFAULT_ZONE_TYPE as string,
  rack_code: "",
  rack_name: "",
  bin_code: "",
  bin_name: "",
  bin_status: DEFAULT_BIN_STATUS as string,
  capacity_units: "",
  sort_order: "0",
}

const emptyBulkForm = {
  warehouse_id: "",
  zone_code: "",
  zone_name: "",
  zone_type: DEFAULT_ZONE_TYPE as string,
  rack_code: "",
  rack_name: "",
  bin_prefix: "",
  bin_start: "1",
  bin_end: "20",
  bin_pad: "2",
  bin_name_prefix: "Bin ",
  bin_status: DEFAULT_BIN_STATUS as string,
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
  const queryClient = useQueryClient()
  const saveMutation = useSaveAdminResource("zone-layouts")
  const deleteMutation = useDeleteAdminResource("zone-layouts")

  const bulkMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await apiClient.post<{ created: number; skipped: number }>("/zone-layouts", payload)
      return res
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "zone-layouts"] })
      toast.success(res.message ?? "Bins created")
    },
    onError: (error) => handleError(error, "Failed to create bins"),
  })

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
  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set())
  const [expandedRacks, setExpandedRacks] = useState<Set<string>>(new Set())
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<ZoneLayoutRow | null>(null)
  const [detailRow, setDetailRow] = useState<ZoneLayoutRow | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [isBulkOpen, setIsBulkOpen] = useState(false)
  const [bulkForm, setBulkForm] = useState(emptyBulkForm)

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
        zones: Map<string, { name: string; type: string; racks: Map<string, { name: string; bins: ZoneLayoutRow[] }> }>
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
        warehouse.zones.set(row.zone_code, { name: row.zone_name, type: row.zone_type || DEFAULT_ZONE_TYPE, racks: new Map() })
      }
      const zone = warehouse.zones.get(row.zone_code)!
      if (!zone.racks.has(row.rack_code)) {
        zone.racks.set(row.rack_code, { name: row.rack_name, bins: [] })
      }
      zone.racks.get(row.rack_code)!.bins.push(row)
    }

    return Array.from(warehouseGroups.entries())
  }, [filtered, warehouseMap])

  // A search term overrides the collapsed state so matches are always visible.
  const searchActive = search.trim().length > 0

  const toggleKey = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const expandAll = () => {
    const zoneKeys = new Set<string>()
    const rackKeys = new Set<string>()
    for (const [warehouseKey, warehouse] of hierarchy) {
      for (const [zoneCode, zone] of warehouse.zones) {
        const zoneKey = `${warehouseKey}::${zoneCode}`
        zoneKeys.add(zoneKey)
        for (const [rackCode] of zone.racks) rackKeys.add(`${zoneKey}::${rackCode}`)
      }
    }
    setExpandedZones(zoneKeys)
    setExpandedRacks(rackKeys)
  }

  const collapseAll = () => {
    setExpandedZones(new Set())
    setExpandedRacks(new Set())
  }

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
      zone_type: row.zone_type || DEFAULT_ZONE_TYPE,
      rack_code: row.rack_code,
      rack_name: row.rack_name,
      bin_code: row.bin_code,
      bin_name: row.bin_name,
      bin_status: row.bin_status || DEFAULT_BIN_STATUS,
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
      zone_type: row.zone_type || DEFAULT_ZONE_TYPE,
      rack_code: row.rack_code,
      rack_name: row.rack_name,
      bin_code: `${row.bin_code}-COPY`,
      bin_name: `${row.bin_name} Copy`,
      bin_status: row.bin_status || DEFAULT_BIN_STATUS,
      capacity_units: row.capacity_units?.toString() ?? "",
      sort_order: String((row.sort_order ?? 0) + 1),
    })
    setIsDialogOpen(true)
  }

  const openBulk = () => {
    setBulkForm(emptyBulkForm)
    setIsBulkOpen(true)
  }

  // Existing (zone_code -> {name, type}) so picking a zone in the bulk dialog
  // reuses the same name/type instead of forcing a re-type.
  const zoneDetails = useMemo(() => {
    const map = new Map<string, { name: string; type: string }>()
    for (const row of rows) {
      if (!map.has(row.zone_code)) map.set(row.zone_code, { name: row.zone_name, type: row.zone_type || DEFAULT_ZONE_TYPE })
    }
    return map
  }, [rows])

  const applyExistingZone = (zoneCode: string) => {
    const detail = zoneDetails.get(zoneCode)
    setBulkForm((prev) => ({
      ...prev,
      zone_code: zoneCode,
      zone_name: detail?.name ?? prev.zone_name,
      zone_type: detail?.type ?? prev.zone_type,
    }))
  }

  const generatedBins = useMemo(() => {
    const start = Number.parseInt(bulkForm.bin_start, 10)
    const end = Number.parseInt(bulkForm.bin_end, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return []
    const pad = Math.max(0, Number(bulkForm.bin_pad) || 0)
    const prefix = bulkForm.bin_prefix.trim().toUpperCase()
    const namePrefix = bulkForm.bin_name_prefix
    const out: Array<{ bin_code: string; bin_name: string }> = []
    for (let n = start; n <= end && out.length < 500; n++) {
      const num = String(n).padStart(pad, "0")
      const code = `${prefix}${num}`
      out.push({ bin_code: code, bin_name: `${namePrefix}${num}`.trim() || code })
    }
    return out
  }, [bulkForm])

  const bulkDuplicates = useMemo(() => {
    if (!generatedBins.length) return 0
    const existing = new Set(
      rows
        .filter(
          (row) =>
            String(row.warehouse_id) === bulkForm.warehouse_id &&
            normalize(row.zone_code) === normalize(bulkForm.zone_code) &&
            normalize(row.rack_code) === normalize(bulkForm.rack_code)
        )
        .map((row) => normalize(row.bin_code))
    )
    return generatedBins.filter((bin) => existing.has(normalize(bin.bin_code))).length
  }, [generatedBins, rows, bulkForm.warehouse_id, bulkForm.zone_code, bulkForm.rack_code])

  const handleBulkSave = async () => {
    if (!bulkForm.warehouse_id || !bulkForm.zone_code || !bulkForm.zone_name || !bulkForm.rack_code || !bulkForm.rack_name) {
      toast.error("Complete warehouse, zone, and rack fields")
      return
    }
    if (!generatedBins.length) {
      toast.error("Enter a valid bin range (start must be ≤ end)")
      return
    }

    await bulkMutation.mutateAsync({
      warehouse_id: Number(bulkForm.warehouse_id),
      zone_code: normalize(bulkForm.zone_code),
      zone_name: bulkForm.zone_name.trim(),
      zone_type: bulkForm.zone_type,
      rack_code: normalize(bulkForm.rack_code),
      rack_name: bulkForm.rack_name.trim(),
      bin_status: bulkForm.bin_status,
      capacity_units: bulkForm.capacity_units ? Number(bulkForm.capacity_units) : undefined,
      sort_order: Number(bulkForm.sort_order || 0),
      bins: generatedBins,
    })
    setIsBulkOpen(false)
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
      zone_type: form.zone_type,
      rack_code: normalize(form.rack_code),
      rack_name: form.rack_name.trim(),
      bin_code: normalize(form.bin_code),
      bin_name: form.bin_name.trim(),
      bin_status: form.bin_status,
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
          <Button variant="outline" onClick={openBulk}>
            <Rows3 className="mr-2 h-4 w-4" /> Add Rack
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

                <div className="space-y-2">
                  <Label>Zone Type *</Label>
                  <Select value={form.zone_type} onValueChange={(value) => setForm({ ...form, zone_type: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select zone function" />
                    </SelectTrigger>
                    <SelectContent>
                      {ZONE_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {zoneTypeLabel(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">Defines the zone&apos;s function in the warehouse flow (receiving, storage, picking, dispatch, etc.).</p>
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

                <div className="space-y-2">
                  <Label>Bin Status *</Label>
                  <Select value={form.bin_status} onValueChange={(value) => setForm({ ...form, bin_status: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select bin status" />
                    </SelectTrigger>
                    <SelectContent>
                      {BIN_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {binStatusLabel(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">Only <span className="font-medium">Available</span> bins accept put-away. Blocked, on-hold, damaged, and under-count bins stay in the master but are out of the pool.</p>
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Zone Hierarchy</h2>
          <p className="text-sm text-slate-500">{metrics.zoneCount} zones · {metrics.rackCount} racks · {metrics.binCount} bins</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={expandAll}>Expand all</Button>
          <Button variant="outline" size="sm" onClick={collapseAll}>Collapse all</Button>
        </div>
      </div>

      <div className="space-y-4">
        {hierarchy.map(([warehouseKey, warehouse]) => (
          <Card key={warehouseKey}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-blue-600" />
                <h2 className="text-lg font-semibold">{warehouse.name}</h2>
                <Badge variant="outline">{warehouse.zones.size} zones</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {Array.from(warehouse.zones.entries()).map(([zoneCode, zone]) => {
                const zoneKey = `${warehouseKey}::${zoneCode}`
                const zoneOpen = searchActive || expandedZones.has(zoneKey)
                const zoneBinCount = Array.from(zone.racks.values()).reduce((sum, rack) => sum + rack.bins.length, 0)
                return (
                  <div key={zoneKey} className="rounded-lg border">
                    <button
                      type="button"
                      onClick={() => toggleKey(setExpandedZones, zoneKey)}
                      className="flex w-full items-center gap-2 rounded-t-lg bg-slate-50 px-3 py-2.5 text-left hover:bg-slate-100"
                    >
                      {zoneOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
                      <Layers3 className="h-4 w-4 shrink-0 text-violet-600" />
                      <span className="font-mono text-sm font-semibold">{zoneCode}</span>
                      <span className="text-sm text-slate-600">{zone.name}</span>
                      <Badge variant="outline" className="rounded px-1.5 py-0 text-[10px] font-normal">{zoneTypeLabel(zone.type)}</Badge>
                      <span className="ml-auto whitespace-nowrap text-xs text-slate-500">{zone.racks.size} racks · {zoneBinCount} bins</span>
                    </button>

                    {zoneOpen && (
                      <div className="space-y-2 p-3">
                        {Array.from(zone.racks.entries()).map(([rackCode, rack]) => {
                          const rackKey = `${zoneKey}::${rackCode}`
                          const rackOpen = searchActive || expandedRacks.has(rackKey)
                          return (
                            <div key={rackKey} className="rounded-md border">
                              <button
                                type="button"
                                onClick={() => toggleKey(setExpandedRacks, rackKey)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                              >
                                {rackOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                                <Grid3X3 className="h-4 w-4 shrink-0 text-cyan-600" />
                                <span className="font-mono text-sm font-semibold">{rackCode}</span>
                                <span className="text-xs text-slate-500">{rack.name}</span>
                                <Badge variant="outline" className="ml-auto">{rack.bins.length} bins</Badge>
                              </button>

                              {rackOpen && (
                                <div className="divide-y border-t">
                                  {rack.bins.map((bin) => {
                                    const usage = utilization(bin)
                                    return (
                                      <div key={bin.id} className="flex flex-wrap items-center gap-3 py-2 pl-9 pr-3">
                                        <Boxes className="h-4 w-4 shrink-0 text-emerald-600" />
                                        <div className="min-w-[120px]">
                                          <div className="font-mono text-sm">{bin.bin_code}</div>
                                          <div className="text-xs text-slate-500">{bin.bin_name}</div>
                                        </div>
                                        <div className="min-w-[90px]">{capacityBadge(bin)}</div>
                                        <div className="min-w-[110px]">
                                          <div className="flex justify-between text-xs text-slate-500">
                                            <span>{usage.stock.toLocaleString()} stock</span>
                                            <span>{bin.capacity_units ? `${usage.pct}%` : "N/A"}</span>
                                          </div>
                                          <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                                            <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${usage.pct}%` }} />
                                          </div>
                                        </div>
                                        <Badge
                                          variant="outline"
                                          className={bin.bin_status && bin.bin_status !== "AVAILABLE" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-600"}
                                        >
                                          {binStatusLabel(bin.bin_status)}
                                        </Badge>
                                        {!bin.is_active && <Badge className="bg-red-100 text-red-800">Inactive</Badge>}
                                        <div className="ml-auto flex gap-1">
                                          <Button variant="ghost" size="sm" onClick={() => setDetailRow(bin)}>View</Button>
                                          <Button variant="ghost" size="sm" onClick={() => openEdit(bin)} title="Edit layout" aria-label={`Edit layout ${bin.bin_code}`}>
                                            <Edit className="h-4 w-4" />
                                          </Button>
                                          <Button variant="ghost" size="sm" onClick={() => openDuplicate(bin)} title="Duplicate layout" aria-label={`Duplicate layout ${bin.bin_code}`}>
                                            <Copy className="h-4 w-4" />
                                          </Button>
                                          <Button variant="ghost" size="sm" onClick={() => handleDeactivate(bin)} title="Deactivate layout" aria-label={`Deactivate layout ${bin.bin_code}`}>
                                            <Archive className="h-4 w-4 text-red-600" />
                                          </Button>
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))}
        {!hierarchy.length && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Layers3 className="h-10 w-10 text-slate-300" />
              <h3 className="mt-3 font-semibold">No zones to display</h3>
              <p className="mt-1 text-sm text-slate-500">Clear filters or add the first zone, rack, and bin for this warehouse setup.</p>
              <Button className="mt-4 bg-blue-600" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Add Bin Layout
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={isBulkOpen} onOpenChange={setIsBulkOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add Rack with Bin Range</DialogTitle>
            <DialogDescription>Generate many bins under a single rack in one step. Bins that already exist are skipped.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 pt-2">
            <div className="space-y-2">
              <Label>Warehouse *</Label>
              <Select value={bulkForm.warehouse_id} onValueChange={(value) => setBulkForm({ ...bulkForm, warehouse_id: value })}>
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

            {zones.length > 0 && (
              <div className="space-y-2">
                <Label>Use Existing Zone</Label>
                <Select value="" onValueChange={applyExistingZone}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a zone to reuse its name & type" />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map(([code, label]) => (
                      <SelectItem key={code} value={code}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500">Optional — or type a new zone below to create it.</p>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Zone Code *</Label>
                <Input value={bulkForm.zone_code} onChange={(e) => setBulkForm({ ...bulkForm, zone_code: e.target.value.toUpperCase() })} className="uppercase" />
              </div>
              <div className="space-y-2">
                <Label>Zone Name *</Label>
                <Input value={bulkForm.zone_name} onChange={(e) => setBulkForm({ ...bulkForm, zone_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Zone Type *</Label>
                <Select value={bulkForm.zone_type} onValueChange={(value) => setBulkForm({ ...bulkForm, zone_type: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ZONE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {zoneTypeLabel(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Rack Code *</Label>
                <Input value={bulkForm.rack_code} onChange={(e) => setBulkForm({ ...bulkForm, rack_code: e.target.value.toUpperCase() })} className="uppercase" />
              </div>
              <div className="space-y-2">
                <Label>Rack Name *</Label>
                <Input value={bulkForm.rack_name} onChange={(e) => setBulkForm({ ...bulkForm, rack_name: e.target.value })} />
              </div>
            </div>

            <div className="rounded-lg border bg-slate-50 p-4">
              <h3 className="text-sm font-semibold">Bin Range</h3>
              <div className="mt-3 grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label>Bin Prefix</Label>
                  <Input value={bulkForm.bin_prefix} onChange={(e) => setBulkForm({ ...bulkForm, bin_prefix: e.target.value.toUpperCase() })} className="uppercase" placeholder="A-" />
                </div>
                <div className="space-y-2">
                  <Label>Start *</Label>
                  <Input type="number" min={0} value={bulkForm.bin_start} onChange={(e) => setBulkForm({ ...bulkForm, bin_start: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>End *</Label>
                  <Input type="number" min={0} value={bulkForm.bin_end} onChange={(e) => setBulkForm({ ...bulkForm, bin_end: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Digits</Label>
                  <Input type="number" min={0} max={6} value={bulkForm.bin_pad} onChange={(e) => setBulkForm({ ...bulkForm, bin_pad: e.target.value })} />
                </div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Bin Name Prefix</Label>
                  <Input value={bulkForm.bin_name_prefix} onChange={(e) => setBulkForm({ ...bulkForm, bin_name_prefix: e.target.value })} placeholder="Bin " />
                </div>
                <div className="space-y-2">
                  <Label>Bin Status</Label>
                  <Select value={bulkForm.bin_status} onValueChange={(value) => setBulkForm({ ...bulkForm, bin_status: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BIN_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {binStatusLabel(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Capacity per Bin</Label>
                  <Input type="number" min={0} value={bulkForm.capacity_units} onChange={(e) => setBulkForm({ ...bulkForm, capacity_units: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Sort Order Start</Label>
                  <Input type="number" min={0} value={bulkForm.sort_order} onChange={(e) => setBulkForm({ ...bulkForm, sort_order: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-4 text-sm">
              {generatedBins.length ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-emerald-100 text-emerald-800">{generatedBins.length} bins</Badge>
                    {bulkDuplicates > 0 && (
                      <Badge className="bg-amber-100 text-amber-800">{bulkDuplicates} already exist — will be skipped</Badge>
                    )}
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-600">
                    {generatedBins.slice(0, 6).map((bin) => bin.bin_code).join(", ")}
                    {generatedBins.length > 6 ? ` … ${generatedBins[generatedBins.length - 1].bin_code}` : ""}
                  </p>
                </>
              ) : (
                <p className="text-slate-500">Enter a valid start and end to preview the generated bins.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsBulkOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkSave} className="bg-blue-600" disabled={bulkMutation.isPending || !generatedBins.length}>
              Create {generatedBins.length || ""} Bins
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Zone Type</span><span className="text-right font-medium">{zoneTypeLabel(detailRow.zone_type)}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Rack</span><span className="text-right font-medium">{detailRow.rack_code} - {detailRow.rack_name}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Bin</span><span className="text-right font-medium">{detailRow.bin_code} - {detailRow.bin_name}</span></div>
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Operations</h3>
                  <div className="mt-3 space-y-3 text-sm">
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Capacity</span><span className="text-right font-medium">{detailRow.capacity_units ? `${detailRow.capacity_units.toLocaleString()} units` : "Missing"}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Current Stock</span><span className="text-right font-medium">{Number(detailRow.stock_count || 0).toLocaleString()}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-slate-500">Bin Status</span><Badge variant="outline" className={detailRow.bin_status && detailRow.bin_status !== "AVAILABLE" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 text-slate-600"}>{binStatusLabel(detailRow.bin_status)}</Badge></div>
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
