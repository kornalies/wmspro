"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowUpDown,
  Building2,
  CheckCircle2,
  Download,
  Edit,
  Eye,
  Filter,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react"

import { useAuth } from "@/hooks/use-auth"
import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type Plan = "BASIC" | "PRO" | "ENTERPRISE"
type BillingStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED"
type StatusFilter = "all" | "active" | "inactive" | "suspended" | "trial-expiring" | "payment-failed" | "provisioning"
type SortKey =
  | "company_name"
  | "subscription_plan"
  | "active_users"
  | "storage_used_gb"
  | "billing_status"
  | "users_count"
  | "lifecycle"
  | "last_activity_at"
  | "updated_at"

type CompanyRow = {
  id: number
  company_code: string
  company_name: string
  domain?: string | null
  storage_bucket?: string | null
  subscription_plan?: Plan
  storage_used_gb?: number | string
  billing_status?: BillingStatus
  is_active: boolean
  users_count?: number
  active_users?: number
  product_codes?: string[]
  created_at?: string | null
  updated_at?: string | null
  owner_name?: string | null
  owner_email?: string | null
  last_activity_at?: string | null
  last_audit_at?: string | null
}

const COMPANIES_PER_PAGE = 10
const STORAGE_INCLUDED_GB: Record<Plan, number> = {
  BASIC: 25,
  PRO: 100,
  ENTERPRISE: 500,
}

const planBadge: Record<Plan, string> = {
  BASIC: "bg-sky-100 text-sky-800",
  PRO: "bg-violet-100 text-violet-800",
  ENTERPRISE: "bg-amber-100 text-amber-800",
}

const billingBadge: Record<BillingStatus, string> = {
  TRIAL: "bg-slate-100 text-slate-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  PAST_DUE: "bg-orange-100 text-orange-800",
  SUSPENDED: "bg-red-100 text-red-800",
}

function blankForm() {
  return {
    company_code: "",
    company_name: "",
    domain: "",
    storage_bucket: "",
    subscription_plan: "BASIC" as Plan,
    storage_used_gb: "0",
    billing_status: "TRIAL" as BillingStatus,
    admin_username: "",
    admin_email: "",
    admin_full_name: "",
    admin_password: "",
    is_active: true,
    product_codes: ["WMS"] as string[],
  }
}

function toNumber(value: unknown) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function formatDate(value?: string | null) {
  if (!value) return "Not available"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Not available"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Not available"
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

function trialExpiry(row: CompanyRow) {
  if (row.billing_status !== "TRIAL" || !row.created_at) return null
  const date = new Date(row.created_at)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 14)
  return date
}

function renewalDate(row: CompanyRow) {
  const source = row.updated_at || row.created_at
  if (!source || row.billing_status === "TRIAL") return null
  const date = new Date(source)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 30)
  return date
}

function daysUntil(date: Date | null) {
  if (!date) return null
  return Math.ceil((date.getTime() - Date.now()) / 86400000)
}

function lifecycleStatus(row: CompanyRow) {
  if (!row.is_active) return "Inactive"
  if (row.billing_status === "SUSPENDED") return "Suspended"
  if (row.billing_status === "PAST_DUE") return "Payment Failed"
  const expiryDays = daysUntil(trialExpiry(row))
  if (row.billing_status === "TRIAL" && expiryDays !== null && expiryDays <= 7) return "Trial Expiring"
  if ((row.product_codes?.length ?? 0) === 0 || toNumber(row.active_users) === 0) return "Provisioning"
  return "Active"
}

function lifecycleBadge(status: string) {
  if (status === "Active") return "bg-emerald-100 text-emerald-800"
  if (status === "Trial Expiring") return "bg-amber-100 text-amber-800"
  if (status === "Payment Failed") return "bg-orange-100 text-orange-800"
  if (status === "Suspended" || status === "Inactive") return "bg-red-100 text-red-800"
  return "bg-blue-100 text-blue-800"
}

function readinessWarnings(row: CompanyRow) {
  return [
    !row.owner_email ? "Missing tenant owner" : "",
    !row.domain ? "Domain not configured" : "",
    !row.storage_bucket ? "Storage bucket not configured" : "",
    (row.product_codes?.length ?? 0) === 0 ? "No product entitlement" : "",
    row.billing_status === "PAST_DUE" ? "Payment failed" : "",
    row.billing_status === "TRIAL" && daysUntil(trialExpiry(row)) !== null && daysUntil(trialExpiry(row))! <= 7
      ? "Trial ending soon"
      : "",
  ].filter(Boolean)
}

