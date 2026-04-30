"use client"

import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit,
  Filter,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { downloadFile } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

type ClientOption = {
  id: number
  client_name: string
}

type ItemOption = {
  id: number
  item_code: string
  item_name: string
}

type RateDetail = {
  id?: number
  charge_type: "INBOUND_HANDLING" | "OUTBOUND_HANDLING" | "STORAGE" | "VAS" | "FIXED" | "MINIMUM"
  calc_method?: "FLAT" | "PER_UNIT" | "SLAB" | "PERCENT"
  slab_mode?: "ABSOLUTE" | "MARGINAL"
  item_id?: number | null
  uom?: string
  min_qty?: number | null
  max_qty?: number | null
  free_qty?: number
  unit_rate: number
  min_charge?: number
  max_charge?: number | null
  tax_code?: string
  gst_rate?: number
  is_active?: boolean
}

type RateCard = {
  id: number
  client_id: number
  client_name: string
  rate_card_code: string
  rate_card_name: string
  effective_from: string
  effective_to?: string | null
  billing_cycle: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
  currency: string
  priority: number
  is_active: boolean
  details: RateDetail[]
}

type DetailForm = {
  id?: number
  charge_type: RateDetail["charge_type"]
  calc_method: NonNullable<RateDetail["calc_method"]>
  slab_mode: NonNullable<RateDetail["slab_mode"]>
  item_id: string
  uom: string
  min_qty: string
  max_qty: string
  free_qty: string
  unit_rate: string
  min_charge: string
  max_charge: string
  tax_code: string
  gst_rate: string
  is_active: boolean
}

type FormState = {
  id?: number
  client_id: string
  rate_card_code: string
  rate_card_name: string
  effective_from: string
  effective_to: string
  billing_cycle: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
  currency: string
  priority: string
  is_active: boolean
  notes: string
  details: DetailForm[]
}

