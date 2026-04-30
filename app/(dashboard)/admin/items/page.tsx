"use client"

import { useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  MoreHorizontal,
  Package,
  Plus,
  Search,
  ShieldAlert,
  Tags,
  Upload,
  X,
} from "lucide-react"
import * as XLSX from "xlsx"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { exportItemsToExcel, exportItemTemplateToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TypeaheadInput } from "@/components/ui/typeahead-input"

type ItemRow = {
  id: number
  item_code: string
  item_name: string
  category_id?: number | null
  hsn_code?: string
  uom: string
  standard_mrp?: number | string | null
  min_stock_alert?: number | string | null
  is_active: boolean
}

type StatusFilter = "all" | "active" | "inactive" | "missing-hsn" | "zero-mrp" | "no-min-alert" | "incomplete"
type SortKey = "item_code" | "item_name" | "hsn_code" | "uom" | "standard_mrp" | "min_stock_alert" | "is_active"

const ITEMS_PER_PAGE = 12

function blankForm() {
  return {
    item_code: "",
    item_name: "",
    category_id: "",
    hsn_code: "",
    uom: "PCS",
    standard_mrp: 0,
    min_stock_alert: 0,
    is_active: true,
  }
}

function money(value?: number | string | null) {
  const amount = Number(value ?? 0)
  return `INR ${Number.isFinite(amount) ? amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}`
}

function numberValue(value?: number | string | null) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function getCompleteness(item: ItemRow) {
  const checks = [
    Boolean(item.item_code),
    Boolean(item.item_name),
    Boolean(item.uom),
    Boolean(item.hsn_code),
    numberValue(item.standard_mrp) > 0,
    numberValue(item.min_stock_alert) > 0,
    Boolean(item.category_id),
  ]
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100)
  const warnings = [
    !item.hsn_code ? "Missing HSN" : "",
    numberValue(item.standard_mrp) <= 0 ? "Zero MRP" : "",
    numberValue(item.min_stock_alert) <= 0 ? "No min alert" : "",
    !item.category_id ? "No category" : "",
  ].filter(Boolean)
  return { score, warnings }
}

function CompletenessBadge({ item }: { item: ItemRow }) {
  const score = getCompleteness(item).score
  const className =
    score >= 85
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : score >= 60
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-rose-200 bg-rose-50 text-rose-700"
  return <Badge variant="outline" className={className}>{score}% complete</Badge>
}

