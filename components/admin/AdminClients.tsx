"use client"

import { useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  Filter,
  Mail,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  Users,
  X,
} from "lucide-react"
import * as XLSX from "xlsx"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { exportClientsToExcel, exportClientTemplateToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { TypeaheadInput } from "@/components/ui/typeahead-input"

type Client = {
  id: number
  client_code: string
  client_name: string
  contact_person?: string
  contact_email?: string
  contact_phone?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
  gst_number?: string
  pan_number?: string
  contract_code?: string
  effective_from?: string
  effective_to?: string
  storage_rate_per_unit?: number | string
  handling_rate_per_unit?: number | string
  minimum_guarantee_amount?: number | string
  billing_terms?: "MONTHLY" | "QUARTERLY" | "YEARLY" | string
  contract_currency?: string
  is_active: boolean
}

type StatusFilter = "all" | "active" | "inactive" | "missing-contract" | "missing-contact" | "incomplete" | "portal"

function blankForm() {
  return {
    client_code: "",
    client_name: "",
    contact_person: "",
    contact_email: "",
    contact_phone: "",
    address: "",
    city: "",
    state: "",
    pincode: "",
    gst_number: "",
    pan_number: "",
    is_active: true,
  }
}

function formatMoney(value?: number | string, currency?: string) {
  if (value === null || value === undefined || value === "") return "-"
  const amount = Number(value)
  if (!Number.isFinite(amount)) return "-"
  return `${currency || "INR"} ${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(value?: string) {
  if (!value) return "Open ended"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "N/A"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function getContractHealth(client: Client) {
  if (!client.contract_code) return { label: "Missing Contract", tone: "amber" }
  if (client.effective_to) {
    const endDate = new Date(client.effective_to)
    if (!Number.isNaN(endDate.getTime())) {
      const daysLeft = Math.ceil((endDate.getTime() - Date.now()) / 86400000)
      if (daysLeft < 0) return { label: "Expired", tone: "red" }
      if (daysLeft <= 30) return { label: "Expiring Soon", tone: "amber" }
    }
  }
  return { label: "Active Contract", tone: "green" }
}

function getCompleteness(client: Client) {
  const checks = [
    Boolean(client.client_code),
    Boolean(client.client_name),
    Boolean(client.contact_person),
    Boolean(client.contact_phone || client.contact_email),
    Boolean(client.city && client.state),
    Boolean(client.gst_number),
    Boolean(client.contract_code),
  ]
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100)
  const warnings = [
    !client.contact_person ? "No contact" : "",
    !(client.contact_phone || client.contact_email) ? "No phone/email" : "",
    !client.gst_number ? "Missing GST" : "",
    !client.contract_code ? "No active contract" : "",
    !(client.city && client.state) ? "Missing location" : "",
  ].filter(Boolean)
  return { score, warnings }
}

function HealthBadge({ client }: { client: Client }) {
  const health = getContractHealth(client)
  const className =
    health.tone === "green"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : health.tone === "red"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : "border-amber-200 bg-amber-50 text-amber-700"
  return <Badge variant="outline" className={className}>{health.label}</Badge>
}

function CompletenessBadge({ client }: { client: Client }) {
  const { score } = getCompleteness(client)
  const className =
    score >= 85
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : score >= 60
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-rose-200 bg-rose-50 text-rose-700"
  return <Badge variant="outline" className={className}>{score}% complete</Badge>
}

function PortalBadge() {
  return <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">Not Invited</Badge>
}

export function AdminClients() {
  const CLIENTS_PER_PAGE = 12
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const clientsQuery = useAdminResource("clients")
  const saveMutation = useSaveAdminResource("clients")
  const deleteMutation = useDeleteAdminResource("clients")

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [cityFilter, setCityFilter] = useState("")
  const [stateFilter, setStateFilter] = useState("")
  const [billingFilter, setBillingFilter] = useState("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [detailsClient, setDetailsClient] = useState<Client | null>(null)
  const [actionClient, setActionClient] = useState<Client | null>(null)
  const [deactivateClient, setDeactivateClient] = useState<Client | null>(null)
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [formData, setFormData] = useState(blankForm)

  const clients = (clientsQuery.data as Client[] | undefined) ?? []
  const cities = useMemo(() => Array.from(new Set(clients.map((c) => c.city).filter(Boolean))) as string[], [clients])
  const states = useMemo(() => Array.from(new Set(clients.map((c) => c.state).filter(Boolean))) as string[], [clients])
  const billingTerms = useMemo(() => Array.from(new Set(clients.map((c) => c.billing_terms).filter(Boolean))) as string[], [clients])
  const searchSuggestions = useMemo(
    () =>
      clients.flatMap((client) => [
        client.client_code,
        client.client_name,
        client.gst_number || "",
        client.contact_person || "",
        client.contact_phone || "",
        client.contact_email || "",
      ]),
    [clients]
  )

  const metrics = useMemo(() => {
    const active = clients.filter((c) => c.is_active).length
    const inactive = clients.length - active
    const missingContract = clients.filter((c) => !c.contract_code).length
    const incomplete = clients.filter((c) => getCompleteness(c).score < 85).length
    return { active, inactive, missingContract, incomplete, portalEnabled: 0 }
  }, [clients])

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients.filter((client) => {
      const completeness = getCompleteness(client)
      const matchesSearch =
        !q ||
        [
          client.client_name,
          client.client_code,
          client.gst_number,
          client.contact_person,
          client.contact_phone,
          client.contact_email,
        ].some((value) => String(value || "").toLowerCase().includes(q))
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && client.is_active) ||
        (statusFilter === "inactive" && !client.is_active) ||
        (statusFilter === "missing-contract" && !client.contract_code) ||
        (statusFilter === "missing-contact" && !(client.contact_person && (client.contact_phone || client.contact_email))) ||
        (statusFilter === "incomplete" && completeness.score < 85) ||
        (statusFilter === "portal" && false)
      const matchesCity = !cityFilter || client.city === cityFilter
      const matchesState = !stateFilter || client.state === stateFilter
      const matchesBilling = billingFilter === "all" || client.billing_terms === billingFilter
      return matchesSearch && matchesStatus && matchesCity && matchesState && matchesBilling
    })
  }, [billingFilter, cityFilter, clients, search, stateFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filteredClients.length / CLIENTS_PER_PAGE))
  const effectiveCurrentPage = Math.min(currentPage, totalPages)
  const paginatedClients = filteredClients.slice(
    (effectiveCurrentPage - 1) * CLIENTS_PER_PAGE,
    effectiveCurrentPage * CLIENTS_PER_PAGE
  )
  const selectedClients = clients.filter((client) => selectedIds.includes(client.id))
  const allVisibleSelected = paginatedClients.length > 0 && paginatedClients.every((client) => selectedIds.includes(client.id))

  const duplicateWarnings = useMemo(() => {
    const code = formData.client_code.trim().toLowerCase()
    const gst = formData.gst_number.trim().toLowerCase()
    const email = formData.contact_email.trim().toLowerCase()
    const phone = formData.contact_phone.trim().toLowerCase()
    return clients
      .filter((client) => client.id !== selectedClient?.id)
      .flatMap((client) => [
        code && client.client_code?.trim().toLowerCase() === code ? "Client code already exists" : "",
        gst && client.gst_number?.trim().toLowerCase() === gst ? "GST number already exists" : "",
        email && client.contact_email?.trim().toLowerCase() === email ? "Email already exists" : "",
        phone && client.contact_phone?.trim().toLowerCase() === phone ? "Phone already exists" : "",
      ])
      .filter(Boolean)
  }, [clients, formData, selectedClient])

  const handleOpenDialog = (client?: Client) => {
    if (client) {
      setSelectedClient(client)
      setFormData({
        client_code: client.client_code,
        client_name: client.client_name,
        contact_person: client.contact_person || "",
        contact_email: client.contact_email || "",
        contact_phone: client.contact_phone || "",
        address: client.address || "",
        city: client.city || "",
        state: client.state || "",
        pincode: client.pincode || "",
        gst_number: client.gst_number || "",
        pan_number: client.pan_number || "",
        is_active: client.is_active,
      })
    } else {
      setSelectedClient(null)
      setFormData(blankForm())
    }
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    if (duplicateWarnings.length > 0) return
    const payload = selectedClient ? { id: selectedClient.id, ...formData } : formData
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const toggleVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !paginatedClients.some((client) => client.id === id)))
      return
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...paginatedClients.map((client) => client.id)])))
  }

  const handleImport = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    for (const row of rows) {
      const payload = {
        client_code: String(row["Client Code"] || "").trim(),
        client_name: String(row["Client Name"] || "").trim(),
        contact_person: String(row["Contact Person"] || "").trim(),
        contact_email: String(row["Email"] || "").trim(),
        contact_phone: String(row["Phone"] || "").trim(),
        address: String(row["Address"] || "").trim(),
        city: String(row["City"] || "").trim(),
        state: String(row["State"] || "").trim(),
        pincode: String(row["Pincode"] || "").trim(),
        gst_number: String(row["GST Number"] || "").trim(),
        pan_number: String(row["PAN Number"] || "").trim(),
      }
      if (payload.client_code && payload.client_name) {
        await saveMutation.mutateAsync(payload)
      }
    }
    if (importInputRef.current) importInputRef.current.value = ""
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Client Management</h1>
          <p className="mt-1 text-gray-500">Manage client master data, contract readiness, and onboarding health</p>
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
          <Button variant="outline" onClick={() => exportClientTemplateToExcel()}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Template
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={() => exportClientsToExcel(filteredClients)}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => handleOpenDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Client
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Metric icon={<Building2 className="h-4 w-4" />} label="Total Clients" value={clients.length} />
        <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={metrics.active} tone="green" />
        <Metric icon={<AlertTriangle className="h-4 w-4" />} label="Missing Contract" value={metrics.missingContract} tone="amber" />
        <Metric icon={<ShieldCheck className="h-4 w-4" />} label="Incomplete Profiles" value={metrics.incomplete} tone="rose" />
        <Metric icon={<Users className="h-4 w-4" />} label="Portal Enabled" value={metrics.portalEnabled} />
      </div>

      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {[
            ["all", "All"],
            ["active", "Active"],
            ["inactive", "Inactive"],
            ["missing-contract", "Missing Contract"],
            ["missing-contact", "Missing Contact"],
            ["incomplete", "Incomplete"],
            ["portal", "Portal Enabled"],
          ].map(([value, label]) => (
            <Button
              key={value}
              variant={statusFilter === value ? "default" : "outline"}
              size="sm"
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
            <TypeaheadInput
              value={search}
              onValueChange={(value) => {
                setSearch(value)
                setCurrentPage(1)
              }}
              suggestions={searchSuggestions}
              placeholder="Code, name, GST, contact, phone, email"
            />
          </div>
          <div className="space-y-2">
            <Label>City</Label>
            <TypeaheadInput value={cityFilter} onValueChange={(value) => { setCityFilter(value); setCurrentPage(1) }} suggestions={cities} placeholder="All cities" />
          </div>
          <div className="space-y-2">
            <Label>State</Label>
            <TypeaheadInput value={stateFilter} onValueChange={(value) => { setStateFilter(value); setCurrentPage(1) }} suggestions={states} placeholder="All states" />
          </div>
          <div className="space-y-2">
            <Label>Billing Terms</Label>
            <Select value={billingFilter} onValueChange={(value) => { setBillingFilter(value); setCurrentPage(1) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Terms</SelectItem>
                {billingTerms.map((term) => <SelectItem key={term} value={term}>{term}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" onClick={() => { setSearch(""); setCityFilter(""); setStateFilter(""); setBillingFilter("all"); setStatusFilter("all"); setCurrentPage(1) }}>
              <X className="mr-2 h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-blue-900">{selectedIds.length} client(s) selected</p>
          <Button size="sm" variant="outline" onClick={() => exportClientsToExcel(selectedClients)}>Export selected</Button>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>Clear selection</Button>
        </div>
      )}

      <div className="rounded-lg border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <p className="font-semibold">Client Directory</p>
            <p className="text-sm text-slate-500">
              Showing {filteredClients.length === 0 ? 0 : (effectiveCurrentPage - 1) * CLIENTS_PER_PAGE + 1}-
              {Math.min(effectiveCurrentPage * CLIENTS_PER_PAGE, filteredClients.length)} of {filteredClients.length}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={toggleVisible}>
            {allVisibleSelected ? "Clear visible" : "Select visible"}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-slate-50">
              <TableRow>
                <TableHead className="w-[44px]"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /></TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Contract Health</TableHead>
                <TableHead>Commercials</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead>Portal</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedClients.map((client) => {
                const completeness = getCompleteness(client)
                return (
                  <TableRow key={client.id} className="hover:bg-blue-50/40">
                    <TableCell><input type="checkbox" checked={selectedIds.includes(client.id)} onChange={() => toggleSelect(client.id)} /></TableCell>
                    <TableCell className="min-w-64">
                      <button className="text-left" onClick={() => setDetailsClient(client)}>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-600">{client.client_code}</span>
                          <Badge className={client.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}>{client.is_active ? "Active" : "Inactive"}</Badge>
                        </div>
                        <div className="mt-1 font-semibold text-slate-950">{client.client_name}</div>
                        <div className="text-xs text-slate-500">GST: {client.gst_number || "Missing"}</div>
                      </button>
                    </TableCell>
                    <TableCell className="min-w-52">
                      <div>{client.contact_person || "No contact"}</div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Phone className="h-3 w-3" />{client.contact_phone || "No phone"}</div>
                      <div className="flex items-center gap-1 text-xs text-slate-500"><Mail className="h-3 w-3" />{client.contact_email || "No email"}</div>
                    </TableCell>
                    <TableCell>{client.city || "N/A"}, {client.state || "N/A"}</TableCell>
                    <TableCell><HealthBadge client={client} /></TableCell>
                    <TableCell className="min-w-60 text-sm">
                      {client.contract_code ? (
                        <>
                          <div>{client.billing_terms || "N/A"} · {formatDate(client.effective_from)} to {formatDate(client.effective_to)}</div>
                          <div className="text-xs text-slate-500">Storage {formatMoney(client.storage_rate_per_unit, client.contract_currency)} · Handling {formatMoney(client.handling_rate_per_unit, client.contract_currency)}</div>
                          <div className="text-xs text-slate-500">MG {formatMoney(client.minimum_guarantee_amount, client.contract_currency)}</div>
                        </>
                      ) : <span className="text-slate-500">No active contract</span>}
                    </TableCell>
                    <TableCell className="min-w-52">
                      <div className="flex flex-wrap gap-1">
                        <CompletenessBadge client={client} />
                        {completeness.warnings.slice(0, 2).map((warning) => (
                          <Badge key={warning} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{warning}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell><PortalBadge /></TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" onClick={() => setActionClient(client)} aria-label={`Actions for ${client.client_name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredClients.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-sm text-slate-500">
                    No clients match the selected filters. Clear filters or add a new client.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {filteredClients.length > 0 && (
          <div className="flex items-center justify-between border-t p-4">
            <p className="text-sm text-gray-600">Page {effectiveCurrentPage} of {totalPages}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={effectiveCurrentPage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</Button>
              <Button variant="outline" size="sm" disabled={effectiveCurrentPage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>Next</Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!actionClient} onOpenChange={(open) => !open && setActionClient(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Client Actions</DialogTitle>
            <DialogDescription>{actionClient?.client_name}</DialogDescription>
          </DialogHeader>
          {actionClient && (
            <div className="grid gap-2">
              <Button variant="outline" onClick={() => { setDetailsClient(actionClient); setActionClient(null) }}><Eye className="mr-2 h-4 w-4" />View Details</Button>
              <Button variant="outline" onClick={() => { handleOpenDialog(actionClient); setActionClient(null) }}>Edit Client</Button>
              <Button variant="outline" onClick={() => setActionClient(null)}>Configure Contract</Button>
              <Button variant="outline" onClick={() => setActionClient(null)}>Invite Portal User</Button>
              <Button variant="outline" className="text-rose-600" onClick={() => { setDeactivateClient(actionClient); setActionClient(null) }}>Deactivate Client</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deactivateClient} onOpenChange={(open) => !open && setDeactivateClient(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate client?</DialogTitle>
            <DialogDescription>
              This keeps audit history intact and removes the client from active operations.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Check open stock, orders, active contracts, and portal users before deactivating {deactivateClient?.client_name}.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateClient(null)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => {
              if (deactivateClient) deleteMutation.mutate(deactivateClient.id)
              setDeactivateClient(null)
            }}>Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailsClient} onOpenChange={(open) => !open && setDetailsClient(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-3rem)] max-w-6xl overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{detailsClient?.client_name}</DialogTitle>
            <DialogDescription>{detailsClient?.client_code}</DialogDescription>
          </DialogHeader>
          {detailsClient && <ClientDetails client={detailsClient} />}
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedClient ? "Edit Client" : "Add New Client"}</DialogTitle>
            <DialogDescription>{selectedClient ? "Update client information" : "Enter details for new client"}</DialogDescription>
          </DialogHeader>

          {duplicateWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {Array.from(new Set(duplicateWarnings)).join(", ")}
            </div>
          )}

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Client Code *" value={formData.client_code} onChange={(value) => setFormData({ ...formData, client_code: value })} />
              <Field label="Client Name *" value={formData.client_name} onChange={(value) => setFormData({ ...formData, client_name: value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Contact Person" value={formData.contact_person} onChange={(value) => setFormData({ ...formData, contact_person: value })} />
              <Field label="Contact Phone" value={formData.contact_phone} onChange={(value) => setFormData({ ...formData, contact_phone: value })} />
            </div>
            <Field label="Email" value={formData.contact_email} onChange={(value) => setFormData({ ...formData, contact_email: value })} />
            <div className="space-y-2">
              <Label>Address</Label>
              <Textarea value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} rows={2} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Field label="City" value={formData.city} onChange={(value) => setFormData({ ...formData, city: value })} />
              <Field label="State" value={formData.state} onChange={(value) => setFormData({ ...formData, state: value })} />
              <Field label="Pincode" value={formData.pincode} onChange={(value) => setFormData({ ...formData, pincode: value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="GST Number" value={formData.gst_number} onChange={(value) => setFormData({ ...formData, gst_number: value })} />
              <Field label="PAN Number" value={formData.pan_number} onChange={(value) => setFormData({ ...formData, pan_number: value })} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={formData.is_active ? "ACTIVE" : "INACTIVE"} onValueChange={(value) => setFormData({ ...formData, is_active: value === "ACTIVE" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={duplicateWarnings.length > 0 || saveMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {selectedClient ? "Update Client" : "Create Client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({ icon, label, value, tone = "blue" }: { icon: React.ReactNode; label: string; value: number; tone?: "blue" | "green" | "amber" | "rose" }) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    rose: "bg-rose-50 text-rose-600",
  }[tone]
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`rounded-md p-2 ${toneClass}`}>{icon}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold">{value}</p>
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function ClientDetails({ client }: { client: Client }) {
  const completeness = getCompleteness(client)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge className={client.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}>{client.is_active ? "Active" : "Inactive"}</Badge>
        <HealthBadge client={client} />
        <CompletenessBadge client={client} />
        <PortalBadge />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Detail title="Profile" rows={[
          ["GST", client.gst_number || "-"],
          ["PAN", client.pan_number || "-"],
          ["Contact", client.contact_person || "-"],
          ["Phone", client.contact_phone || "-"],
          ["Email", client.contact_email || "-"],
          ["Location", `${client.city || "N/A"}, ${client.state || "N/A"} ${client.pincode || ""}`],
          ["Address", client.address || "-"],
        ]} />
        <Detail title="Contract & Billing" rows={[
          ["Contract", client.contract_code || "Missing"],
          ["Dates", client.contract_code ? `${formatDate(client.effective_from)} to ${formatDate(client.effective_to)}` : "-"],
          ["Billing", client.billing_terms || "-"],
          ["Storage Rate", formatMoney(client.storage_rate_per_unit, client.contract_currency)],
          ["Handling Rate", formatMoney(client.handling_rate_per_unit, client.contract_currency)],
          ["Minimum Guarantee", formatMoney(client.minimum_guarantee_amount, client.contract_currency)],
        ]} />
        <Detail title="Onboarding Checklist" rows={[
          ["Profile", completeness.score >= 50 ? "Started" : "Needs work"],
          ["Contract", client.contract_code ? "Configured" : "Missing"],
          ["Rates", client.storage_rate_per_unit || client.handling_rate_per_unit ? "Configured" : "Missing"],
          ["Portal Users", "Not invited"],
          ["Opening Stock", "Not reviewed"],
        ]} />
        <Detail title="Recent Activity" rows={[
          ["Last GRN", "Not available"],
          ["Last DO", "Not available"],
          ["Last Invoice", "Not available"],
          ["Portal Login", "Not available"],
        ]} />
      </div>
      {completeness.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Data quality warnings: {completeness.warnings.join(", ")}
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
            <span className="min-w-0 whitespace-pre-wrap break-words font-medium leading-5">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
