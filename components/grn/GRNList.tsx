"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { CheckCircle2, Eye, FileText, Loader2, Pencil, Search, XCircle } from "lucide-react"

import { useCancelGRN, useConfirmDraftGRN, useGRNs } from "@/hooks/use-grn"
import { useAdminResource } from "@/hooks/use-admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

function formatDate(dateStr: string): string {
  if (!dateStr) return "-"
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

function formatDateTime(dateStr: string): string {
  if (!dateStr) return "-"
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

export function GRNList() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")

  const limit = 20
  const { data, isLoading, error, isFetching } = useGRNs({
    page,
    limit,
    status: statusFilter,
    search,
    warehouse_id: warehouseFilter,
  })
  const warehousesQuery = useAdminResource("warehouses")
  const cancelMutation = useCancelGRN()
  const confirmDraftMutation = useConfirmDraftGRN()

  const rows = data?.data ?? []
  const searchSuggestions = useMemo(
    () => rows.flatMap((grn) => [grn.grn_number, grn.invoice_number, grn.client_name]),
    [rows]
  )
  const pagination = data?.pagination
  const total = pagination?.total ?? rows.length
  const totalPages = pagination?.totalPages ?? 1
  const warehouses = ((warehousesQuery.data as Array<{
    id: number
    warehouse_code?: string
    warehouse_name?: string
    is_active?: boolean
  }> | undefined) ?? []).filter((warehouse) => warehouse.is_active !== false)

  const counts = rows.reduce(
    (acc, grn) => {
      acc.total += 1
      if (grn.status === "COMPLETED") acc.completed += 1
      if (grn.status === "DRAFT") acc.draft += 1
      if (grn.status === "CANCELLED") acc.cancelled += 1
      return acc
    },
    { total: 0, completed: 0, draft: 0, cancelled: 0 }
  )

  const handleSearch = () => {
    setSearch(searchInput.trim())
    setPage(1)
  }

  const handleStatusChange = (value: string) => {
    setStatusFilter(value)
    setPage(1)
  }

  const handleWarehouseChange = (value: string) => {
    setWarehouseFilter(value)
    setPage(1)
  }

  const handleCancel = async (id: number) => {
    const yes = window.confirm("Cancel this GRN?")
    if (!yes) return
    await cancelMutation.mutateAsync(id)
  }

  const handleConfirmDraft = async (id: number) => {
    const yes = window.confirm("Confirm this draft GRN? This will post stock to inventory.")
    if (!yes) return
    await confirmDraftMutation.mutateAsync(id)
  }

  const getStatusBadge = (status: string) => {
    const classes: Record<string, string> = {
      COMPLETED: "bg-green-100 text-green-800 border-green-200",
      DRAFT: "bg-yellow-100 text-yellow-800 border-yellow-200",
      CANCELLED: "bg-red-100 text-red-800 border-red-200",
    }

    return (
      <Badge className={classes[status] || "bg-gray-100 text-gray-800 border-gray-200"}>
        {status}
      </Badge>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">GRN (Goods Receipt Notes)</h1>
          <p className="mt-1 text-slate-600 dark:text-slate-300">Manage incoming goods receipts</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/grn/mobile-approvals">Mobile GRN Approval</Link>
          </Button>
          <Button asChild className="bg-blue-600 hover:bg-blue-700">
            <Link href="/grn/new">Create GRN</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm text-blue-700">This Page</p>
          <p className="text-2xl font-bold text-blue-900">{counts.total}</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-700">Completed</p>
          <p className="text-2xl font-bold text-green-900">{counts.completed}</p>
        </div>
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <p className="text-sm text-yellow-700">Draft</p>
          <p className="text-2xl font-bold text-yellow-900">{counts.draft}</p>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">Cancelled</p>
          <p className="text-2xl font-bold text-red-900">{counts.cancelled}</p>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex max-w-md flex-1 gap-2">
          <TypeaheadInput
            placeholder="Search by GRN number or invoice number"
            value={searchInput}
            onValueChange={setSearchInput}
            suggestions={searchSuggestions}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <Button onClick={handleSearch} variant="secondary">
            <Search className="h-4 w-4" />
          </Button>
        </div>

        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        <Select value={warehouseFilter} onValueChange={handleWarehouseChange}>
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

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load GRNs: {error.message}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 dark:bg-slate-900">
              <TableHead>GRN Number</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Invoice No.</TableHead>
              <TableHead>Created On</TableHead>
              <TableHead>Created By</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="py-12 text-center text-muted-foreground">
                  No GRNs found
                </TableCell>
              </TableRow>
            ) : (
              rows.map((grn) => (
                <TableRow key={grn.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  <TableCell className="font-medium text-blue-700">{grn.grn_number}</TableCell>
                  <TableCell>{formatDate(grn.grn_date)}</TableCell>
                  <TableCell>{grn.client_name}</TableCell>
                  <TableCell>{grn.warehouse_name}</TableCell>
                  <TableCell className="font-mono text-sm">{grn.invoice_number}</TableCell>
                  <TableCell>{formatDateTime(grn.created_at)}</TableCell>
                  <TableCell>{grn.created_by_name || "-"}</TableCell>
                  <TableCell className="text-right">{grn.total_items}</TableCell>
                  <TableCell className="text-right">{grn.total_quantity}</TableCell>
                  <TableCell>{getStatusBadge(grn.status)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button asChild variant="ghost" size="sm" title="View GRN">
                        <Link href={`/grn/${grn.id}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm" title="Print GRN">
                        <Link href={`/grn/print/${grn.id}`}>
                          <FileText className="h-4 w-4" />
                        </Link>
                      </Button>
                      {grn.status === "DRAFT" && (
                        <>
                          <Button asChild variant="ghost" size="sm" title="Edit Draft">
                            <Link href={`/grn/${grn.id}/edit`}>
                              <Pencil className="h-4 w-4 text-amber-700" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Confirm Draft"
                            disabled={confirmDraftMutation.isPending}
                            onClick={() => handleConfirmDraft(grn.id)}
                          >
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Cancel GRN"
                        disabled={cancelMutation.isPending || grn.status === "CANCELLED"}
                        onClick={() => handleCancel(grn.id)}
                      >
                        <XCircle className="h-4 w-4 text-red-600" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Page {page} of {totalPages} ({total} records)
          {isFetching ? " • refreshing..." : ""}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </Button>
          <Button
            variant="outline"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
