"use client"

import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
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

type PutawayStockRow = {
  id: number
  serial_number: string
  item_code: string
  item_name: string
  current_bin_location: string
}

export default function TransferForm() {
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  const initialWarehouseId = searchParams.get("warehouse_id")?.trim() || ""
  const initialSerialFilter = searchParams.get("serial")?.trim() || ""
  const initialItemFilter = searchParams.get("item")?.trim() || ""
  const initialFromZoneLayoutId = searchParams.get("from_zone_layout_id")?.trim() || "all"

  const [warehouseId, setWarehouseId] = useState(initialWarehouseId)
  const [serialFilter, setSerialFilter] = useState(initialSerialFilter)
  const [itemFilter, setItemFilter] = useState(initialItemFilter)
  const [fromZoneLayoutId, setFromZoneLayoutId] = useState(initialFromZoneLayoutId)
  const [toZoneLayoutId, setToZoneLayoutId] = useState("")
  const [remarks, setRemarks] = useState("")
  const [applied, setApplied] = useState({ serial: initialSerialFilter, item: initialItemFilter })
  const [selectedStockIds, setSelectedStockIds] = useState<number[]>([])

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
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
    queryKey: ["stock", "putaway", warehouseId, applied.serial, applied.item, fromZoneLayoutId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const params = new URLSearchParams({ warehouse_id: warehouseId })
      if (applied.serial) params.set("serial", applied.serial)
      if (applied.item) params.set("item", applied.item)
      if (fromZoneLayoutId !== "all") params.set("from_zone_layout_id", fromZoneLayoutId)

      const res = await apiClient.get<PutawayStockRow[]>(`/stock/putaway?${params.toString()}`)
      return res.data ?? []
    },
  })

  const transferMutation = useMutation({
    mutationFn: async () =>
      apiClient.post("/stock/putaway", {
        stock_ids: selectedStockIds,
        to_zone_layout_id: Number(toZoneLayoutId),
        remarks: remarks || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["stock", "putaway"] })
      qc.invalidateQueries({ queryKey: ["stock", "search"] })
      qc.invalidateQueries({ queryKey: ["stock", "movements"] })
      setSelectedStockIds([])
      setRemarks("")
      const moved = (res.data as { moved_count?: number } | undefined)?.moved_count ?? 0
      toast.success(`Put away completed for ${moved} serial(s)`)
    },
    onError: (error) => handleError(error, "Put away transfer failed"),
  })

  const layouts = layoutsQuery.data ?? []
  const stockRows = useMemo(() => (stockQuery.data as PutawayStockRow[] | undefined) ?? [], [stockQuery.data])

  const allSelected = useMemo(
    () => stockRows.length > 0 && stockRows.every((row) => selectedStockIds.includes(row.id)),
    [stockRows, selectedStockIds]
  )

  const toggleSelection = (id: number) => {
    setSelectedStockIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedStockIds((prev) => prev.filter((id) => !stockRows.some((row) => row.id === id)))
      return
    }
    const ids = stockRows.map((row) => row.id)
    setSelectedStockIds((prev) => Array.from(new Set([...prev, ...ids])))
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label>Warehouse *</Label>
          <Select
            value={warehouseId}
            onValueChange={(value) => {
              setWarehouseId(value)
              setFromZoneLayoutId("all")
              setToZoneLayoutId("")
              setSelectedStockIds([])
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select warehouse" />
            </SelectTrigger>
            <SelectContent>
              {(warehousesQuery.data ?? []).map((wh) => (
                <SelectItem key={wh.id} value={String(wh.id)}>
                  {wh.warehouse_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>From Bin (Optional)</Label>
          <Select value={fromZoneLayoutId} onValueChange={setFromZoneLayoutId} disabled={!warehouseId}>
            <SelectTrigger>
              <SelectValue placeholder="Any source bin" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any source bin</SelectItem>
              {layouts.map((layout) => (
                <SelectItem key={layout.id} value={String(layout.id)}>
                  {layout.zone_code}/{layout.rack_code}/{layout.bin_code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>To Bin *</Label>
          <Select value={toZoneLayoutId} onValueChange={setToZoneLayoutId} disabled={!warehouseId}>
            <SelectTrigger>
              <SelectValue placeholder="Select destination bin" />
            </SelectTrigger>
            <SelectContent>
              {layouts.map((layout) => (
                <SelectItem key={layout.id} value={String(layout.id)}>
                  {layout.zone_code}/{layout.rack_code}/{layout.bin_code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-2">
          <Label>Serial Filter</Label>
          <TypeaheadInput
            value={serialFilter}
            onValueChange={setSerialFilter}
            suggestions={stockRows.map((row) => row.serial_number)}
            placeholder="Search serial..."
          />
        </div>
        <div className="space-y-2">
          <Label>Item Filter</Label>
          <TypeaheadInput
            value={itemFilter}
            onValueChange={setItemFilter}
            suggestions={stockRows.flatMap((row) => [row.item_code, row.item_name])}
            placeholder="Item code/name..."
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>Remarks</Label>
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Reason for movement (optional)" />
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setApplied({ serial: serialFilter.trim(), item: itemFilter.trim() })}
          disabled={!warehouseId}
        >
          <Search className="mr-2 h-4 w-4" />
          Search Stock
        </Button>
        <Button
          type="button"
          className="bg-blue-600 hover:bg-blue-700"
          disabled={!toZoneLayoutId || selectedStockIds.length === 0 || transferMutation.isPending}
          onClick={() => transferMutation.mutate()}
        >
          Move Selected ({selectedStockIds.length})
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44px]">
                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              </TableHead>
              <TableHead>Serial</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Current Bin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stockRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={selectedStockIds.includes(row.id)}
                    onChange={() => toggleSelection(row.id)}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">{row.serial_number}</TableCell>
                <TableCell>
                  {row.item_name}
                  <div className="text-xs text-gray-500">{row.item_code}</div>
                </TableCell>
                <TableCell className="font-mono text-sm">{row.current_bin_location}</TableCell>
              </TableRow>
            ))}
            {stockRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-gray-500">
                  {warehouseId ? "No stock found for selected filters." : "Select a warehouse to start."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
