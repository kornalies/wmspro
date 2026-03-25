"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Eye, FileText, Loader2, Package, Plus, Printer, RotateCcw, Search, XCircle } from "lucide-react"

import { useDO, useDOs, useDispatchDO, useReverseDO } from "@/hooks/use-do"
import { useAdminResource } from "@/hooks/use-admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { DO_STATUSES, DO_STATUS_LABELS, type DOStatus } from "@/lib/do-status"
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
import { DODispatchDialog, type DeliveryOrder } from "@/components/do/DODispatchDialog"

type DOListRow = {
  id: number
  do_number: string
  request_date: string
  created_at: string
  created_by_name?: string | null
  client_name: string
  warehouse_name: string
  status: DOStatus
  total_items: number
  total_quantity_requested: number
  total_quantity_dispatched: number
}

function formatDateTime(value: string) {
  if (!value) return "-"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

export default function DOPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<DOStatus | "all">("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isDispatchOpen, setIsDispatchOpen] = useState(false)

  const listQuery = useDOs({ search, status: statusFilter, warehouse_id: warehouseFilter })
  const detailsQuery = useDO(selectedId)
  const dispatchMutation = useDispatchDO(selectedId || 0)
  const reverseMutation = useReverseDO()
  const warehousesQuery = useAdminResource("warehouses")

  const rows = (listQuery.data?.data as DOListRow[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () => rows.flatMap((row) => [row.do_number, row.client_name]),
    [rows]
  )
  const warehouses = ((warehousesQuery.data as Array<{
    id: number
    warehouse_code?: string
    warehouse_name?: string
    is_active?: boolean
  }> | undefined) ?? []).filter((warehouse) => warehouse.is_active !== false)

  const selectedDO = useMemo<DeliveryOrder | null>(() => {
    if (!detailsQuery.data?.data) return null
    const data = detailsQuery.data.data as {
      id: number
      do_number: string
      client_name: string
      warehouse_name: string
      request_date: string
      status: DOStatus
      items: DeliveryOrder["items"]
    }
    return data
  }, [detailsQuery.data])

  const openDispatch = (id: number) => {
    setSelectedId(id)
    setIsDispatchOpen(true)
  }

  const handleDispatch = async (data: {
    vehicle_number: string
    driver_name: string
    driver_phone: string
    seal_number: string
    dispatch_date: string
    dispatch_time: string
    remarks: string
    items: { item_id: number; quantity: number }[]
  }) => {
    if (!selectedId) return
    await dispatchMutation.mutateAsync(data)
    setIsDispatchOpen(false)
    setSelectedId(null)
  }

  const handleReverse = async (doId: number, doNumber: string, isCancellation = false) => {
    const confirmed = window.confirm(
      isCancellation
        ? `Cancel ${doNumber}?\n\nThis will cancel the DO and release any reserved/dispatched stock back to inventory.`
        : `Reverse ${doNumber}?\n\nThis will restore dispatched stock back to inventory and cancel the DO.`
    )
    if (!confirmed) return
    const reason = window.prompt(isCancellation ? "Cancellation reason (optional):" : "Reversal reason (optional):")?.trim()
    await reverseMutation.mutateAsync({
      id: doId,
      reason: reason || undefined,
    })
  }

  const getStatusBadge = (status: DOStatus) => {
    const colors: Record<string, string> = {
      DRAFT: "border-blue-300 bg-blue-600 text-white",
      PENDING: "border-cyan-300 bg-cyan-600 text-white",
      PICKED: "border-indigo-300 bg-indigo-600 text-white",
      STAGED: "border-violet-300 bg-violet-600 text-white",
      PARTIALLY_FULFILLED: "border-amber-300 bg-amber-500 text-white",
      COMPLETED: "border-emerald-300 bg-emerald-600 text-white",
      CANCELLED: "border-rose-300 bg-rose-600 text-white",
    }
    return (
      <Badge className={`border font-semibold tracking-wide shadow-sm ${colors[status] || "border-slate-300 bg-slate-600 text-white"}`}>
        {DO_STATUS_LABELS[status]}
      </Badge>
    )
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Delivery Orders</h1>
            <p className="mt-1 text-gray-500">Manage outbound deliveries</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/do/waves">
              <Button variant="outline">Waves</Button>
            </Link>
            <Link href="/do/new">
              <Button className="bg-blue-600 hover:bg-blue-700">
                <Plus className="mr-2 h-4 w-4" />
                Create DO
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[
            { label: "Total DOs", value: rows.length, color: "bg-blue-50 border-blue-200 text-blue-900", textColor: "text-blue-600" },
            { label: "Pending", value: rows.filter((d) => d.status === "PENDING" || d.status === "DRAFT").length, color: "bg-yellow-50 border-yellow-200 text-yellow-900", textColor: "text-yellow-600" },
            { label: "Picked", value: rows.filter((d) => d.status === "PICKED").length, color: "bg-indigo-50 border-indigo-200 text-indigo-900", textColor: "text-indigo-600" },
            { label: "Staged", value: rows.filter((d) => d.status === "STAGED").length, color: "bg-purple-50 border-purple-200 text-purple-900", textColor: "text-purple-600" },
            { label: "Completed", value: rows.filter((d) => d.status === "COMPLETED").length, color: "bg-green-50 border-green-200 text-green-900", textColor: "text-green-600" },
            { label: "Partial", value: rows.filter((d) => d.status === "PARTIALLY_FULFILLED").length, color: "bg-orange-50 border-orange-200 text-orange-900", textColor: "text-orange-600" },
          ].map((stat) => (
            <div key={stat.label} className={`rounded-lg border p-4 ${stat.color}`}>
              <p className={`text-sm font-medium ${stat.textColor}`}>{stat.label}</p>
              <p className="mt-1 text-2xl font-bold">{stat.value}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-4">
          <div className="flex flex-1 gap-2">
            <TypeaheadInput
              value={searchInput}
              onValueChange={setSearchInput}
              suggestions={searchSuggestions}
              className="max-w-md"
              placeholder="Search DO number or client"
            />
            <Button variant="secondary" onClick={() => setSearch(searchInput)}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as DOStatus | "all")}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              {DO_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {DO_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="All Warehouses" />
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

        <div className="rounded-lg border bg-white shadow">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>DO Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Created On</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Dispatched</TableHead>
                <TableHead className="text-center">Progress</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="py-8 text-center text-gray-500">
                    No delivery orders found
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((doItem) => {
                  const fulfillmentPercentage =
                    doItem.total_quantity_requested > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (doItem.total_quantity_dispatched / doItem.total_quantity_requested) * 100
                          )
                        )
                      : 0

                  return (
                    <TableRow key={doItem.id} className="hover:bg-gray-50">
                      <TableCell className="font-mono font-medium text-blue-700">
                        <Link
                          href={`/do/${encodeURIComponent(doItem.do_number)}/fulfill`}
                          className="hover:underline"
                        >
                          {doItem.do_number}
                        </Link>
                      </TableCell>
                      <TableCell>{doItem.request_date}</TableCell>
                      <TableCell>{doItem.client_name}</TableCell>
                      <TableCell>{doItem.warehouse_name}</TableCell>
                      <TableCell>{formatDateTime(doItem.created_at)}</TableCell>
                      <TableCell>{doItem.created_by_name || "-"}</TableCell>
                      <TableCell className="text-right">{doItem.total_items}</TableCell>
                      <TableCell className="text-right">{doItem.total_quantity_requested}</TableCell>
                      <TableCell className="text-right">{doItem.total_quantity_dispatched}</TableCell>
                      <TableCell className="w-32">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-gray-200">
                            <div
                              className={`h-2 rounded-full ${
                                fulfillmentPercentage === 100
                                  ? "bg-green-500"
                                  : fulfillmentPercentage > 0
                                    ? "bg-yellow-500"
                                    : "bg-blue-500"
                              }`}
                              style={{ width: `${fulfillmentPercentage}%` }}
                            />
                          </div>
                          <span className="w-8 text-xs text-gray-500">{fulfillmentPercentage}%</span>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(doItem.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="sm" title="View">
                            <Link href={`/do/${encodeURIComponent(doItem.do_number)}/fulfill`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button asChild variant="ghost" size="sm" title="Print DO">
                            <a
                              href={`/api/do/${encodeURIComponent(doItem.do_number)}/download?profile=dispatch_note`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Printer className="h-4 w-4 text-slate-700" />
                            </a>
                          </Button>
                          <Button asChild variant="ghost" size="sm" title="Print Packing Slip">
                            <a
                              href={`/api/do/${encodeURIComponent(doItem.do_number)}/download?profile=packing_slip`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <FileText className="h-4 w-4 text-indigo-700" />
                            </a>
                          </Button>
                          {(doItem.status === "STAGED" || doItem.status === "PARTIALLY_FULFILLED") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-blue-600"
                              title="Fulfill"
                              onClick={() => openDispatch(doItem.id)}
                            >
                              <Package className="h-4 w-4" />
                            </Button>
                          )}
                          {doItem.status !== "COMPLETED" && doItem.status !== "CANCELLED" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600"
                              title="Cancel DO"
                              disabled={reverseMutation.isPending}
                              onClick={() => handleReverse(doItem.id, doItem.do_number, true)}
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                          )}
                          {doItem.status === "COMPLETED" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600"
                              title="Reverse DO"
                              disabled={reverseMutation.isPending}
                              onClick={() => handleReverse(doItem.id, doItem.do_number)}
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <DODispatchDialog
        key={selectedId ?? 0}
        deliveryOrder={selectedDO}
        isOpen={isDispatchOpen}
        onClose={() => {
          setIsDispatchOpen(false)
          setSelectedId(null)
        }}
        onDispatch={handleDispatch}
      />
    </>
  )
}