function storageQuota(row: CompanyRow) {
  return STORAGE_INCLUDED_GB[(row.subscription_plan || "BASIC") as Plan]
}

function storagePct(row: CompanyRow) {
  return Math.min(100, Math.round((toNumber(row.storage_used_gb) / storageQuota(row)) * 100))
}

function SortableHead({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string
  active: boolean
  dir: "asc" | "desc"
  onClick: () => void
  className?: string
}) {
  return (
    <TableHead className={className}>
      <button type="button" className="inline-flex items-center gap-1 font-medium" onClick={onClick}>
        {label}
        <ArrowUpDown className={`h-3.5 w-3.5 ${active ? "text-blue-600" : "text-gray-400"}`} />
        {active && <span className="sr-only">sorted {dir}</span>}
      </button>
    </TableHead>
  )
}

export default function CompaniesPage() {
  const { user, isLoading } = useAuth()
  const canManageCompanies =
    user?.permissions?.includes("admin.companies.manage") || user?.role === "SUPER_ADMIN"
  const companiesQuery = useAdminResource("companies")
  const saveMutation = useSaveAdminResource("companies")
  const deleteMutation = useDeleteAdminResource("companies")

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [planFilter, setPlanFilter] = useState("all")
  const [billingFilter, setBillingFilter] = useState("all")
  const [productFilter, setProductFilter] = useState("all")
  const [sortKey, setSortKey] = useState<SortKey>("company_name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<CompanyRow | null>(null)
  const [detailsRow, setDetailsRow] = useState<CompanyRow | null>(null)
  const [deleteRow, setDeleteRow] = useState<CompanyRow | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState("")
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState("")
  const [bulkPlan, setBulkPlan] = useState<Plan | "no-change">("no-change")
  const [bulkProducts, setBulkProducts] = useState<"no-change" | "WMS" | "FF" | "WMS_FF">("no-change")
  const [form, setForm] = useState(blankForm)

  const companies = useMemo(
    () => (companiesQuery.data as CompanyRow[] | undefined) ?? [],
    [companiesQuery.data]
  )
  const selectedRows = companies.filter((company) => selectedIds.includes(company.id))

  const searchSuggestions = useMemo(
    () =>
      companies.flatMap((company) => [
        company.company_code,
        company.company_name,
        company.domain || "",
        company.owner_email || "",
        company.owner_name || "",
      ]),
    [companies]
  )

  const stats = useMemo(() => {
    const active = companies.filter((c) => c.is_active).length
    const usersCount = companies.reduce((sum, c) => sum + toNumber(c.users_count), 0)
    const warnings = companies.reduce((sum, c) => sum + readinessWarnings(c).length, 0)
    const storageUsed = companies.reduce((sum, c) => sum + toNumber(c.storage_used_gb), 0)
    return { active, usersCount, warnings, storageUsed }
  }, [companies])

  const filtered = useMemo(() => {
    const searchValue = search.toLowerCase().trim()
    return companies.filter((company) => {
      const text = [
        company.company_code,
        company.company_name,
        company.domain || "",
        company.storage_bucket || "",
        company.owner_email || "",
        company.owner_name || "",
      ]
        .join(" ")
        .toLowerCase()
      const lifecycle = lifecycleStatus(company)
      const products = Array.isArray(company.product_codes) ? company.product_codes : []

      if (searchValue && !text.includes(searchValue)) return false
      if (statusFilter !== "all") {
        const statusMap: Record<StatusFilter, string> = {
          all: "",
          active: "Active",
          inactive: "Inactive",
          suspended: "Suspended",
          "trial-expiring": "Trial Expiring",
          "payment-failed": "Payment Failed",
          provisioning: "Provisioning",
        }
        if (lifecycle !== statusMap[statusFilter]) return false
      }
      if (planFilter !== "all" && company.subscription_plan !== planFilter) return false
      if (billingFilter !== "all" && company.billing_status !== billingFilter) return false
      if (productFilter !== "all" && !products.includes(productFilter)) return false
      return true
    })
  }, [billingFilter, companies, planFilter, productFilter, search, statusFilter])

  const sorted = useMemo(() => {
    const rows = [...filtered]
    rows.sort((a, b) => {
      const value = (row: CompanyRow) => {
        if (sortKey === "active_users") return toNumber(row.active_users)
        if (sortKey === "storage_used_gb") return toNumber(row.storage_used_gb)
        if (sortKey === "users_count") return toNumber(row.users_count)
        if (sortKey === "lifecycle") return lifecycleStatus(row)
        if (sortKey === "last_activity_at") return row.last_activity_at || ""
        if (sortKey === "updated_at") return row.updated_at || ""
        return String(row[sortKey] || "")
      }
      const left = value(a)
      const right = value(b)
      if (typeof left === "number" && typeof right === "number") {
        return sortDir === "asc" ? left - right : right - left
      }
      return sortDir === "asc"
        ? String(left).localeCompare(String(right))
        : String(right).localeCompare(String(left))
    })
    return rows
  }, [filtered, sortDir, sortKey])

  const totalPages = Math.max(1, Math.ceil(sorted.length / COMPANIES_PER_PAGE))
  const page = Math.min(currentPage, totalPages)
  const paginatedRows = sorted.slice((page - 1) * COMPANIES_PER_PAGE, page * COMPANIES_PER_PAGE)
  const pageIds = paginatedRows.map((row) => row.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id))

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir("asc")
  }

  const openCreate = () => {
    setEditRow(null)
    setForm(blankForm())
    setIsDialogOpen(true)
  }

  const openEdit = (row: CompanyRow) => {
    setEditRow(row)
    setForm({
      company_code: row.company_code,
      company_name: row.company_name,
      domain: row.domain || "",
      storage_bucket: row.storage_bucket || "",
      subscription_plan: row.subscription_plan || "BASIC",
      storage_used_gb: String(row.storage_used_gb ?? 0),
      billing_status: row.billing_status || "TRIAL",
      admin_username: "",
      admin_email: "",
      admin_full_name: "",
      admin_password: "",
      is_active: row.is_active,
      product_codes: Array.isArray(row.product_codes) && row.product_codes.length ? row.product_codes : ["WMS"],
    })
    setIsDialogOpen(true)
  }

  const payloadForRow = (row: CompanyRow, overrides: Partial<CompanyRow> = {}) => ({
    id: row.id,
    company_code: row.company_code,
    company_name: row.company_name,
    domain: row.domain || "",
    storage_bucket: row.storage_bucket || "",
    subscription_plan: row.subscription_plan || "BASIC",
    storage_used_gb: toNumber(row.storage_used_gb),
    billing_status: row.billing_status || "TRIAL",
    is_active: row.is_active,
    product_codes: Array.isArray(row.product_codes) && row.product_codes.length ? row.product_codes : ["WMS"],
    ...overrides,
  })

  const handleSave = async () => {
    if (!form.company_code || !form.company_name) return

    if (editRow) {
      await saveMutation.mutateAsync({
        id: editRow.id,
        company_code: form.company_code,
        company_name: form.company_name,
        domain: form.domain,
        storage_bucket: form.storage_bucket,
        subscription_plan: form.subscription_plan,
        storage_used_gb: Number(form.storage_used_gb || 0),
        billing_status: form.billing_status,
        is_active: form.is_active,
        product_codes: form.product_codes,
      })
    } else {
      if (!form.admin_username || !form.admin_email || !form.admin_full_name || !form.admin_password) return
      await saveMutation.mutateAsync({
        company_code: form.company_code,
        company_name: form.company_name,
        domain: form.domain,
        storage_bucket: form.storage_bucket,
        subscription_plan: form.subscription_plan,
        storage_used_gb: Number(form.storage_used_gb || 0),
        billing_status: form.billing_status,
        is_active: form.is_active,
        product_codes: form.product_codes,
        admin_username: form.admin_username,
        admin_email: form.admin_email,
        admin_full_name: form.admin_full_name,
        admin_password: form.admin_password,
      })
    }

    setIsDialogOpen(false)
  }

  const applyBulkChanges = async () => {
    const productCodes =
      bulkProducts === "WMS_FF" ? ["WMS", "FF"] : bulkProducts === "no-change" ? null : [bulkProducts]
    for (const row of selectedRows) {
      await saveMutation.mutateAsync(
        payloadForRow(row, {
          subscription_plan: bulkPlan === "no-change" ? row.subscription_plan : bulkPlan,
          product_codes: productCodes || row.product_codes || ["WMS"],
        })
      )
    }
    setBulkPlan("no-change")
    setBulkProducts("no-change")
  }

  const exportCsv = () => {
    const headers = [
      "Company",
      "Code",
      "Plan",
      "Lifecycle",
      "Billing",
      "Owner Email",
      "Domain",
      "Products",
      "Users",
      "Active Users",
      "Storage Used GB",
      "Storage Quota GB",
      "Created",
      "Updated",
      "Last Activity",
    ]
    const rows = sorted.map((row) => [
      row.company_name,
      row.company_code,
      row.subscription_plan || "BASIC",
      lifecycleStatus(row),
      row.billing_status || "TRIAL",
      row.owner_email || "",
      row.domain || "",
      (row.product_codes || []).join("|"),
      row.users_count ?? 0,
      row.active_users ?? 0,
      toNumber(row.storage_used_gb).toFixed(2),
      storageQuota(row),
      formatDate(row.created_at),
      formatDate(row.updated_at),
      formatDateTime(row.last_activity_at),
    ])
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "companies.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return <div className="p-4 text-sm text-gray-500">Loading...</div>
  }

  if (!canManageCompanies) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="font-medium">Access restricted</p>
          <p className="text-sm text-gray-500">You do not have permission to manage companies.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Company Management</h1>
          <p className="mt-1 text-gray-500">Create and operate SaaS tenant companies</p>
          <p className="mt-2 text-xs text-gray-500">
            Last refreshed {companiesQuery.dataUpdatedAt ? formatDateTime(new Date(companiesQuery.dataUpdatedAt).toISOString()) : "Not available"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => companiesQuery.refetch()} disabled={companiesQuery.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${companiesQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Add Company
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editRow ? "Edit Company" : "Create Company + First Admin"}</DialogTitle>
                <DialogDescription>
                  Configure the tenant lifecycle, subscription, entitlements, storage, and first administrator.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Company Code *</Label>
                    <Input
                      value={form.company_code}
                      onChange={(e) => setForm({ ...form, company_code: e.target.value.toUpperCase() })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Company Name *</Label>
                    <Input
                      value={form.company_name}
                      onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Subscription Plan</Label>
                    <Select
                      value={form.subscription_plan}
                      onValueChange={(v) => setForm({ ...form, subscription_plan: v as Plan })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BASIC">BASIC</SelectItem>
                        <SelectItem value="PRO">PRO</SelectItem>
                        <SelectItem value="ENTERPRISE">ENTERPRISE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Storage Used (GB)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.storage_used_gb}
                      onChange={(e) => setForm({ ...form, storage_used_gb: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Billing Status</Label>
                    <Select
                      value={form.billing_status}
                      onValueChange={(v) => setForm({ ...form, billing_status: v as BillingStatus })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="TRIAL">TRIAL</SelectItem>
                        <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                        <SelectItem value="PAST_DUE">PAST_DUE</SelectItem>
                        <SelectItem value="SUSPENDED">SUSPENDED</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select
                      value={form.is_active ? "ACTIVE" : "INACTIVE"}
                      onValueChange={(v) => setForm({ ...form, is_active: v === "ACTIVE" })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                        <SelectItem value="INACTIVE">INACTIVE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Domain</Label>
                    <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Storage Bucket</Label>
                    <Input
                      value={form.storage_bucket}
                      onChange={(e) => setForm({ ...form, storage_bucket: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Enabled Products</Label>
                  <div className="flex flex-wrap gap-4 rounded-md border p-3">
                    {[
                      { code: "WMS", label: "WMS" },
                      { code: "FF", label: "Freight Forwarding" },
                    ].map((product) => {
                      const checked = form.product_codes.includes(product.code)
                      return (
                        <label key={product.code} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setForm((prev) => ({
                                  ...prev,
                                  product_codes: Array.from(new Set([...prev.product_codes, product.code])),
                                }))
                                return
                              }
                              setForm((prev) => {
                                const next = prev.product_codes.filter((code) => code !== product.code)
                                return { ...prev, product_codes: next.length ? next : ["WMS"] }
                              })
                            }}
                          />
                          {product.label}
                        </label>
                      )
                    })}
                  </div>
                </div>

                {!editRow && (
                  <div className="rounded-md border p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <UserPlus className="h-4 w-4" />
                      First Admin User
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Username *</Label>
                        <Input
                          value={form.admin_username}
                          onChange={(e) => setForm({ ...form, admin_username: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Full Name *</Label>
                        <Input
                          value={form.admin_full_name}
                          onChange={(e) => setForm({ ...form, admin_full_name: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Email *</Label>
                        <Input
                          value={form.admin_email}
                          onChange={(e) => setForm({ ...form, admin_email: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Password *</Label>
                        <Input
                          type="password"
                          value={form.admin_password}
                          onChange={(e) => setForm({ ...form, admin_password: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button className="bg-blue-600" onClick={handleSave} disabled={saveMutation.isPending}>
                    Save
                  </Button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {companiesQuery.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Unable to load companies</AlertTitle>
          <AlertDescription>Refresh the page or check your connection before making tenant changes.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Total Companies", value: companies.length, icon: Building2, filter: "all" as StatusFilter },
          { label: "Active Companies", value: stats.active, icon: CheckCircle2, filter: "active" as StatusFilter },
          { label: "Tenant Users", value: stats.usersCount, icon: Users, filter: "all" as StatusFilter },
          { label: "Readiness Warnings", value: stats.warnings, icon: ShieldAlert, filter: "provisioning" as StatusFilter },
        ].map((stat) => (
          <button
            key={stat.label}
            type="button"
            className="rounded-lg border bg-white p-5 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50/30"
            onClick={() => {
              setStatusFilter(stat.filter)
              setCurrentPage(1)
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-gray-500">{stat.label}</p>
              <stat.icon className="h-5 w-5 text-blue-600" />
            </div>
            <p className="mt-3 text-2xl font-bold">{stat.value}</p>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative w-full xl:max-w-md">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <TypeaheadInput
                className="pl-9"
                value={search}
                onValueChange={(value) => {
                  setSearch(value)
                  setCurrentPage(1)
                }}
                suggestions={searchSuggestions}
                placeholder="Search companies, code, domain, owner..."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as StatusFilter); setCurrentPage(1) }}>
                <SelectTrigger className="w-[165px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="provisioning">Provisioning</SelectItem>
                  <SelectItem value="trial-expiring">Trial expiring</SelectItem>
                  <SelectItem value="payment-failed">Payment failed</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
              <Select value={planFilter} onValueChange={(v) => { setPlanFilter(v); setCurrentPage(1) }}>
                <SelectTrigger className="w-[135px]">
                  <SelectValue placeholder="Plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  <SelectItem value="BASIC">Basic</SelectItem>
                  <SelectItem value="PRO">Pro</SelectItem>
                  <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                </SelectContent>
              </Select>
              <Select value={billingFilter} onValueChange={(v) => { setBillingFilter(v); setCurrentPage(1) }}>
                <SelectTrigger className="w-[145px]">
                  <SelectValue placeholder="Billing" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All billing</SelectItem>
                  <SelectItem value="TRIAL">Trial</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="PAST_DUE">Past due</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                </SelectContent>
              </Select>
              <Select value={productFilter} onValueChange={(v) => { setProductFilter(v); setCurrentPage(1) }}>
                <SelectTrigger className="w-[145px]">
                  <SelectValue placeholder="Product" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  <SelectItem value="WMS">WMS</SelectItem>
                  <SelectItem value="FF">Freight</SelectItem>
                </SelectContent>
              </Select>
              {(search || statusFilter !== "all" || planFilter !== "all" || billingFilter !== "all" || productFilter !== "all") && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSearch("")
                    setStatusFilter("all")
                    setPlanFilter("all")
                    setBillingFilter("all")
                    setProductFilter("all")
                    setCurrentPage(1)
                  }}
                >
                  <X className="mr-2 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          {selectedIds.length > 0 && (
            <div className="flex flex-col gap-3 rounded-md border bg-slate-50 p-3 lg:flex-row lg:items-center lg:justify-between">
              <p className="text-sm font-medium">{selectedIds.length} selected</p>
              <div className="flex flex-wrap gap-2">
                <Select value={bulkPlan} onValueChange={(v) => setBulkPlan(v as Plan | "no-change")}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no-change">Keep plan</SelectItem>
                    <SelectItem value="BASIC">Basic</SelectItem>
                    <SelectItem value="PRO">Pro</SelectItem>
                    <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={bulkProducts} onValueChange={(v) => setBulkProducts(v as typeof bulkProducts)}>
                  <SelectTrigger className="w-[165px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no-change">Keep products</SelectItem>
                    <SelectItem value="WMS">WMS only</SelectItem>
                    <SelectItem value="FF">Freight only</SelectItem>
                    <SelectItem value="WMS_FF">WMS + Freight</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={applyBulkChanges}
                  disabled={saveMutation.isPending || (bulkPlan === "no-change" && bulkProducts === "no-change")}
                >
                  Apply selected
                </Button>
                <Button variant="outline" className="text-red-600" onClick={() => setBulkConfirmOpen(true)}>
                  Deactivate selected
                </Button>
              </div>
            </div>
          )}

          {companiesQuery.isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="h-14 animate-pulse rounded-md bg-slate-100" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="rounded-md border border-dashed p-10 text-center">
              <Building2 className="mx-auto h-8 w-8 text-gray-400" />
              <p className="mt-3 font-medium">No companies found</p>
              <p className="mt-1 text-sm text-gray-500">Adjust filters or create the first tenant company.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="w-10">
                    <input
                      aria-label="Select visible companies"
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])))
                          return
                        }
                        setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                      }}
                    />
                  </TableHead>
                  <SortableHead label="Company" active={sortKey === "company_name"} dir={sortDir} onClick={() => sortBy("company_name")} />
                  <SortableHead label="Plan" active={sortKey === "subscription_plan"} dir={sortDir} onClick={() => sortBy("subscription_plan")} />
                  <SortableHead label="Lifecycle" active={sortKey === "lifecycle"} dir={sortDir} onClick={() => sortBy("lifecycle")} />
                  <SortableHead label="Billing" active={sortKey === "billing_status"} dir={sortDir} onClick={() => sortBy("billing_status")} />
                  <TableHead>Owner</TableHead>
                  <TableHead>Products</TableHead>
                  <SortableHead label="Users" active={sortKey === "users_count"} dir={sortDir} onClick={() => sortBy("users_count")} />
                  <SortableHead label="Storage" active={sortKey === "storage_used_gb"} dir={sortDir} onClick={() => sortBy("storage_used_gb")} />
                  <TableHead>Renewal / Trial</TableHead>
                  <SortableHead label="Activity" active={sortKey === "last_activity_at"} dir={sortDir} onClick={() => sortBy("last_activity_at")} />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedRows.map((row) => {
                  const lifecycle = lifecycleStatus(row)
                  const warnings = readinessWarnings(row)
                  const expiry = trialExpiry(row)
                  const renewal = renewalDate(row)
                  return (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => setDetailsRow(row)}>
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <input
                          aria-label={`Select ${row.company_name}`}
                          type="checkbox"
                          checked={selectedIds.includes(row.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedIds((prev) => [...prev, row.id])
                            else setSelectedIds((prev) => prev.filter((id) => id !== row.id))
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                            <Building2 className="h-4 w-4 text-emerald-700" />
                          </div>
                          <div>
                            <p className="font-medium">{row.company_name}</p>
                            <p className="font-mono text-xs text-gray-500">{row.company_code}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={planBadge[(row.subscription_plan || "BASIC") as Plan]}>
                          {row.subscription_plan || "BASIC"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge className={lifecycleBadge(lifecycle)}>{lifecycle}</Badge>
                          {warnings.length > 0 && <span className="text-xs text-amber-700">{warnings.length} warning(s)</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={billingBadge[(row.billing_status || "TRIAL") as BillingStatus]}>
                          {row.billing_status || "TRIAL"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-sm">{row.owner_name || "Unassigned"}</p>
                          <p className="text-xs text-gray-500">{row.owner_email || "No owner email"}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(Array.isArray(row.product_codes) && row.product_codes.length ? row.product_codes : ["WMS"]).map((code) => (
                            <Badge key={`${row.id}-${code}`} className="bg-indigo-100 text-indigo-800">
                              {code}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <span className="font-medium">{row.active_users ?? 0}</span>
                          <span className="text-gray-500"> / {row.users_count ?? 0}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-[120px]">
                          <p className="text-sm">{toNumber(row.storage_used_gb).toFixed(2)} GB / {storageQuota(row)} GB</p>
                          <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                            <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${storagePct(row)}%` }} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{expiry ? formatDate(expiry.toISOString()) : renewal ? formatDate(renewal.toISOString()) : "Not scheduled"}</p>
                        {expiry && <p className="text-xs text-gray-500">{daysUntil(expiry)} day(s)</p>}
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{formatDateTime(row.last_activity_at)}</p>
                        <p className="text-xs text-gray-500">Updated {formatDate(row.updated_at)}</p>
                      </TableCell>
                      <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" title="View details" aria-label="View details" onClick={() => setDetailsRow(row)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Edit company" aria-label="Edit company" onClick={() => openEdit(row)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Deactivate company"
                            aria-label="Deactivate company"
                            className="text-red-600"
                            onClick={() => {
                              setDeleteRow(row)
                              setDeleteConfirm("")
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-col gap-2 border-t pt-4 text-sm text-gray-600 md:flex-row md:items-center md:justify-between">
            <p>
              Showing {sorted.length ? (page - 1) * COMPANIES_PER_PAGE + 1 : 0}-
              {Math.min(page * COMPANIES_PER_PAGE, sorted.length)} of {sorted.length}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(detailsRow)} onOpenChange={(open) => !open && setDetailsRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detailsRow?.company_name}</DialogTitle>
            <DialogDescription>{detailsRow?.company_code} tenant operations profile</DialogDescription>
          </DialogHeader>
          {detailsRow && (
            <div className="grid gap-4 md:grid-cols-2">
              {[
                ["Lifecycle", lifecycleStatus(detailsRow)],
                ["Owner", detailsRow.owner_email || "No owner assigned"],
                ["Domain", detailsRow.domain || "Not configured"],
                ["Storage Bucket", detailsRow.storage_bucket || "Not configured"],
                ["Users", `${detailsRow.active_users ?? 0} active / ${detailsRow.users_count ?? 0} total`],
                ["Storage", `${toNumber(detailsRow.storage_used_gb).toFixed(2)} GB of ${storageQuota(detailsRow)} GB`],
                ["Created", formatDate(detailsRow.created_at)],
                ["Updated", formatDateTime(detailsRow.updated_at)],
                ["Last Activity", formatDateTime(detailsRow.last_activity_at)],
                ["Last Audit Event", formatDateTime(detailsRow.last_audit_at)],
                ["Trial Expiry", trialExpiry(detailsRow) ? formatDate(trialExpiry(detailsRow)!.toISOString()) : "Not in trial"],
                ["Renewal", renewalDate(detailsRow) ? formatDate(renewalDate(detailsRow)!.toISOString()) : "Not scheduled"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border p-3">
                  <p className="text-xs uppercase text-gray-500">{label}</p>
                  <p className="mt-1 text-sm font-medium">{value}</p>
                </div>
              ))}
              <div className="md:col-span-2">
                <p className="mb-2 text-sm font-medium">Readiness</p>
                {readinessWarnings(detailsRow).length ? (
                  <div className="flex flex-wrap gap-2">
                    {readinessWarnings(detailsRow).map((warning) => (
                      <Badge key={warning} className="bg-amber-100 text-amber-800">
                        {warning}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <Badge className="bg-emerald-100 text-emerald-800">No warnings</Badge>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsRow(null)}>Close</Button>
            {detailsRow && <Button onClick={() => { openEdit(detailsRow); setDetailsRow(null) }}>Edit</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteRow)} onOpenChange={(open) => !open && setDeleteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate company</DialogTitle>
            <DialogDescription>
              This disables tenant access without hard deleting tenant data. Type the company code to confirm.
            </DialogDescription>
          </DialogHeader>
          {deleteRow && (
            <div className="space-y-3">
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Destructive tenant action</AlertTitle>
                <AlertDescription>Company code required: {deleteRow.company_code}</AlertDescription>
              </Alert>
              <Input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value.toUpperCase())} placeholder={deleteRow.company_code} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRow(null)}>Cancel</Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={!deleteRow || deleteConfirm !== deleteRow.company_code || deleteMutation.isPending}
              onClick={async () => {
                if (!deleteRow) return
                await deleteMutation.mutateAsync(deleteRow.id)
                setDeleteRow(null)
                setDeleteConfirm("")
              }}
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate selected companies</DialogTitle>
            <DialogDescription>Type DEACTIVATE to disable access for {selectedIds.length} selected tenant(s).</DialogDescription>
          </DialogHeader>
          <Input value={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.value.toUpperCase())} placeholder="DEACTIVATE" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>Cancel</Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={bulkConfirm !== "DEACTIVATE" || deleteMutation.isPending}
              onClick={async () => {
                for (const row of selectedRows) await deleteMutation.mutateAsync(row.id)
                setSelectedIds([])
                setBulkConfirm("")
                setBulkConfirmOpen(false)
              }}
            >
              Deactivate selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