function toNum(value: string, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toNumOrNull(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function blankDetail(): DetailForm {
  return {
    charge_type: "STORAGE",
    calc_method: "PER_UNIT",
    slab_mode: "ABSOLUTE",
    item_id: "",
    uom: "UNIT",
    min_qty: "",
    max_qty: "",
    free_qty: "0",
    unit_rate: "0",
    min_charge: "0",
    max_charge: "",
    tax_code: "GST",
    gst_rate: "18",
    is_active: true,
  }
}

function blankForm(clientId?: number): FormState {
  return {
    client_id: clientId ? String(clientId) : "",
    rate_card_code: "",
    rate_card_name: "",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
    billing_cycle: "MONTHLY",
    currency: "INR",
    priority: "100",
    is_active: true,
    notes: "",
    details: [blankDetail()],
  }
}

function dateOnly(value?: string | null) {
  return value?.slice(0, 10) || ""
}

function getRateStatus(row: RateCard) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const effectiveFrom = new Date(row.effective_from)
  effectiveFrom.setHours(0, 0, 0, 0)
  const effectiveTo = row.effective_to ? new Date(row.effective_to) : null
  effectiveTo?.setHours(0, 0, 0, 0)

  if (!row.is_active) return "INACTIVE"
  if (effectiveFrom > today) return "SCHEDULED"
  if (effectiveTo && effectiveTo < today) return "EXPIRED"
  return "ACTIVE"
}

function isExpiringSoon(row: RateCard) {
  if (!row.effective_to || getRateStatus(row) !== "ACTIVE") return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const effectiveTo = new Date(row.effective_to)
  effectiveTo.setHours(0, 0, 0, 0)
  const days = Math.ceil((effectiveTo.getTime() - today.getTime()) / 86_400_000)
  return days >= 0 && days <= 30
}

function calcMethodsLabel(details: RateDetail[]) {
  const methods = Array.from(new Set(details.map((d) => d.calc_method).filter(Boolean)))
  return methods.length ? methods.join(", ") : "Not set"
}

function escapeCsv(value: string | number | null | undefined) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function FinanceRates() {
  const clientsQuery = useQuery({
    queryKey: ["clients", "active", "rates"],
    queryFn: async () => {
      const res = await apiClient.get<ClientOption[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const ratesQuery = useQuery({
    queryKey: ["finance", "rates"],
    queryFn: async () => {
      const res = await apiClient.get<RateCard[]>("/finance/rates")
      return res.data ?? []
    },
  })

  const itemsQuery = useQuery({
    queryKey: ["items", "active", "rates"],
    queryFn: async () => {
      const res = await apiClient.get<ItemOption[]>("/items?is_active=true")
      return res.data ?? []
    },
  })

  const clients = useMemo(() => clientsQuery.data ?? [], [clientsQuery.data])
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data])
  const rates = useMemo(() => ratesQuery.data ?? [], [ratesQuery.data])
  const [search, setSearch] = useState("")
  const [clientFilter, setClientFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [methodFilter, setMethodFilter] = useState("all")
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(blankForm())
  const [deleteTarget, setDeleteTarget] = useState<RateCard | null>(null)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rates.filter(
      (x) => {
        const matchesSearch =
          !term ||
        x.client_name.toLowerCase().includes(term) ||
        x.rate_card_code.toLowerCase().includes(term) ||
        x.rate_card_name.toLowerCase().includes(term)
        const matchesClient = clientFilter === "all" || String(x.client_id) === clientFilter
        const matchesStatus = statusFilter === "all" || getRateStatus(x) === statusFilter
        const matchesMethod = methodFilter === "all" || x.details?.some((d) => d.calc_method === methodFilter)
        return matchesSearch && matchesClient && matchesStatus && matchesMethod
      }
    )
  }, [rates, search, clientFilter, statusFilter, methodFilter])

  const metrics = useMemo(() => {
    const active = rates.filter((row) => getRateStatus(row) === "ACTIVE").length
    const scheduled = rates.filter((row) => getRateStatus(row) === "SCHEDULED").length
    const expiring = rates.filter(isExpiringSoon).length
    const clientsCovered = new Set(rates.map((row) => row.client_id)).size

    return [
      { label: "Total Rate Cards", value: rates.length, tone: "text-gray-900" },
      { label: "Active", value: active, tone: "text-emerald-700" },
      { label: "Scheduled", value: scheduled, tone: "text-blue-700" },
      { label: "Expiring Soon", value: expiring, tone: "text-amber-700" },
      { label: "Clients Covered", value: clientsCovered, tone: "text-gray-900" },
    ]
  }, [rates])

  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPerPage))
  const currentPage = Math.min(page, pageCount)
  const pagedRates = filtered.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage)
  const showingFrom = filtered.length ? (currentPage - 1) * rowsPerPage + 1 : 0
  const showingTo = Math.min(currentPage * rowsPerPage, filtered.length)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        client_id: Number(form.client_id),
        rate_card_code: form.rate_card_code.trim().toUpperCase(),
        rate_card_name: form.rate_card_name.trim(),
        effective_from: form.effective_from,
        effective_to: form.effective_to || null,
        billing_cycle: form.billing_cycle,
        currency: form.currency.trim().toUpperCase() || "INR",
        tax_inclusive: false,
        priority: Number(form.priority || "100"),
        is_active: form.is_active,
        notes: form.notes || null,
        details: form.details.map((d) => ({
          ...(d.id ? { id: d.id } : {}),
          charge_type: d.charge_type,
          calc_method: d.calc_method,
          slab_mode: d.slab_mode,
          item_id: toNumOrNull(d.item_id),
          uom: d.uom.trim() || "UNIT",
          min_qty: toNumOrNull(d.min_qty),
          max_qty: toNumOrNull(d.max_qty),
          free_qty: toNum(d.free_qty, 0),
          unit_rate: toNum(d.unit_rate, 0),
          min_charge: toNum(d.min_charge, 0),
          max_charge: toNumOrNull(d.max_charge),
          tax_code: d.tax_code.trim() || "GST",
          gst_rate: toNum(d.gst_rate, 18),
          is_active: d.is_active,
        })),
      }

      if (form.id) {
        return apiClient.put("/finance/rates", payload)
      }
      return apiClient.post("/finance/rates", payload)
    },
    onSuccess: () => {
      toast.success(form.id ? "Rate card updated" : "Rate card created")
      setOpen(false)
      setForm(blankForm(clients[0]?.id))
      ratesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to save rate card"),
  })

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => apiClient.delete(`/finance/rates?id=${id}`),
    onSuccess: () => {
      toast.success("Rate card deactivated")
      setDeleteTarget(null)
      ratesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to deactivate rate card"),
  })

  const openCreate = () => {
    setForm(blankForm(clients[0]?.id))
    setOpen(true)
  }

  const duplicateRateCard = (row: RateCard) => {
    setForm({
      id: undefined,
      client_id: String(row.client_id),
      rate_card_code: `${row.rate_card_code}_COPY`,
      rate_card_name: `${row.rate_card_name} Copy`,
      effective_from: new Date().toISOString().slice(0, 10),
      effective_to: "",
      billing_cycle: row.billing_cycle || "MONTHLY",
      currency: row.currency || "INR",
      priority: String(row.priority ?? 100),
      is_active: false,
      notes: "",
      details:
        row.details?.map((d) => ({
          charge_type: d.charge_type,
          calc_method: d.calc_method || "PER_UNIT",
          slab_mode: d.slab_mode || "ABSOLUTE",
          item_id: d.item_id == null ? "" : String(d.item_id),
          uom: d.uom || "UNIT",
          min_qty: d.min_qty == null ? "" : String(d.min_qty),
          max_qty: d.max_qty == null ? "" : String(d.max_qty),
          free_qty: String(d.free_qty ?? 0),
          unit_rate: String(d.unit_rate ?? 0),
          min_charge: String(d.min_charge ?? 0),
          max_charge: d.max_charge == null ? "" : String(d.max_charge),
          tax_code: d.tax_code || "GST",
          gst_rate: String(d.gst_rate ?? 18),
          is_active: d.is_active ?? true,
        })) ?? [blankDetail()],
    })
    setOpen(true)
  }

  const openEdit = (row: RateCard) => {
    setForm({
      id: row.id,
      client_id: String(row.client_id),
      rate_card_code: row.rate_card_code,
      rate_card_name: row.rate_card_name,
      effective_from: row.effective_from?.slice(0, 10) || "",
      effective_to: row.effective_to?.slice(0, 10) || "",
      billing_cycle: row.billing_cycle || "MONTHLY",
      currency: row.currency || "INR",
      priority: String(row.priority ?? 100),
      is_active: row.is_active,
      notes: "",
      details:
        row.details?.map((d) => ({
          id: d.id,
          charge_type: d.charge_type,
          calc_method: d.calc_method || "PER_UNIT",
          slab_mode: d.slab_mode || "ABSOLUTE",
          item_id: d.item_id == null ? "" : String(d.item_id),
          uom: d.uom || "UNIT",
          min_qty: d.min_qty == null ? "" : String(d.min_qty),
          max_qty: d.max_qty == null ? "" : String(d.max_qty),
          free_qty: String(d.free_qty ?? 0),
          unit_rate: String(d.unit_rate ?? 0),
          min_charge: String(d.min_charge ?? 0),
          max_charge: d.max_charge == null ? "" : String(d.max_charge),
          tax_code: d.tax_code || "GST",
          gst_rate: String(d.gst_rate ?? 18),
          is_active: d.is_active ?? true,
        })) ?? [blankDetail()],
    })
    setOpen(true)
  }

  const exportRates = () => {
    const headers = ["Code", "Name", "Client", "Status", "Effective From", "Effective To", "Billing Cycle", "Currency", "Rate Types", "Charge Lines"]
    const rows = filtered.map((row) => [
      row.rate_card_code,
      row.rate_card_name,
      row.client_name,
      getRateStatus(row),
      dateOnly(row.effective_from),
      dateOnly(row.effective_to) || "Open",
      row.billing_cycle,
      row.currency,
      calcMethodsLabel(row.details ?? []),
      row.details?.length || 0,
    ])
    const csv = [headers, ...rows].map((line) => line.map(escapeCsv).join(",")).join("\n")
    downloadFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), "rate-cards.csv")
  }

  const statusBadge = (row: RateCard) => {
    const status = getRateStatus(row)
    const className =
      status === "ACTIVE"
        ? "bg-green-100 text-green-800"
        : status === "SCHEDULED"
          ? "bg-blue-100 text-blue-800"
          : status === "EXPIRED"
            ? "bg-amber-100 text-amber-800"
            : "bg-gray-100 text-gray-700"

    return <Badge className={className}>{status}</Badge>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Rate Cards</h1>
          <p className="mt-1 text-gray-500">Contract rate engine setup for FLAT, PER_UNIT, SLAB, and PERCENT</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportRates} disabled={filtered.length === 0}>
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Add Rate Card
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-md border bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{metric.label}</p>
            <p className={`mt-2 text-2xl font-semibold ${metric.tone}`}>{metric.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-md border bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <Input
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="Search rate cards by code, name, or client"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:flex">
            <Select
              value={clientFilter}
              onValueChange={(value) => {
                setClientFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full xl:w-48">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {clients.map((client) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.client_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full xl:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                <SelectItem value="EXPIRED">Expired</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={methodFilter}
              onValueChange={(value) => {
                setMethodFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full xl:w-40">
                <SelectValue placeholder="Rate type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rate types</SelectItem>
                <SelectItem value="FLAT">FLAT</SelectItem>
                <SelectItem value="PER_UNIT">PER_UNIT</SelectItem>
                <SelectItem value="SLAB">SLAB</SelectItem>
                <SelectItem value="PERCENT">PERCENT</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => {
                setSearch("")
                setClientFilter("all")
                setStatusFilter("all")
                setMethodFilter("all")
                setPage(1)
              }}
            >
              <Filter className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50">
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Rate Type</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Charge Lines</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedRates.map((row) => (
              <TableRow key={row.id} className="hover:bg-gray-50/80">
                <TableCell className="font-mono">{row.rate_card_code}</TableCell>
                <TableCell>
                  <div className="font-medium text-gray-900">{row.rate_card_name}</div>
                  <div className="text-xs text-gray-500">{row.billing_cycle} billing - {row.currency}</div>
                </TableCell>
                <TableCell>{row.client_name}</TableCell>
                <TableCell className="text-xs">{calcMethodsLabel(row.details ?? [])}</TableCell>
                <TableCell className="text-xs">
                  <div>{dateOnly(row.effective_from)} to {dateOnly(row.effective_to) || "Open"}</div>
                  {isExpiringSoon(row) ? <div className="mt-1 text-amber-700">Expires within 30 days</div> : null}
                </TableCell>
                <TableCell>{row.details?.length || 0} charge lines</TableCell>
                <TableCell>{statusBadge(row)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="icon-sm" onClick={() => duplicateRateCard(row)} title="Duplicate rate card">
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(row)} title="Edit rate card">
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-red-600"
                      onClick={() => setDeleteTarget(row)}
                      disabled={deactivateMutation.isPending}
                      title="Deactivate rate card"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-gray-500">
                  {ratesQuery.isLoading ? "Loading rate cards..." : "No rate cards match the current filters."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm text-gray-600 md:flex-row md:items-center md:justify-between">
          <div>
            Showing {showingFrom}-{showingTo} of {filtered.length} rate cards
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(rowsPerPage)}
              onValueChange={(value) => {
                setRowsPerPage(Number(value))
                setPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 rows</SelectItem>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-20 text-center">Page {currentPage} of {pageCount}</span>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Rate Card" : "Create Rate Card"}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label>Client</Label>
              <Select value={form.client_id || undefined} onValueChange={(v) => setForm({ ...form, client_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.client_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Rate Card Code</Label>
              <Input value={form.rate_card_code} onChange={(e) => setForm({ ...form, rate_card_code: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Rate Card Name</Label>
              <Input value={form.rate_card_name} onChange={(e) => setForm({ ...form, rate_card_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Priority</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Effective From</Label>
              <Input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Effective To</Label>
              <Input type="date" value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Billing Cycle</Label>
              <Select
                value={form.billing_cycle}
                onValueChange={(v) => setForm({ ...form, billing_cycle: v as "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">MONTHLY</SelectItem>
                  <SelectItem value="WEEKLY">WEEKLY</SelectItem>
                  <SelectItem value="QUARTERLY">QUARTERLY</SelectItem>
                  <SelectItem value="YEARLY">YEARLY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Currency</Label>
              <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Rate Details</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setForm({ ...form, details: [...form.details, blankDetail()] })}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Detail
              </Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Charge</TableHead>
                    <TableHead>Calc</TableHead>
                    <TableHead>Slab Mode</TableHead>
                    <TableHead>Item Id</TableHead>
                    <TableHead>Min Qty</TableHead>
                    <TableHead>Max Qty</TableHead>
                    <TableHead>Unit Rate</TableHead>
                    <TableHead>Min Charge</TableHead>
                    <TableHead>Max Charge</TableHead>
                    <TableHead>GST %</TableHead>
                    <TableHead className="text-right">#</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {form.details.map((d, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Select
                          value={d.charge_type}
                          onValueChange={(v) =>
                            setForm((prev) => ({
                              ...prev,
                              details: prev.details.map((x, i) => (i === idx ? { ...x, charge_type: v as DetailForm["charge_type"] } : x)),
                            }))
                          }
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="INBOUND_HANDLING">INBOUND_HANDLING</SelectItem>
                            <SelectItem value="OUTBOUND_HANDLING">OUTBOUND_HANDLING</SelectItem>
                            <SelectItem value="STORAGE">STORAGE</SelectItem>
                            <SelectItem value="VAS">VAS</SelectItem>
                            <SelectItem value="FIXED">FIXED</SelectItem>
                            <SelectItem value="MINIMUM">MINIMUM</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={d.calc_method}
                          onValueChange={(v) =>
                            setForm((prev) => ({
                              ...prev,
                              details: prev.details.map((x, i) => (i === idx ? { ...x, calc_method: v as DetailForm["calc_method"] } : x)),
                            }))
                          }
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="FLAT">FLAT</SelectItem>
                            <SelectItem value="PER_UNIT">PER_UNIT</SelectItem>
                            <SelectItem value="SLAB">SLAB</SelectItem>
                            <SelectItem value="PERCENT">PERCENT</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={d.slab_mode}
                          onValueChange={(v) =>
                            setForm((prev) => ({
                              ...prev,
                              details: prev.details.map((x, i) => (i === idx ? { ...x, slab_mode: v as DetailForm["slab_mode"] } : x)),
                            }))
                          }
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ABSOLUTE">ABSOLUTE</SelectItem>
                            <SelectItem value="MARGINAL">MARGINAL</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={d.item_id || "any"}
                          onValueChange={(v) =>
                            setForm((prev) => ({
                              ...prev,
                              details: prev.details.map((x, i) => (i === idx ? { ...x, item_id: v === "any" ? "" : v } : x)),
                            }))
                          }
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">Any Item</SelectItem>
                            {items.map((item) => (
                              <SelectItem key={item.id} value={String(item.id)}>
                                {item.item_code} - {item.item_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell><Input value={d.min_qty} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, min_qty: e.target.value } : x)) }))} /></TableCell>
                      <TableCell><Input value={d.max_qty} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, max_qty: e.target.value } : x)) }))} /></TableCell>
                      <TableCell><Input value={d.unit_rate} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, unit_rate: e.target.value } : x)) }))} /></TableCell>
                      <TableCell><Input value={d.min_charge} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, min_charge: e.target.value } : x)) }))} /></TableCell>
                      <TableCell><Input value={d.max_charge} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, max_charge: e.target.value } : x)) }))} /></TableCell>
                      <TableCell><Input value={d.gst_rate} onChange={(e) => setForm((prev) => ({ ...prev, details: prev.details.map((x, i) => (i === idx ? { ...x, gst_rate: e.target.value } : x)) }))} /></TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setForm((prev) => ({ ...prev, details: prev.details.length > 1 ? prev.details.filter((_, i) => i !== idx) : prev.details }))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              disabled={saveMutation.isPending}
              onClick={() => {
                if (!form.client_id || !form.rate_card_code.trim() || !form.rate_card_name.trim()) {
                  toast.error("Client, code and name are required")
                  return
                }
                saveMutation.mutate()
              }}
            >
              {saveMutation.isPending ? "Saving..." : form.id ? "Update Rate Card" : "Create Rate Card"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(value) => !value && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <DialogTitle>Deactivate Rate Card</DialogTitle>
            <DialogDescription>
              This will deactivate {deleteTarget?.rate_card_name} and can affect billing runs that rely on this rate card.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-gray-50 p-3 text-sm">
            <div className="font-mono text-gray-900">{deleteTarget?.rate_card_code}</div>
            <div className="mt-1 text-gray-600">{deleteTarget?.client_name}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!deleteTarget || deactivateMutation.isPending}
              onClick={() => deleteTarget && deactivateMutation.mutate(deleteTarget.id)}
            >
              {deactivateMutation.isPending ? "Deactivating..." : "Deactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
