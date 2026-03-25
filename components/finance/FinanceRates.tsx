"use client"

import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Edit, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
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

  const clients = clientsQuery.data ?? []
  const items = itemsQuery.data ?? []
  const rates = ratesQuery.data ?? []
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(blankForm())

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rates
    return rates.filter(
      (x) =>
        x.client_name.toLowerCase().includes(term) ||
        x.rate_card_code.toLowerCase().includes(term) ||
        x.rate_card_name.toLowerCase().includes(term)
    )
  }, [rates, search])

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
      ratesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to deactivate rate card"),
  })

  const openCreate = () => {
    setForm(blankForm(clients[0]?.id))
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Rate Cards</h1>
          <p className="mt-1 text-gray-500">Contract rate engine setup for FLAT, PER_UNIT, SLAB, and PERCENT</p>
        </div>
        <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Rate Card
        </Button>
      </div>

      <div className="max-w-md">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by code/name/client" />
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50">
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono">{row.rate_card_code}</TableCell>
                <TableCell>{row.rate_card_name}</TableCell>
                <TableCell>{row.client_name}</TableCell>
                <TableCell className="text-xs">
                  {row.effective_from?.slice(0, 10)} to {row.effective_to?.slice(0, 10) || "Open"}
                </TableCell>
                <TableCell>{row.details?.length || 0}</TableCell>
                <TableCell>
                  <Badge className={row.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"}>
                    {row.is_active ? "ACTIVE" : "INACTIVE"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600"
                      onClick={() => deactivateMutation.mutate(row.id)}
                      disabled={deactivateMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-gray-500">
                  No rate cards found.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
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
    </div>
  )
}
