"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
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
import { Button } from "@/components/ui/button"

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type MovementRow = {
  id: number
  serial_number: string
  item_code: string
  item_name: string
  warehouse_name: string
  from_bin_location: string
  to_bin_location: string
  remarks?: string
  moved_by_name: string
  moved_by_username?: string
  moved_at: string
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

export default function MovementHistory() {
  const [warehouseId, setWarehouseId] = useState("all")
  const [serial, setSerial] = useState("")
  const [appliedSerial, setAppliedSerial] = useState("")

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const movementsQuery = useQuery({
    queryKey: ["stock", "movements", warehouseId, appliedSerial],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (warehouseId !== "all") params.set("warehouse_id", warehouseId)
      if (appliedSerial) params.set("serial", appliedSerial)
      const res = await apiClient.get<MovementRow[]>(`/stock/movements?${params.toString()}`)
      return res.data ?? []
    },
  })

  const rows = (movementsQuery.data as MovementRow[] | undefined) ?? []
  const serialSuggestions = useMemo(
    () => rows.flatMap((row) => [row.serial_number, row.item_code, row.item_name]),
    [rows]
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-2">
          <Label>Warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Warehouses</SelectItem>
              {(warehousesQuery.data ?? []).map((wh) => (
                <SelectItem key={wh.id} value={String(wh.id)}>
                  {wh.warehouse_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 md:col-span-2">
          <Label>Serial Filter</Label>
          <TypeaheadInput
            value={serial}
            onValueChange={setSerial}
            suggestions={serialSuggestions}
            placeholder="Search serial..."
          />
        </div>

        <div className="flex items-end">
          <Button variant="outline" onClick={() => setAppliedSerial(serial.trim())}>
            Apply
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Serial</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Remarks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{formatDate(row.moved_at)}</TableCell>
                <TableCell>{formatTime(row.moved_at)}</TableCell>
                <TableCell className="font-mono text-xs">{row.serial_number}</TableCell>
                <TableCell>
                  {row.item_name}
                  <div className="text-xs text-gray-500">{row.item_code}</div>
                </TableCell>
                <TableCell>{row.warehouse_name}</TableCell>
                <TableCell className="font-mono text-sm">{row.from_bin_location}</TableCell>
                <TableCell className="font-mono text-sm">{row.to_bin_location}</TableCell>
                <TableCell>
                  {row.moved_by_name || row.moved_by_username || "-"}
                  {row.moved_by_username && row.moved_by_name !== row.moved_by_username ? (
                    <div className="text-xs text-gray-500">{row.moved_by_username}</div>
                  ) : null}
                </TableCell>
                <TableCell>{row.remarks || "-"}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-gray-500">
                  No movement records found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
