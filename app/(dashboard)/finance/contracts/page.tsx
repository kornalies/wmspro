"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Download,
  Edit,
  Eye,
  FileSpreadsheet,
  Paperclip,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import * as XLSX from "xlsx"
import { toast } from "sonner"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { exportContractTemplateToExcel, exportContractsToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

type ClientRow = {
  id: number
  client_code: string
  client_name: string
  is_active?: boolean
}

type ContractRow = {
  id: number
  client_id: number
  client_code?: string
  client_name: string
  contract_code: string
  effective_from: string
  effective_to?: string
  storage_rate_per_unit: number | string
  handling_rate_per_unit: number | string
  minimum_guarantee_amount: number | string
  billing_cycle: "MONTHLY" | "QUARTERLY" | "YEARLY"
  currency: string
  notes?: string
  is_active: boolean
}

type AttachmentRow = {
  id: number
  attachment_type: string
  reference_type: string
  reference_no: string
  file_name: string
  content_type?: string
  file_size_bytes?: number
  remarks?: string
  created_at: string
}

type StatusFilter =
  | "all"
  | "active"
  | "inactive"
  | "expired"
  | "future"
  | "expiring"
  | "missing-rates"
  | "missing-mg"
  | "overlap"

type SortKey =
  | "contract_code"
  | "client_name"
  | "storage_rate_per_unit"
  | "handling_rate_per_unit"
  | "minimum_guarantee_amount"
  | "effective_from"
  | "effective_to"
  | "billing_cycle"

const PAGE_SIZE = 10
const today = new Date()
today.setHours(0, 0, 0, 0)

const money = (value: number | string | undefined, currency = "INR") => {
  const amount = Number(value || 0)
  return `${currency || "INR"} ${Number.isFinite(amount) ? amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}`
}

const dateOnly = (value?: string) => (value ? String(value).slice(0, 10) : "")

const daysUntil = (value?: string) => {
  if (!value) return null
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return Math.ceil((date.getTime() - today.getTime()) / 86400000)
}

const isCurrentlyActive = (contract: ContractRow) => {
  if (!contract.is_active) return false
  const start = new Date(contract.effective_from)
  start.setHours(0, 0, 0, 0)
  const end = contract.effective_to ? new Date(contract.effective_to) : null
  if (end) end.setHours(0, 0, 0, 0)
  return start <= today && (!end || end >= today)
}

const getHealth = (contract: ContractRow, overlappingIds: Set<number>) => {
  if (!contract.is_active) return { label: "Inactive", tone: "slate" as const }
  const start = new Date(contract.effective_from)
  start.setHours(0, 0, 0, 0)
  const expiryDays = daysUntil(contract.effective_to)
  if (start > today) return { label: "Future", tone: "blue" as const }
  if (expiryDays !== null && expiryDays < 0) return { label: "Expired", tone: "rose" as const }
  if (overlappingIds.has(contract.id)) return { label: "Overlap Risk", tone: "rose" as const }
  if (Number(contract.storage_rate_per_unit || 0) <= 0 && Number(contract.handling_rate_per_unit || 0) <= 0) {
    return { label: "Missing Rates", tone: "amber" as const }
  }
  if (expiryDays !== null && expiryDays <= 30) return { label: "Expiring Soon", tone: "amber" as const }
  if (Number(contract.minimum_guarantee_amount || 0) <= 0) return { label: "No Min Guarantee", tone: "blue" as const }
  return { label: "Ready", tone: "green" as const }
}

const badgeClass = (tone: "green" | "amber" | "rose" | "blue" | "slate") => {
  const classes = {
    green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    rose: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  }
  return classes[tone]
}

const rangesOverlap = (a: ContractRow, b: ContractRow) => {
  if (a.client_id !== b.client_id || !a.is_active || !b.is_active) return false
  const aStart = new Date(a.effective_from).getTime()
  const bStart = new Date(b.effective_from).getTime()
  const aEnd = a.effective_to ? new Date(a.effective_to).getTime() : Number.POSITIVE_INFINITY
  const bEnd = b.effective_to ? new Date(b.effective_to).getTime() : Number.POSITIVE_INFINITY
  return aStart <= bEnd && bStart <= aEnd
}

function Metric({
  icon,
  label,
  value,
  tone = "blue",
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  tone?: "blue" | "green" | "amber" | "rose" | "slate"
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 pt-5">
        <div>
          <p className="text-sm text-slate-600 dark:text-slate-300">{label}</p>
          <p className="mt-2 text-2xl font-semibold">{value}</p>
        </div>
        <div className={`rounded-lg p-2 ${badgeClass(tone)}`}>{icon}</div>
      </CardContent>
    </Card>
  )
}

function SortableHead({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string
  active: boolean
  dir: "asc" | "desc"
  onClick: () => void
  align?: "left" | "right"
}) {
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`} onClick={onClick}>
        {label}
        <span className="text-[10px] text-slate-400">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    </TableHead>
  )
}

export default function ContractsPage() {
  const contractsQuery = useAdminResource("contracts")
  const clientsQuery = useAdminResource("clients")
  const saveMutation = useSaveAdminResource("contracts")
  const deleteMutation = useDeleteAdminResource("contracts")
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [clientFilter, setClientFilter] = useState("all")
  const [cycleFilter, setCycleFilter] = useState("all")
  const [effectiveFromFilter, setEffectiveFromFilter] = useState("")
  const [effectiveToFilter, setEffectiveToFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("effective_from")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [currentPage, setCurrentPage] = useState(1)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [detailsRow, setDetailsRow] = useState<ContractRow | null>(null)
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const [attachmentType, setAttachmentType] = useState("CONTRACT_AGREEMENT")
  const [attachmentRemarks, setAttachmentRemarks] = useState("")
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
  const [attachmentInputKey, setAttachmentInputKey] = useState(0)
  const [editRow, setEditRow] = useState<ContractRow | null>(null)
  const [form, setForm] = useState({
    client_id: "",
    contract_code: "",
    effective_from: "",
    effective_to: "",
    storage_rate_per_unit: "0",
    handling_rate_per_unit: "0",
    minimum_guarantee_amount: "0",
    billing_cycle: "MONTHLY",
    currency: "INR",
    notes: "",
    is_active: true,
  })

  const contracts = useMemo(() => (contractsQuery.data as ContractRow[] | undefined) ?? [], [contractsQuery.data])
  const clients = useMemo(() => (clientsQuery.data as ClientRow[] | undefined) ?? [], [clientsQuery.data])
  const activeClients = clients.filter((client) => client.is_active !== false)

  const overlappingIds = useMemo(() => {
    const ids = new Set<number>()
    contracts.forEach((contract, index) => {
      contracts.slice(index + 1).forEach((next) => {
        if (rangesOverlap(contract, next)) {
          ids.add(contract.id)
          ids.add(next.id)
        }
      })
    })
    return ids
  }, [contracts])

  const enrichedContracts = useMemo(
    () =>
      contracts.map((contract) => {
        const health = getHealth(contract, overlappingIds)
        return { ...contract, health_label: health.label, health_tone: health.tone }
      }),
    [contracts, overlappingIds]
  )

  const metrics = useMemo(() => {
    const active = contracts.filter(isCurrentlyActive)
    const activeContractClients = new Set(active.map((contract) => Number(contract.client_id)))
    return {
      total: contracts.length,
      active: active.length,
      inactive: contracts.filter((contract) => !contract.is_active).length,
      expiring: contracts.filter((contract) => {
        const days = daysUntil(contract.effective_to)
        return contract.is_active && days !== null && days >= 0 && days <= 30
      }).length,
      missingMg: contracts.filter((contract) => Number(contract.minimum_guarantee_amount || 0) <= 0).length,
      clientsWithoutActiveContract: activeClients.filter((client) => !activeContractClients.has(Number(client.id))).length,
    }
  }, [activeClients, contracts])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = enrichedContracts.filter((row) => {
      const health = getHealth(row, overlappingIds)
      const expiryDays = daysUntil(row.effective_to)
      const startedAfter = effectiveFromFilter ? new Date(row.effective_from) >= new Date(effectiveFromFilter) : true
      const endsBefore = effectiveToFilter && row.effective_to ? new Date(row.effective_to) <= new Date(effectiveToFilter) : true
      const matchesTerm = !term || `${row.contract_code} ${row.client_name} ${row.client_code || ""}`.toLowerCase().includes(term)
      const matchesClient = clientFilter === "all" || String(row.client_id) === clientFilter
      const matchesCycle = cycleFilter === "all" || row.billing_cycle === cycleFilter
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && isCurrentlyActive(row)) ||
        (statusFilter === "inactive" && !row.is_active) ||
        (statusFilter === "expired" && expiryDays !== null && expiryDays < 0) ||
        (statusFilter === "future" && new Date(row.effective_from) > today) ||
        (statusFilter === "expiring" && expiryDays !== null && expiryDays >= 0 && expiryDays <= 30) ||
        (statusFilter === "missing-rates" && Number(row.storage_rate_per_unit || 0) <= 0 && Number(row.handling_rate_per_unit || 0) <= 0) ||
        (statusFilter === "missing-mg" && Number(row.minimum_guarantee_amount || 0) <= 0) ||
        (statusFilter === "overlap" && health.label === "Overlap Risk")
      return matchesTerm && matchesClient && matchesCycle && matchesStatus && startedAfter && endsBefore
    })

    return [...rows].sort((a, b) => {
      const leftRaw = a[sortKey]
      const rightRaw = b[sortKey]
      const left = typeof leftRaw === "number" ? leftRaw : String(leftRaw || "").toLowerCase()
      const right = typeof rightRaw === "number" ? rightRaw : String(rightRaw || "").toLowerCase()
      const result = left > right ? 1 : left < right ? -1 : 0
      return sortDir === "asc" ? result : -result
    })
  }, [clientFilter, cycleFilter, effectiveFromFilter, effectiveToFilter, enrichedContracts, overlappingIds, search, sortDir, sortKey, statusFilter])

  const searchSuggestions = useMemo(
    () => contracts.flatMap((row) => [row.contract_code, row.client_name, row.client_code || ""]).filter(Boolean),
    [contracts]
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const effectivePage = Math.min(currentPage, totalPages)
  const visibleRows = filtered.slice((effectivePage - 1) * PAGE_SIZE, effectivePage * PAGE_SIZE)
  const contractRefNo = editRow?.contract_code || ""

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setClientFilter("all")
    setCycleFilter("all")
    setEffectiveFromFilter("")
    setEffectiveToFilter("")
    setCurrentPage(1)
  }

  const formatFileSize = (size?: number) => {
    if (!size || size <= 0) return "-"
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${size} B`
  }

  const loadAttachments = async (referenceNo: string) => {
    if (!referenceNo) {
      setAttachments([])
      return
    }
    setAttachmentsLoading(true)
    try {
      const res = await fetch(`/api/attachments?referenceType=CONTRACT&referenceNo=${encodeURIComponent(referenceNo)}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      })
      const body = (await res.json()) as { success?: boolean; data?: AttachmentRow[]; error?: { message?: string } }
      if (!res.ok || body.success === false) throw new Error(body.error?.message || "Failed to load attachments")
      setAttachments(body.data || [])
    } catch (error: unknown) {
      setAttachments([])
      toast.error(error instanceof Error ? error.message : "Failed to load attachments")
    } finally {
      setAttachmentsLoading(false)
    }
  }

  const handleUploadAttachment = async () => {
    if (!editRow) {
      toast.error("Save contract first before adding documents")
      return
    }
    if (!attachmentFile) {
      toast.error("Select a file to upload")
      return
    }

    setAttachmentUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", attachmentFile)
      formData.append("attachmentType", attachmentType)
      formData.append("referenceType", "CONTRACT")
      formData.append("referenceNo", editRow.contract_code)
      formData.append("remarks", attachmentRemarks)

      const res = await fetch("/api/attachments", {
        method: "POST",
        body: formData,
        credentials: "include",
        headers: { "x-idempotency-key": crypto.randomUUID() },
      })
      const body = (await res.json()) as { success?: boolean; error?: { message?: string } }
      if (!res.ok || body.success === false) throw new Error(body.error?.message || "Upload failed")

      setAttachmentFile(null)
      setAttachmentRemarks("")
      setAttachmentInputKey((v) => v + 1)
      toast.success("Document uploaded")
      await loadAttachments(editRow.contract_code)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Upload failed")
    } finally {
      setAttachmentUploading(false)
    }
  }

  useEffect(() => {
    if (!isDialogOpen || !contractRefNo) {
      setAttachments([])
      return
    }
    void loadAttachments(contractRefNo)
  }, [isDialogOpen, contractRefNo])

  const resetDocumentState = () => {
    setAttachments([])
    setAttachmentFile(null)
    setAttachmentRemarks("")
    setAttachmentType("CONTRACT_AGREEMENT")
    setAttachmentInputKey((v) => v + 1)
  }

  const openCreate = () => {
    setEditRow(null)
    resetDocumentState()
    setForm({
      client_id: activeClients[0]?.id ? String(activeClients[0].id) : "",
      contract_code: "",
      effective_from: "",
      effective_to: "",
      storage_rate_per_unit: "0",
      handling_rate_per_unit: "0",
      minimum_guarantee_amount: "0",
      billing_cycle: "MONTHLY",
      currency: "INR",
      notes: "",
      is_active: true,
    })
    setIsDialogOpen(true)
  }

  const openDuplicate = (row: ContractRow) => {
    setEditRow(null)
    resetDocumentState()
    setForm({
      client_id: String(row.client_id),
      contract_code: `${row.contract_code}-COPY`,
      effective_from: dateOnly(row.effective_from),
      effective_to: dateOnly(row.effective_to),
      storage_rate_per_unit: String(row.storage_rate_per_unit ?? "0"),
      handling_rate_per_unit: String(row.handling_rate_per_unit ?? "0"),
      minimum_guarantee_amount: String(row.minimum_guarantee_amount ?? "0"),
      billing_cycle: row.billing_cycle || "MONTHLY",
      currency: row.currency || "INR",
      notes: row.notes || "",
      is_active: false,
    })
    setIsDialogOpen(true)
  }

  const openEdit = (row: ContractRow) => {
    setEditRow(row)
    resetDocumentState()
    setForm({
      client_id: String(row.client_id),
      contract_code: row.contract_code,
      effective_from: dateOnly(row.effective_from),
      effective_to: dateOnly(row.effective_to),
      storage_rate_per_unit: String(row.storage_rate_per_unit ?? "0"),
      handling_rate_per_unit: String(row.handling_rate_per_unit ?? "0"),
      minimum_guarantee_amount: String(row.minimum_guarantee_amount ?? "0"),
      billing_cycle: row.billing_cycle || "MONTHLY",
      currency: row.currency || "INR",
      notes: row.notes || "",
      is_active: row.is_active,
    })
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.client_id || !form.contract_code || !form.effective_from) {
      toast.error("Client, contract code, and effective date are required")
      return
    }
    if (form.effective_to && new Date(form.effective_to) < new Date(form.effective_from)) {
      toast.error("Effective To cannot be before Effective From")
      return
    }
    const duplicateCode = contracts.some(
      (row) => row.id !== editRow?.id && row.contract_code.toUpperCase() === form.contract_code.trim().toUpperCase()
    )
    if (duplicateCode) {
      toast.error("Contract code already exists")
      return
    }

    const draft: ContractRow = {
      id: editRow?.id || -1,
      client_id: Number(form.client_id),
      client_name: clients.find((client) => String(client.id) === form.client_id)?.client_name || "",
      contract_code: form.contract_code,
      effective_from: form.effective_from,
      effective_to: form.effective_to || undefined,
      storage_rate_per_unit: Number(form.storage_rate_per_unit || 0),
      handling_rate_per_unit: Number(form.handling_rate_per_unit || 0),
      minimum_guarantee_amount: Number(form.minimum_guarantee_amount || 0),
      billing_cycle: form.billing_cycle as ContractRow["billing_cycle"],
      currency: form.currency,
      is_active: form.is_active,
    }
    const hasOverlap = contracts.some((row) => row.id !== editRow?.id && rangesOverlap(row, draft))
    if (hasOverlap && !window.confirm("This active contract overlaps another active contract for the same client. Save anyway?")) return

    const payload = {
      client_id: Number(form.client_id),
      contract_code: form.contract_code.trim(),
      effective_from: form.effective_from,
      effective_to: form.effective_to || "",
      storage_rate_per_unit: Number(form.storage_rate_per_unit || 0),
      handling_rate_per_unit: Number(form.handling_rate_per_unit || 0),
      minimum_guarantee_amount: Number(form.minimum_guarantee_amount || 0),
      billing_cycle: form.billing_cycle,
      currency: form.currency,
      notes: form.notes,
      is_active: form.is_active,
    }

    if (editRow) await saveMutation.mutateAsync({ id: editRow.id, ...payload })
    else await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const handleImport = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    for (const row of rows) {
      const payload = {
        client_id: Number(row["Client ID"] || 0),
        contract_code: String(row["Contract Code"] || "").trim(),
        effective_from: String(row["Effective From"] || "").slice(0, 10),
        effective_to: String(row["Effective To"] || "").slice(0, 10),
        storage_rate_per_unit: Number(row["Storage Rate"] || 0),
        handling_rate_per_unit: Number(row["Handling Rate"] || 0),
        minimum_guarantee_amount: Number(row["Minimum Guarantee"] || 0),
        billing_cycle: String(row["Billing Cycle"] || "MONTHLY").toUpperCase(),
        currency: String(row.Currency || "INR").toUpperCase(),
        notes: String(row.Notes || ""),
        is_active: String(row.Status || "Active").toLowerCase() !== "inactive",
      }
      if (payload.client_id && payload.contract_code && payload.effective_from) await saveMutation.mutateAsync(payload)
    }
    if (importInputRef.current) importInputRef.current.value = ""
  }

  const statusButtons: Array<[StatusFilter, string]> = [
    ["all", "All"],
    ["active", "Active"],
    ["inactive", "Inactive"],
    ["expiring", "Expiring"],
    ["expired", "Expired"],
    ["future", "Future"],
    ["missing-rates", "Missing Rates"],
    ["missing-mg", "No MG"],
    ["overlap", "Overlap Risk"],
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Contract Management</h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">Control contract readiness, rate coverage, validity, and billing risk</p>
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
          <Button variant="outline" onClick={exportContractTemplateToExcel}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Template
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" onClick={() => exportContractsToExcel(filtered)}>
            <Download className="mr-2 h-4 w-4" /> Export
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Add Contract
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editRow ? "Edit Contract" : "Create Contract"}</DialogTitle>
                <DialogDescription>Configure contract validity, charge rates, minimum guarantee, and supporting documents.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 pt-2 md:grid-cols-2 xl:grid-cols-4">
                <div className="min-w-0 space-y-2 xl:col-span-2">
                  <Label>Client *</Label>
                  <Select value={form.client_id} onValueChange={(v) => setForm({ ...form, client_id: v })}>
                    <SelectTrigger className="w-full min-w-0"><SelectValue placeholder="Select client" /></SelectTrigger>
                    <SelectContent>
                      {activeClients.map((client) => (
                        <SelectItem key={client.id} value={String(client.id)}>
                          {client.client_code} - {client.client_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 space-y-2">
                  <Label>Contract Code *</Label>
                  <Input value={form.contract_code} onChange={(e) => setForm({ ...form, contract_code: e.target.value.toUpperCase() })} />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={form.is_active ? "active" : "inactive"} onValueChange={(v) => setForm({ ...form, is_active: v === "active" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Effective From *</Label>
                  <Input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Effective To</Label>
                  <Input type="date" value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Billing Cycle</Label>
                  <Select value={form.billing_cycle} onValueChange={(v) => setForm({ ...form, billing_cycle: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTHLY">MONTHLY</SelectItem>
                      <SelectItem value="QUARTERLY">QUARTERLY</SelectItem>
                      <SelectItem value="YEARLY">YEARLY</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
                </div>
                <div className="space-y-2">
                  <Label>Storage Rate</Label>
                  <Input type="number" min="0" step="0.01" value={form.storage_rate_per_unit} onChange={(e) => setForm({ ...form, storage_rate_per_unit: e.target.value })} />
                  <p className="text-xs text-slate-500">Per stock unit per billing cycle</p>
                </div>
                <div className="space-y-2">
                  <Label>Handling Rate</Label>
                  <Input type="number" min="0" step="0.01" value={form.handling_rate_per_unit} onChange={(e) => setForm({ ...form, handling_rate_per_unit: e.target.value })} />
                  <p className="text-xs text-slate-500">Per inbound/outbound handling unit</p>
                </div>
                <div className="space-y-2">
                  <Label>Minimum Guarantee</Label>
                  <Input type="number" min="0" step="0.01" value={form.minimum_guarantee_amount} onChange={(e) => setForm({ ...form, minimum_guarantee_amount: e.target.value })} />
                </div>
                <div className="space-y-2 xl:col-span-4">
                  <Label>Notes</Label>
                  <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
                <div className="space-y-3 rounded-md border p-3 xl:col-span-4">
                  <div className="flex items-center gap-2 text-sm font-medium"><Paperclip className="h-4 w-4" /> Contract Documents</div>
                  {!editRow ? (
                    <p className="text-sm text-slate-500">Save the contract first, then upload agreement and GST documents.</p>
                  ) : (
                    <>
                      <div className="grid gap-2 md:grid-cols-4">
                        <div className="space-y-1">
                          <Label>Document Type</Label>
                          <Select value={attachmentType} onValueChange={setAttachmentType}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="CONTRACT_AGREEMENT">Contract Agreement</SelectItem>
                              <SelectItem value="GST_DOCUMENT">GST Document</SelectItem>
                              <SelectItem value="OTHER_DOCUMENT">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1 md:col-span-2">
                          <Label>File</Label>
                          <Input key={attachmentInputKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)} />
                        </div>
                        <div className="flex items-end">
                          <Button type="button" className="w-full" variant="secondary" onClick={handleUploadAttachment} disabled={attachmentUploading || !attachmentFile}>
                            <Upload className="mr-2 h-4 w-4" /> {attachmentUploading ? "Uploading..." : "Upload"}
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label>Remarks</Label>
                        <Input value={attachmentRemarks} onChange={(e) => setAttachmentRemarks(e.target.value)} placeholder="Optional notes for this document" />
                      </div>
                      <div className="max-h-40 overflow-auto rounded border">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50 text-left dark:bg-slate-900">
                            <tr>
                              <th className="px-2 py-1">Type</th>
                              <th className="px-2 py-1">File</th>
                              <th className="px-2 py-1">Size</th>
                              <th className="px-2 py-1">Uploaded</th>
                              <th className="px-2 py-1 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {attachmentsLoading ? (
                              <tr><td className="px-2 py-2 text-slate-500" colSpan={5}>Loading documents...</td></tr>
                            ) : attachments.length === 0 ? (
                              <tr><td className="px-2 py-2 text-slate-500" colSpan={5}>No documents attached yet.</td></tr>
                            ) : (
                              attachments.map((file) => (
                                <tr key={file.id} className="border-t">
                                  <td className="px-2 py-1">{file.attachment_type}</td>
                                  <td className="px-2 py-1">{file.file_name}</td>
                                  <td className="px-2 py-1">{formatFileSize(file.file_size_bytes)}</td>
                                  <td className="px-2 py-1">{new Date(file.created_at).toLocaleDateString()}</td>
                                  <td className="px-2 py-1 text-right">
                                    <Button asChild size="sm" variant="outline">
                                      <a href={`/api/attachments/${file.id}`}><Download className="mr-2 h-4 w-4" /> Download</a>
                                    </Button>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={handleSave} disabled={saveMutation.isPending}>
                  Save Contract
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Metric icon={<FileSpreadsheet className="h-4 w-4" />} label="Total Contracts" value={metrics.total} />
        <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={metrics.active} tone="green" />
        <Metric icon={<ShieldAlert className="h-4 w-4" />} label="Inactive" value={metrics.inactive} tone="slate" />
        <Metric icon={<CalendarClock className="h-4 w-4" />} label="Expiring Soon" value={metrics.expiring} tone={metrics.expiring ? "amber" : "green"} />
        <Metric icon={<AlertTriangle className="h-4 w-4" />} label="No Min Guarantee" value={metrics.missingMg} tone={metrics.missingMg ? "amber" : "green"} />
        <Metric icon={<ShieldAlert className="h-4 w-4" />} label="Clients Without Contract" value={metrics.clientsWithoutActiveContract} tone={metrics.clientsWithoutActiveContract ? "rose" : "green"} />
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            {statusButtons.map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={statusFilter === value ? "default" : "outline"}
                onClick={() => {
                  setStatusFilter(value)
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
                <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <TypeaheadInput
                  className="pl-9"
                  value={search}
                  onValueChange={(value) => {
                    setSearch(value)
                    setCurrentPage(1)
                  }}
                  suggestions={searchSuggestions}
                  placeholder="Contract, client, client code"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Client</Label>
              <Select value={clientFilter} onValueChange={(value) => { setClientFilter(value); setCurrentPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {clients.map((client) => <SelectItem key={client.id} value={String(client.id)}>{client.client_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Cycle</Label>
              <Select value={cycleFilter} onValueChange={(value) => { setCycleFilter(value); setCurrentPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cycles</SelectItem>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                  <SelectItem value="YEARLY">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Starts After</Label>
              <Input type="date" value={effectiveFromFilter} onChange={(e) => setEffectiveFromFilter(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Ends Before</Label>
              <Input type="date" value={effectiveToFilter} onChange={(e) => setEffectiveToFilter(e.target.value)} />
            </div>
          </div>
          <Button variant="outline" onClick={clearFilters}>
            <X className="mr-2 h-4 w-4" /> Clear Filters
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Contract Register</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Showing {filtered.length === 0 ? 0 : (effectivePage - 1) * PAGE_SIZE + 1}-{Math.min(effectivePage * PAGE_SIZE, filtered.length)} of {filtered.length}</p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="bg-slate-50 dark:bg-slate-900">
                  <SortableHead label="Contract" active={sortKey === "contract_code"} dir={sortDir} onClick={() => sortBy("contract_code")} />
                  <SortableHead label="Client" active={sortKey === "client_name"} dir={sortDir} onClick={() => sortBy("client_name")} />
                  <SortableHead label="Storage" active={sortKey === "storage_rate_per_unit"} dir={sortDir} onClick={() => sortBy("storage_rate_per_unit")} align="right" />
                  <SortableHead label="Handling" active={sortKey === "handling_rate_per_unit"} dir={sortDir} onClick={() => sortBy("handling_rate_per_unit")} align="right" />
                  <SortableHead label="Min Guarantee" active={sortKey === "minimum_guarantee_amount"} dir={sortDir} onClick={() => sortBy("minimum_guarantee_amount")} align="right" />
                  <SortableHead label="Validity" active={sortKey === "effective_from"} dir={sortDir} onClick={() => sortBy("effective_from")} />
                  <SortableHead label="Cycle" active={sortKey === "billing_cycle"} dir={sortDir} onClick={() => sortBy("billing_cycle")} />
                  <TableHead>Health</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  const health = getHealth(row, overlappingIds)
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-mono font-medium">{row.contract_code}</div>
                        <div className="text-xs text-slate-500">{row.currency || "INR"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{row.client_name}</div>
                        <div className="text-xs text-slate-500">{row.client_code || `Client ${row.client_id}`}</div>
                      </TableCell>
                      <TableCell className="text-right">{money(row.storage_rate_per_unit, row.currency)}</TableCell>
                      <TableCell className="text-right">{money(row.handling_rate_per_unit, row.currency)}</TableCell>
                      <TableCell className="text-right">{money(row.minimum_guarantee_amount, row.currency)}</TableCell>
                      <TableCell>
                        <div>{dateOnly(row.effective_from) || "-"}</div>
                        <div className="text-xs text-slate-500">to {dateOnly(row.effective_to) || "Open ended"}</div>
                      </TableCell>
                      <TableCell>{row.billing_cycle}</TableCell>
                      <TableCell><Badge className={badgeClass(health.tone)}>{health.label}</Badge></TableCell>
                      <TableCell>
                        <Badge className={row.is_active ? badgeClass("green") : badgeClass("rose")}>{row.is_active ? "Active" : "Inactive"}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setDetailsRow(row)}><Eye className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => openDuplicate(row)}><Copy className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(row)}><Edit className="h-4 w-4" /></Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600"
                            onClick={() => {
                              if (window.confirm(`Deactivate contract ${row.contract_code}? Billing runs will stop using it.`)) deleteMutation.mutate(row.id)
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {visibleRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center text-sm text-slate-500">
                      No contracts match the selected filters.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t p-4">
            <Button variant="outline" disabled={effectivePage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</Button>
            <span className="text-sm text-slate-500">Page {effectivePage} of {totalPages}</span>
            <Button variant="outline" disabled={effectivePage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>Next</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(detailsRow)} onOpenChange={(open) => !open && setDetailsRow(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{detailsRow?.contract_code || "Contract Details"}</DialogTitle>
            <DialogDescription>Rate readiness, validity, billing configuration, and audit context.</DialogDescription>
          </DialogHeader>
          {detailsRow ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-base">Contract Profile</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {[
                    ["Client", detailsRow.client_name],
                    ["Client Code", detailsRow.client_code || "-"],
                    ["Validity", `${dateOnly(detailsRow.effective_from)} to ${dateOnly(detailsRow.effective_to) || "Open ended"}`],
                    ["Billing Cycle", detailsRow.billing_cycle],
                    ["Currency", detailsRow.currency || "INR"],
                    ["Status", detailsRow.is_active ? "Active" : "Inactive"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <span className="text-slate-500">{label}</span>
                      <span className="text-right font-medium">{value}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Rate Matrix</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {[
                    ["Storage Rate", `${money(detailsRow.storage_rate_per_unit, detailsRow.currency)} / stock unit`],
                    ["Handling Rate", `${money(detailsRow.handling_rate_per_unit, detailsRow.currency)} / handling unit`],
                    ["Minimum Guarantee", money(detailsRow.minimum_guarantee_amount, detailsRow.currency)],
                    ["Health", getHealth(detailsRow, overlappingIds).label],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <span className="text-slate-500">{label}</span>
                      <span className="text-right font-medium">{value}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Billing Safety Checks</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <CheckLine ok={Number(detailsRow.storage_rate_per_unit || 0) > 0 || Number(detailsRow.handling_rate_per_unit || 0) > 0} text="At least one charge rate is configured" />
                  <CheckLine ok={!overlappingIds.has(detailsRow.id)} text="No overlapping active contract for this client" />
                  <CheckLine ok={daysUntil(detailsRow.effective_to) === null || Number(daysUntil(detailsRow.effective_to)) >= 0} text="Contract is not expired" />
                  <CheckLine ok={Boolean(detailsRow.effective_from)} text="Effective start date is available" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Notes & Actions</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="min-h-12 rounded-md bg-slate-50 p-3 text-slate-600 dark:bg-slate-900 dark:text-slate-300">{detailsRow.notes || "No notes recorded."}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => openDuplicate(detailsRow)}>Duplicate</Button>
                    <Button size="sm" onClick={() => openEdit(detailsRow)}>Edit Contract</Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2">
      {ok ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
      <span>{text}</span>
    </div>
  )
}
