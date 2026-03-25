"use client"

import { useMemo, useState } from "react"
import { Edit, Layers3, Plus, Search } from "lucide-react"
import { useQuery } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { useSaveAdminResource } from "@/hooks/use-admin"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
  sort_order?: number
  is_active: boolean
}

type WarehouseOption = {
  id: number
  warehouse_name: string
}

export default function ZoneLayoutsPage() {
  const saveMutation = useSaveAdminResource("zone-layouts")

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const [search, setSearch] = useState("")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<ZoneLayoutRow | null>(null)
  const [form, setForm] = useState({
    warehouse_id: "",
    zone_code: "",
    zone_name: "",
    rack_code: "",
    rack_name: "",
    bin_code: "",
    bin_name: "",
    capacity_units: "",
    sort_order: "0",
  })

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
  const rows = useMemo(() => (layoutsQuery.data as ZoneLayoutRow[] | undefined) ?? [], [layoutsQuery.data])
  const warehouses = useMemo(() => warehousesQuery.data ?? [], [warehousesQuery.data])
  const warehouseMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.warehouse_name])), [warehouses])

  const filtered = rows.filter((row) => {
    const term = search.toLowerCase()
    const warehouseName = row.warehouse_name ?? warehouseMap.get(row.warehouse_id) ?? ""
    return (
      row.zone_code.toLowerCase().includes(term) ||
      row.zone_name.toLowerCase().includes(term) ||
      row.rack_code.toLowerCase().includes(term) ||
      row.rack_name.toLowerCase().includes(term) ||
      row.bin_code.toLowerCase().includes(term) ||
      row.bin_name.toLowerCase().includes(term) ||
      warehouseName.toLowerCase().includes(term)
    )
  })
  const searchSuggestions = useMemo(
    () =>
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
        ]
      }),
    [rows, warehouseMap]
  )

  const openCreate = () => {
    setEditRow(null)
    setForm({
      warehouse_id: "",
      zone_code: "",
      zone_name: "",
      rack_code: "",
      rack_name: "",
      bin_code: "",
      bin_name: "",
      capacity_units: "",
      sort_order: "0",
    })
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

  const handleSave = async () => {
    const payload = {
      warehouse_id: Number(form.warehouse_id),
      zone_code: form.zone_code.trim().toUpperCase(),
      zone_name: form.zone_name.trim(),
      rack_code: form.rack_code.trim().toUpperCase(),
      rack_name: form.rack_name.trim(),
      bin_code: form.bin_code.trim().toUpperCase(),
      bin_name: form.bin_name.trim(),
      capacity_units: form.capacity_units ? Number(form.capacity_units) : undefined,
      sort_order: Number(form.sort_order || 0),
      ...(editRow ? { id: editRow.id } : {}),
    }

    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Zone Layout</h1>
          <p className="mt-1 text-gray-500">Warehouse structure: Zone {"->"} Rack {"->"} Bin</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> Add Bin Layout
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editRow ? "Edit Zone Layout" : "Add Zone Layout"}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 pt-4">
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Zone Code *</Label>
                  <Input value={form.zone_code} onChange={(e) => setForm({ ...form, zone_code: e.target.value.toUpperCase() })} className="uppercase" />
                </div>
                <div className="space-y-2">
                  <Label>Zone Name *</Label>
                  <Input value={form.zone_name} onChange={(e) => setForm({ ...form, zone_name: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Rack Code *</Label>
                  <Input value={form.rack_code} onChange={(e) => setForm({ ...form, rack_code: e.target.value.toUpperCase() })} className="uppercase" />
                </div>
                <div className="space-y-2">
                  <Label>Rack Name *</Label>
                  <Input value={form.rack_name} onChange={(e) => setForm({ ...form, rack_name: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Bin Code *</Label>
                  <Input value={form.bin_code} onChange={(e) => setForm({ ...form, bin_code: e.target.value.toUpperCase() })} className="uppercase" />
                </div>
                <div className="space-y-2">
                  <Label>Bin Name *</Label>
                  <Input value={form.bin_name} onChange={(e) => setForm({ ...form, bin_name: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Capacity Units</Label>
                  <Input type="number" min={0} value={form.capacity_units} onChange={(e) => setForm({ ...form, capacity_units: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Sort Order</Label>
                  <Input type="number" min={0} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button onClick={handleSave} className="flex-1 bg-blue-600">
                  Save Layout
                </Button>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <TypeaheadInput
                className="pl-9"
                value={search}
                onValueChange={setSearch}
                suggestions={searchSuggestions}
                placeholder="Search zone/rack/bin..."
              />
            </div>
            <div className="w-full md:w-[280px]">
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                      {warehouse.warehouse_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Warehouse</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Rack</TableHead>
                <TableHead>Bin</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.warehouse_name ?? warehouseMap.get(row.warehouse_id)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Layers3 className="h-4 w-4 text-gray-400" />
                      <span className="font-mono text-sm">{row.zone_code}</span>
                      <span className="text-gray-500">{row.zone_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-sm">{row.rack_code}</span> {row.rack_name}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-sm">{row.bin_code}</span> {row.bin_name}
                  </TableCell>
                  <TableCell className="text-right">{row.capacity_units ?? "-"}</TableCell>
                  <TableCell>
                    <Badge className={row.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {row.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