export default function ItemsPage() {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const itemsQuery = useAdminResource("items")
  const saveMutation = useSaveAdminResource("items")
  const deleteMutation = useDeleteAdminResource("items")

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [uomFilter, setUomFilter] = useState("all")
  const [hsnFilter, setHsnFilter] = useState("all")
  const [minMrp, setMinMrp] = useState("")
  const [maxMrp, setMaxMrp] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("item_name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editItem, setEditItem] = useState<ItemRow | null>(null)
  const [detailsItem, setDetailsItem] = useState<ItemRow | null>(null)
  const [actionItem, setActionItem] = useState<ItemRow | null>(null)
  const [deactivateItem, setDeactivateItem] = useState<ItemRow | null>(null)
  const [form, setForm] = useState(blankForm)

  const items = (itemsQuery.data as ItemRow[] | undefined) ?? []
  const selectedItems = items.filter((item) => selectedIds.includes(item.id))
  const searchSuggestions = useMemo(
    () => items.flatMap((item) => [item.item_code, item.item_name, item.hsn_code || "", item.uom]),
    [items]
  )
  const uomOptions = useMemo(() => Array.from(new Set(items.map((item) => item.uom).filter(Boolean))), [items])

  const duplicateWarnings = useMemo(() => {
    const code = form.item_code.trim().toLowerCase()
    const name = form.item_name.trim().toLowerCase()
    return items
      .filter((item) => item.id !== editItem?.id)
      .flatMap((item) => [
        code && item.item_code.trim().toLowerCase() === code ? "Item code already exists" : "",
        name && item.item_name.trim().toLowerCase() === name ? "Item name already exists" : "",
      ])
      .filter(Boolean)
  }, [editItem, form.item_code, form.item_name, items])

  const metrics = useMemo(() => {
    const active = items.filter((item) => item.is_active).length
    return {
      active,
      inactive: items.length - active,
      missingHsn: items.filter((item) => !item.hsn_code).length,
      lowAlertConfigured: items.filter((item) => numberValue(item.min_stock_alert) > 0).length,
      zeroMrp: items.filter((item) => numberValue(item.standard_mrp) <= 0).length,
    }
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const min = minMrp ? Number(minMrp) : null
    const max = maxMrp ? Number(maxMrp) : null
    const rows = items.filter((item) => {
      const completeness = getCompleteness(item)
      const mrp = numberValue(item.standard_mrp)
      const matchesSearch =
        !q ||
        [item.item_code, item.item_name, item.hsn_code, item.uom].some((value) =>
          String(value || "").toLowerCase().includes(q)
        )
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && item.is_active) ||
        (statusFilter === "inactive" && !item.is_active) ||
        (statusFilter === "missing-hsn" && !item.hsn_code) ||
        (statusFilter === "zero-mrp" && mrp <= 0) ||
        (statusFilter === "no-min-alert" && numberValue(item.min_stock_alert) <= 0) ||
        (statusFilter === "incomplete" && completeness.score < 85)
      const matchesUom = uomFilter === "all" || item.uom === uomFilter
      const matchesHsn =
        hsnFilter === "all" ||
        (hsnFilter === "present" && Boolean(item.hsn_code)) ||
        (hsnFilter === "missing" && !item.hsn_code)
      const matchesMrp = (min === null || mrp >= min) && (max === null || mrp <= max)
      return matchesSearch && matchesStatus && matchesUom && matchesHsn && matchesMrp
    })

    return [...rows].sort((a, b) => {
      const leftRaw = a[sortKey]
      const rightRaw = b[sortKey]
      const left = typeof leftRaw === "number" ? leftRaw : String(leftRaw ?? "").toLowerCase()
      const right = typeof rightRaw === "number" ? rightRaw : String(rightRaw ?? "").toLowerCase()
      const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right))
      return sortDir === "asc" ? result : -result
    })
  }, [hsnFilter, items, maxMrp, minMrp, search, sortDir, sortKey, statusFilter, uomFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE))
  const effectivePage = Math.min(currentPage, totalPages)
  const paginatedItems = filtered.slice((effectivePage - 1) * ITEMS_PER_PAGE, effectivePage * ITEMS_PER_PAGE)
  const allVisibleSelected = paginatedItems.length > 0 && paginatedItems.every((item) => selectedIds.includes(item.id))

  const openCreate = () => {
    setEditItem(null)
    setForm(blankForm())
    setIsDialogOpen(true)
  }

  const openEdit = (item: ItemRow) => {
    setEditItem(item)
    setForm({
      item_code: item.item_code,
      item_name: item.item_name,
      category_id: item.category_id ? String(item.category_id) : "",
      hsn_code: item.hsn_code || "",
      uom: item.uom,
      standard_mrp: numberValue(item.standard_mrp),
      min_stock_alert: numberValue(item.min_stock_alert),
      is_active: item.is_active,
    })
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.item_code || !form.item_name || !form.uom || duplicateWarnings.length > 0) return
    const payload = {
      ...(editItem ? { id: editItem.id } : {}),
      item_code: form.item_code.trim(),
      item_name: form.item_name.trim(),
      category_id: form.category_id ? Number(form.category_id) : undefined,
      hsn_code: form.hsn_code.trim(),
      uom: form.uom.trim().toUpperCase(),
      standard_mrp: Number(form.standard_mrp || 0),
      min_stock_alert: Number(form.min_stock_alert || 0),
      is_active: form.is_active,
    }
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const toggleVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !paginatedItems.some((item) => item.id === id)))
      return
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...paginatedItems.map((item) => item.id)])))
  }

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir("asc")
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setUomFilter("all")
    setHsnFilter("all")
    setMinMrp("")
    setMaxMrp("")
    setCurrentPage(1)
  }

  const handleImport = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    for (const row of rows) {
      const payload = {
        item_code: String(row["Item Code"] || "").trim(),
        item_name: String(row["Item Name"] || "").trim(),
        category_id: row["Category ID"] ? Number(row["Category ID"]) : undefined,
        hsn_code: String(row["HSN Code"] || "").trim(),
        uom: String(row.UOM || "PCS").trim().toUpperCase(),
        standard_mrp: Number(row["Standard MRP"] || 0),
        min_stock_alert: Number(row["Min Stock Alert"] || 0),
      }
      if (payload.item_code && payload.item_name && payload.uom) {
        await saveMutation.mutateAsync(payload)
      }
    }
    if (importInputRef.current) importInputRef.current.value = ""
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Item Master</h1>
          <p className="mt-1 text-gray-500">Manage product catalog, tax readiness, and stock alert controls</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleImport(file)
            }}
          />
          <Button variant="outline" onClick={() => exportItemTemplateToExcel()}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Template
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={() => exportItemsToExcel(filtered)}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Add Item
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Metric icon={<Package className="h-4 w-4" />} label="Total Items" value={items.length} />
        <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={metrics.active} tone="green" />
        <Metric icon={<ShieldAlert className="h-4 w-4" />} label="Missing HSN" value={metrics.missingHsn} tone="amber" />
        <Metric icon={<Tags className="h-4 w-4" />} label="Alert Configured" value={metrics.lowAlertConfigured} />
        <Metric icon={<AlertTriangle className="h-4 w-4" />} label="Zero MRP" value={metrics.zeroMrp} tone="rose" />
        <Metric icon={<Boxes className="h-4 w-4" />} label="Inactive" value={metrics.inactive} />
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            {[
              ["all", "All"],
              ["active", "Active"],
              ["inactive", "Inactive"],
              ["missing-hsn", "Missing HSN"],
              ["zero-mrp", "Zero MRP"],
              ["no-min-alert", "No Min Alert"],
              ["incomplete", "Incomplete"],
            ].map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={statusFilter === value ? "default" : "outline"}
                onClick={() => {
                  setStatusFilter(value as StatusFilter)
                  setCurrentPage(1)
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-2 xl:col-span-2">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <TypeaheadInput
                  className="pl-9"
                  value={search}
                  onValueChange={(value) => {
                    setSearch(value)
                    setCurrentPage(1)
                  }}
                  suggestions={searchSuggestions}
                  placeholder="Code, name, HSN, UOM"
                />
              </div>
            </div>
            <FilterSelect label="UOM" value={uomFilter} onChange={setUomFilter} options={uomOptions.map((uom) => ({ value: uom, label: uom }))} />
            <FilterSelect label="HSN" value={hsnFilter} onChange={setHsnFilter} options={[{ value: "present", label: "Present" }, { value: "missing", label: "Missing" }]} />
            <div className="space-y-2">
              <Label>Min MRP</Label>
              <Input type="number" value={minMrp} onChange={(e) => setMinMrp(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Max MRP</Label>
              <Input type="number" value={maxMrp} onChange={(e) => setMaxMrp(e.target.value)} />
            </div>
          </div>
          <Button variant="outline" onClick={clearFilters}>
            <X className="mr-2 h-4 w-4" />
            Clear Filters
          </Button>
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-blue-900">{selectedIds.length} item(s) selected</p>
          <Button size="sm" variant="outline" onClick={() => exportItemsToExcel(selectedItems)}>Export selected</Button>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>Clear selection</Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b p-4">
            <div>
              <p className="font-semibold">Catalog Directory</p>
              <p className="text-sm text-slate-500">
                Showing {filtered.length === 0 ? 0 : (effectivePage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(effectivePage * ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={toggleVisible}>
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </Button>
          </div>
          <div className="max-h-[620px] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-white">
                <TableRow className="bg-gray-50">
                  <TableHead className="w-[44px]"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /></TableHead>
                  <SortableHead label="Code" active={sortKey === "item_code"} dir={sortDir} onClick={() => sortBy("item_code")} />
                  <SortableHead label="Item Name" active={sortKey === "item_name"} dir={sortDir} onClick={() => sortBy("item_name")} />
                  <TableHead>Catalog Health</TableHead>
                  <SortableHead label="HSN" active={sortKey === "hsn_code"} dir={sortDir} onClick={() => sortBy("hsn_code")} />
                  <SortableHead label="UOM" active={sortKey === "uom"} dir={sortDir} onClick={() => sortBy("uom")} />
                  <SortableHead label="MRP" active={sortKey === "standard_mrp"} dir={sortDir} onClick={() => sortBy("standard_mrp")} />
                  <SortableHead label="Min Alert" active={sortKey === "min_stock_alert"} dir={sortDir} onClick={() => sortBy("min_stock_alert")} />
                  <TableHead>Stock Usage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedItems.map((item) => {
                  const completeness = getCompleteness(item)
                  return (
                    <TableRow key={item.id} className="hover:bg-blue-50/40">
                      <TableCell><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelect(item.id)} /></TableCell>
                      <TableCell className="font-mono font-medium">{item.item_code}</TableCell>
                      <TableCell className="min-w-64">
                        <button className="flex items-center gap-2 text-left" onClick={() => setDetailsItem(item)}>
                          <Package className="h-4 w-4 text-slate-400" />
                          <span className="font-medium">{item.item_name}</span>
                        </button>
                      </TableCell>
                      <TableCell className="min-w-52">
                        <div className="flex flex-wrap gap-1">
                          <CompletenessBadge item={item} />
                          {completeness.warnings.slice(0, 2).map((warning) => (
                            <Badge key={warning} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{warning}</Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        {item.hsn_code ? <span className="font-mono text-sm">{item.hsn_code}</span> : <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">Missing</Badge>}
                      </TableCell>
                      <TableCell>{item.uom}</TableCell>
                      <TableCell>{money(item.standard_mrp)}</TableCell>
                      <TableCell className="text-right">{numberValue(item.min_stock_alert)}</TableCell>
                      <TableCell className="min-w-44 text-xs text-slate-500">
                        Current stock: N/A<br />Last received: N/A
                      </TableCell>
                      <TableCell>
                        <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                          {item.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon-sm" onClick={() => setActionItem(item)} aria-label={`Actions for ${item.item_name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-12 text-center text-sm text-slate-500">
                      No items match the selected filters. Clear filters or add/import items.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {filtered.length > 0 && (
            <div className="flex items-center justify-between border-t p-4">
              <p className="text-sm text-gray-600">Page {effectivePage} of {totalPages}</p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={effectivePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</Button>
                <Button variant="outline" size="sm" disabled={effectivePage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!actionItem} onOpenChange={(open) => !open && setActionItem(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Item Actions</DialogTitle>
            <DialogDescription>{actionItem?.item_name}</DialogDescription>
          </DialogHeader>
          {actionItem && (
            <div className="grid gap-2">
              <Button variant="outline" onClick={() => { setDetailsItem(actionItem); setActionItem(null) }}><Eye className="mr-2 h-4 w-4" />View Details</Button>
              <Button variant="outline" onClick={() => { openEdit(actionItem); setActionItem(null) }}>Edit</Button>
              <Button variant="outline" onClick={() => setActionItem(null)}>View Stock</Button>
              <Button variant="outline" onClick={() => setActionItem(null)}>View Rate Cards</Button>
              <Button variant="outline" className="text-rose-600" onClick={() => { setDeactivateItem(actionItem); setActionItem(null) }}>Deactivate</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deactivateItem} onOpenChange={(open) => !open && setDeactivateItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate item?</DialogTitle>
            <DialogDescription>This keeps history intact and removes the item from active master-data use.</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Check current stock, open GRNs/DOs, and active rate cards before deactivating {deactivateItem?.item_name}.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateItem(null)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => {
              if (deactivateItem) deleteMutation.mutate(deactivateItem.id)
              setDeactivateItem(null)
            }}>Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailsItem} onOpenChange={(open) => !open && setDetailsItem(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-3rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{detailsItem?.item_name}</DialogTitle>
            <DialogDescription>{detailsItem?.item_code}</DialogDescription>
          </DialogHeader>
          {detailsItem && <ItemDetails item={detailsItem} />}
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Item" : "Add New Item"}</DialogTitle>
            <DialogDescription>{editItem ? "Update item catalog details." : "Create a new catalog item."}</DialogDescription>
          </DialogHeader>
          {duplicateWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {Array.from(new Set(duplicateWarnings)).join(", ")}
            </div>
          )}
          <div className="grid gap-4 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Item Code *" value={form.item_code} onChange={(value) => setForm({ ...form, item_code: value.toUpperCase() })} />
              <Field label="UOM *" value={form.uom} onChange={(value) => setForm({ ...form, uom: value.toUpperCase() })} />
            </div>
            <Field label="Item Name *" value={form.item_name} onChange={(value) => setForm({ ...form, item_name: value })} />
            <div className="grid grid-cols-2 gap-4">
              <Field label="HSN Code" value={form.hsn_code} onChange={(value) => setForm({ ...form, hsn_code: value })} />
              <Field label="Category ID" value={form.category_id} onChange={(value) => setForm({ ...form, category_id: value })} type="number" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Standard MRP" value={String(form.standard_mrp)} onChange={(value) => setForm({ ...form, standard_mrp: Number(value) })} type="number" />
              <Field label="Min Stock Alert" value={String(form.min_stock_alert)} onChange={(value) => setForm({ ...form, min_stock_alert: Number(value) })} type="number" />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.is_active ? "active" : "inactive"} onValueChange={(value) => setForm({ ...form, is_active: value === "active" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700" disabled={duplicateWarnings.length > 0 || saveMutation.isPending}>
              Save Item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({ icon, label, value, tone = "blue" }: { icon: ReactNode; label: string; value: number; tone?: "blue" | "green" | "amber" | "rose" }) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    rose: "bg-rose-50 text-rose-600",
  }[tone]
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-600">{label}</p>
          <span className={`rounded-md p-2 ${toneClass}`}>{icon}</span>
        </div>
        <p className="mt-3 text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function SortableHead({ label, active, dir, onClick }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  return (
    <TableHead>
      <button type="button" className="font-semibold hover:text-blue-700" onClick={onClick}>
        {label}{active ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </TableHead>
  )
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function ItemDetails({ item }: { item: ItemRow }) {
  const completeness = getCompleteness(item)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{item.is_active ? "Active" : "Inactive"}</Badge>
        <CompletenessBadge item={item} />
        {completeness.warnings.map((warning) => (
          <Badge key={warning} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{warning}</Badge>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Detail title="Catalog Profile" rows={[
          ["Item Code", item.item_code],
          ["Item Name", item.item_name],
          ["Category", item.category_id ? String(item.category_id) : "No category"],
          ["HSN Code", item.hsn_code || "Missing"],
          ["UOM", item.uom],
          ["Status", item.is_active ? "Active" : "Inactive"],
        ]} />
        <Detail title="Commercial & Alerts" rows={[
          ["Standard MRP", money(item.standard_mrp)],
          ["Min Stock Alert", String(numberValue(item.min_stock_alert))],
          ["MRP Health", numberValue(item.standard_mrp) > 0 ? "Configured" : "Zero MRP"],
          ["Alert Health", numberValue(item.min_stock_alert) > 0 ? "Configured" : "No alert"],
        ]} />
        <Detail title="Stock Usage" rows={[
          ["Current Stock", "Not available"],
          ["Reserved", "Not available"],
          ["Dispatched", "Not available"],
          ["Last Received", "Not available"],
          ["Last Dispatched", "Not available"],
        ]} />
        <Detail title="Recent Activity" rows={[
          ["Created By", "Available in audit log"],
          ["Last Updated", "Available in audit log"],
          ["Rate Card Usage", "Not available"],
          ["Movement Usage", "Available in stock movement logs"],
        ]} />
      </div>
      {completeness.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Catalog quality warnings: {completeness.warnings.join(", ")}
        </div>
      )}
    </div>
  )
}

function Detail({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="mb-3 text-sm font-semibold uppercase text-slate-500">{title}</p>
      <div className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
            <span className="text-slate-500">{label}</span>
            <span className="min-w-0 break-words font-medium">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
