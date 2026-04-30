"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Eye, Loader2, Plus, Search } from "lucide-react"

import { useFreightShipments } from "@/hooks/use-freight"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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

type ShipmentRow = {
  id: number
  shipment_no: string
  mode: "AIR" | "SEA" | "ROAD"
  direction: "IMPORT" | "EXPORT" | "DOMESTIC"
  status: "DRAFT" | "BOOKED" | "IN_TRANSIT" | "CUSTOMS_HOLD" | "ARRIVED" | "DELIVERED" | "CANCELLED"
  origin: string
  destination: string
  client_name?: string | null
  etd?: string | null
  eta?: string | null
}

function statusClass(status: ShipmentRow["status"]) {
  if (status === "DELIVERED") return "border-emerald-300 bg-emerald-600 text-white"
  if (status === "IN_TRANSIT") return "border-cyan-300 bg-cyan-600 text-white"
  if (status === "CUSTOMS_HOLD") return "border-amber-300 bg-amber-500 text-white"
  if (status === "CANCELLED") return "border-rose-300 bg-rose-600 text-white"
  return "border-slate-300 bg-slate-600 text-white"
}

export default function FreightShipmentsPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [mode, setMode] = useState("all")

  const listQuery = useFreightShipments({ search, status, mode })
  const rows = listQuery.data?.data as ShipmentRow[] | undefined
  const visibleRows = rows ?? []
  const searchSuggestions = useMemo(
    () => (rows ?? []).flatMap((row) => [row.shipment_no, row.origin, row.destination, row.client_name || ""]),
    [rows]
  )

  if (listQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Freight Forwarding</h1>
          <p className="mt-1 text-slate-600 dark:text-slate-300">Manage forwarding shipments and milestones</p>
        </div>
        <Link href="/freight/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Shipment
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-medium text-blue-600">Total</p>
          <p className="text-2xl font-bold text-blue-900">{visibleRows.length}</p>
        </div>
        <div className="rounded-lg border border-cyan-200 bg-cyan-50 p-4">
          <p className="text-sm font-medium text-cyan-700">In Transit</p>
          <p className="text-2xl font-bold text-cyan-900">{visibleRows.filter((row) => row.status === "IN_TRANSIT").length}</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-700">Delivered</p>
          <p className="text-2xl font-bold text-green-900">{visibleRows.filter((row) => row.status === "DELIVERED").length}</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-700">Customs Hold</p>
          <p className="text-2xl font-bold text-amber-900">{visibleRows.filter((row) => row.status === "CUSTOMS_HOLD").length}</p>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 gap-2">
          <TypeaheadInput
            value={searchInput}
            onValueChange={setSearchInput}
            suggestions={searchSuggestions}
            placeholder="Search shipment, origin, destination, client"
          />
          <Button variant="secondary" onClick={() => setSearch(searchInput)}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modes</SelectItem>
            <SelectItem value="AIR">AIR</SelectItem>
            <SelectItem value="SEA">SEA</SelectItem>
            <SelectItem value="ROAD">ROAD</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="DRAFT">DRAFT</SelectItem>
            <SelectItem value="BOOKED">BOOKED</SelectItem>
            <SelectItem value="IN_TRANSIT">IN_TRANSIT</SelectItem>
            <SelectItem value="CUSTOMS_HOLD">CUSTOMS_HOLD</SelectItem>
            <SelectItem value="ARRIVED">ARRIVED</SelectItem>
            <SelectItem value="DELIVERED">DELIVERED</SelectItem>
            <SelectItem value="CANCELLED">CANCELLED</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-white shadow-sm dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shipment</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No shipments found
                </TableCell>
              </TableRow>
            )}
            {visibleRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <p className="font-mono font-medium">{row.shipment_no}</p>
                  <p className="text-xs text-muted-foreground">{row.direction}</p>
                </TableCell>
                <TableCell>{row.mode}</TableCell>
                <TableCell>{row.origin} {"->"} {row.destination}</TableCell>
                <TableCell>{row.client_name || "-"}</TableCell>
                <TableCell>
                  <Badge className={`border ${statusClass(row.status)}`}>{row.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Link href={`/freight/${row.id}`}>
                    <Button size="sm" variant="outline">
                      <Eye className="mr-1 h-4 w-4" />
                      Open
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
