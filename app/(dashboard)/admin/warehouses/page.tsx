"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import dynamic from "next/dynamic"
import Link from "next/link"
import { ArrowRight, Edit, MapPin, Plus, Search, User2, Warehouse } from "lucide-react"

import { useAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type WarehouseRow = {
  id: number
  warehouse_code: string
  warehouse_name: string
  city?: string
  state?: string
  pincode?: string
  latitude?: number | null
  longitude?: number | null
  is_active: boolean
  created_at?: string | null
  updated_at?: string | null
  warehouse_type?: string
  manager_name?: string
  region_tag?: string
  total_zones?: number
  active_skus?: number
  open_grns?: number
  stock_value?: number
  capacity_total_units?: number
  capacity_used_units?: number
  capacity_used_pct?: number
  client_breakdown?: Array<{ client_name: string; units: number }>
}

const WarehouseLocationMap = dynamic(
  () => import("@/components/admin/WarehouseLocationMap"),
  { ssr: false }
)

function formatInrCr(value: number) {
  if (!value) return "₹0"
  const crore = value / 10000000
  if (crore >= 1) return `₹${crore.toFixed(1)} Cr`
  const lakh = value / 100000
  if (lakh >= 1) return `₹${lakh.toFixed(1)} L`
  return `₹${Math.round(value).toLocaleString("en-IN")}`
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

function computeCapacityPct(warehouse: WarehouseRow) {
  const used = Number(warehouse.capacity_used_units ?? 0)
  const total = Number(warehouse.capacity_total_units ?? 0)
  if (total > 0) {
    return Math.max(0, Math.min(100, (used / total) * 100))
  }
  const fallbackPct = Number(warehouse.capacity_used_pct ?? 0)
  if (Number.isFinite(fallbackPct)) {
    return Math.max(0, Math.min(100, fallbackPct))
  }
  return used > 0 ? 100 : 0
}

export default function WarehousesPage() {
  const router = useRouter()
  const warehousesQuery = useAdminResource("warehouses")
  const saveMutation = useSaveAdminResource("warehouses")

  const [search, setSearch] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editWarehouse, setEditWarehouse] = useState<WarehouseRow | null>(null)
  const [form, setForm] = useState({
    warehouse_code: "",
    warehouse_name: "",
    city: "",
    state: "",
    pincode: "",
    latitude: "",
    longitude: "",
  })

  const warehouses = (warehousesQuery.data as WarehouseRow[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () =>
      warehouses.flatMap((warehouse) => [
        warehouse.warehouse_name,
        warehouse.warehouse_code,
        warehouse.manager_name ?? "",
        warehouse.region_tag ?? "",
      ]),
    [warehouses]
  )
  const activeWarehouses = warehouses.filter((w) => w.is_active)
  const filtered = warehouses.filter(
    (w) =>
      `${w.warehouse_name} ${w.warehouse_code} ${w.manager_name ?? ""} ${w.region_tag ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase())
  )

  const openCreate = () => {
    setEditWarehouse(null)
    setForm({
      warehouse_code: "",
      warehouse_name: "",
      city: "",
      state: "",
      pincode: "",
      latitude: "",
      longitude: "",
    })
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
    })
    setIsDialogOpen(true)
  }
  const handleSave = async () => {
    const payload = editWarehouse ? { id: editWarehouse.id, ...form } : form
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Warehouse Management</h1>
          <p className="mt-1 text-gray-500">Manage warehouse locations</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/zone-layouts">Zone Layout</Link>
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Add Warehouse
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editWarehouse ? "Edit Warehouse" : "Add Warehouse"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Code *</Label>
                    <Input value={form.warehouse_code} onChange={(e) => setForm({ ...form, warehouse_code: e.target.value.toUpperCase() })} className="uppercase" />
                  </div>
                  <div className="space-y-2">
                    <Label>Warehouse Name *</Label>
                    <Input value={form.warehouse_name} onChange={(e) => setForm({ ...form, warehouse_name: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>State</Label>
                    <Input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Pincode</Label>
                  <Input value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Latitude</Label>
                    <Input
                      value={form.latitude}
                      onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                      placeholder="e.g. 13.0827"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Longitude</Label>
                    <Input
                      value={form.longitude}
                      onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                      placeholder="e.g. 80.2707"
                    />
                  </div>
                </div>
                <div className="flex gap-3 pt-2">
                  <Button onClick={handleSave} className="flex-1 bg-blue-600">
                    Save Warehouse
                  </Button>
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="flex-1">
                    Cancel
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <p className="text-base font-semibold">Warehouse Location Map</p>
          <p className="text-sm text-gray-500">Click a marker to open warehouse details</p>
        </CardHeader>
        <CardContent>
          <WarehouseLocationMap
            warehouses={activeWarehouses}
            onSelectWarehouse={(warehouseId) => {
              const selected = warehouses.find((warehouse) => warehouse.id === warehouseId)
              if (selected) openEdit(selected)
            }}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {activeWarehouses.map((w) => {
          const capacityPct = computeCapacityPct(w)
          const clientTotal = (w.client_breakdown ?? []).reduce((sum, row) => sum + Number(row.units || 0), 0) || 1

          return (
            <Card
              key={w.id}
              className="group cursor-pointer overflow-hidden border-l-4 border-blue-500 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl"
              onClick={() => router.push(`/dashboard?warehouse_id=${w.id}`)}
            >
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 transition-colors group-hover:bg-blue-200">
                      <Warehouse className="h-5 w-5 text-blue-700" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{w.warehouse_name}</p>
                      <p className="text-xs text-gray-500">{w.warehouse_code}</p>
                    </div>
                  </div>
                  <Badge className={w.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                    {w.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline" className="bg-slate-50">{w.warehouse_type ?? "Secondary"}</Badge>
                  <Badge variant="outline" className="bg-slate-50">{w.region_tag ?? "Unassigned"}</Badge>
                  <span className="inline-flex items-center gap-1 text-gray-600">
                    <User2 className="h-3.5 w-3.5" />
                    {w.manager_name ?? "Unassigned"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-gray-50 p-2">
                    <p className="text-gray-500">Total Zones</p>
                    <p className="text-sm font-semibold text-gray-900">{(w.total_zones ?? 0).toLocaleString("en-IN")}</p>
                  </div>
                  <div className="rounded-md bg-gray-50 p-2">
                    <p className="text-gray-500">Active SKUs</p>
                    <p className="text-sm font-semibold text-gray-900">{(w.active_skus ?? 0).toLocaleString("en-IN")}</p>
                  </div>
                  <div className="rounded-md bg-gray-50 p-2">
                    <p className="text-gray-500">Open GRNs</p>
                    <p className="text-sm font-semibold text-gray-900">{(w.open_grns ?? 0).toLocaleString("en-IN")}</p>
                  </div>
                  <div className="rounded-md bg-gray-50 p-2">
                    <p className="text-gray-500">Stock Value</p>
                    <p className="text-sm font-semibold text-gray-900">{formatInrCr(Number(w.stock_value ?? 0))}</p>
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
                    <span>Capacity Used</span>
                    <span className="font-semibold text-gray-900">{capacityPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200">
                    <div className="h-2 rounded-full bg-blue-600" style={{ width: `${capacityPct}%` }} />
                  </div>
                </div>

                {(w.client_breakdown ?? []).length > 0 && (
                  <div className="space-y-1">
                    {(w.client_breakdown ?? []).slice(0, 3).map((row) => {
                      const width = Math.max(8, Math.round((row.units / clientTotal) * 100))
                      return (
                        <div key={`${w.id}-${row.client_name}`} className="flex items-center gap-2 text-[11px]">
                          <span className="w-20 truncate text-gray-600" title={row.client_name}>{row.client_name}</span>
                          <div className="h-1.5 flex-1 rounded-full bg-blue-100">
                            <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${width}%` }} />
                          </div>
                          <span className="w-7 text-right text-gray-500">{row.units}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                <p className="inline-flex items-center gap-1 text-xs text-gray-600">
                  <MapPin className="h-3.5 w-3.5" />
                  {[w.city, w.state].filter(Boolean).join(", ") || "Location not set"}
                </p>

                <div className="flex items-center justify-end text-xs font-medium text-blue-700 opacity-0 transition-opacity group-hover:opacity-100">
                  Open warehouse dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            <TypeaheadInput
              className="pl-9"
              value={search}
              onValueChange={setSearch}
              suggestions={searchSuggestions}
              placeholder="Search warehouses..."
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Code</TableHead>
                <TableHead>Warehouse Name</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">No. of Zones</TableHead>
                <TableHead className="text-right">Active SKUs</TableHead>
                <TableHead className="text-right">Open GRNs</TableHead>
                <TableHead className="text-right">Stock Value</TableHead>
                <TableHead>Capacity %</TableHead>
                <TableHead>Client Mix</TableHead>
                <TableHead>Created Date</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((w) => {
                const capacityPct = computeCapacityPct(w)
                return (
                <TableRow key={w.id}>
                  <TableCell className="font-mono font-bold">{w.warehouse_code}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Warehouse className="h-4 w-4 text-gray-400" />
                      <div>
                        <p className="text-sm font-medium">{w.warehouse_name}</p>
                        <p className="text-xs text-gray-500">{[w.city, w.state].filter(Boolean).join(", ") || "-"}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{w.manager_name ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{w.region_tag ?? "Unassigned"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{w.warehouse_type ?? "Secondary"}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">{(w.total_zones ?? 0).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-right font-medium">{(w.active_skus ?? 0).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-right font-medium">{(w.open_grns ?? 0).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-right font-semibold">{formatInrCr(Number(w.stock_value ?? 0))}</TableCell>
                  <TableCell className="min-w-[170px]">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-600">Capacity Used</span>
                        <span className="font-semibold text-gray-900">{capacityPct.toFixed(1)}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-gray-200">
                        <div
                          className="h-2 rounded-full bg-blue-600"
                          style={{ width: `${capacityPct}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-gray-500">
                        {(w.capacity_used_units ?? 0).toLocaleString("en-IN")} / {(w.capacity_total_units ?? 0).toLocaleString("en-IN")} units
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="min-w-[180px]">
                    <div className="space-y-1">
                      {(w.client_breakdown ?? []).slice(0, 3).map((client) => {
                        const maxUnits = Math.max(...(w.client_breakdown ?? []).map((x) => x.units), 1)
                        const width = Math.round((client.units / maxUnits) * 100)
                        return (
                          <div key={`${w.id}-${client.client_name}`} className="flex items-center gap-2 text-[11px]">
                            <span className="w-20 truncate text-gray-600" title={client.client_name}>{client.client_name}</span>
                            <div className="h-1.5 flex-1 rounded-full bg-gray-200">
                              <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${Math.max(8, width)}%` }} />
                            </div>
                            <span className="w-6 text-right text-gray-500">{client.units}</span>
                          </div>
                        )
                      })}
                      {(w.client_breakdown ?? []).length === 0 && <p className="text-xs text-gray-500">No client stock</p>}
                    </div>
                  </TableCell>
                  <TableCell>{formatDate(w.created_at)}</TableCell>
                  <TableCell>{formatDate(w.updated_at)}</TableCell>
                  <TableCell>
                    <Badge className={w.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {w.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(w)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
