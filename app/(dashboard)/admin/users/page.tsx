"use client"

import { useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileSpreadsheet,
  KeyRound,
  Link2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  Upload,
  User,
  UserCheck,
  Users,
  Warehouse,
  X,
} from "lucide-react"
import * as XLSX from "xlsx"
import { toast } from "sonner"

import { useAdminResource, useDeleteUser, useRoles, useSaveUser, useUsers } from "@/hooks/use-admin"
import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { exportUserTemplateToExcel, exportUsersToExcel } from "@/lib/export-utils"
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

type UserRow = {
  id: number
  username: string
  full_name: string
  email?: string
  role: string
  warehouse_id?: number | null
  warehouse_name?: string | null
  is_active: boolean
  created_at?: string
  last_login?: string
  invite_status?: string
  mfa_enabled?: boolean
  password_reset_required?: boolean
  locked?: boolean
}

type ClientOption = {
  id: number
  client_code: string
  client_name: string
  is_active: boolean
}

type WarehouseOption = {
  id: number
  warehouse_name: string
  warehouse_code: string
  is_active: boolean
}

type StatusFilter = "all" | "admins" | "operations" | "clients" | "unassigned" | "inactive" | "invited" | "not-invited"
type SortKey = "full_name" | "username" | "email" | "role" | "warehouse_name" | "is_active" | "last_login"

const USERS_PER_PAGE = 12

const portalFeatures = [
  { key: "portal.inventory.view", label: "Inventory" },
  { key: "portal.orders.view", label: "Orders" },
  { key: "portal.billing.view", label: "Billing" },
  { key: "portal.reports.view", label: "Reports" },
  { key: "portal.sla.view", label: "SLA View" },
  { key: "portal.sla.manage", label: "SLA Manage" },
  { key: "portal.dispute.view", label: "Dispute View" },
  { key: "portal.dispute.create", label: "Dispute Create" },
  { key: "portal.dispute.manage", label: "Dispute Manage" },
  { key: "portal.asn.view", label: "ASN View" },
  { key: "portal.asn.create", label: "ASN Create" },
]

const roleColors: Record<string, string> = {
  SUPER_ADMIN: "bg-black text-white",
  ADMIN: "bg-rose-100 text-rose-800",
  WAREHOUSE_MANAGER: "bg-indigo-100 text-indigo-800",
  SUPERVISOR: "bg-blue-100 text-blue-800",
  OPERATOR: "bg-emerald-100 text-emerald-800",
  OPERATIONS: "bg-cyan-100 text-cyan-800",
  GATE_STAFF: "bg-teal-100 text-teal-800",
  FINANCE: "bg-purple-100 text-purple-800",
  CLIENT: "bg-slate-100 text-slate-800",
}

function blankForm(role = "") {
  return {
    full_name: "",
    username: "",
    email: "",
    role,
    warehouse_id: "",
    password: "",
    is_active: true,
  }
}

function prettyRole(role: string) {
  return String(role || "")
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "U"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function formatDateTime(value?: string) {
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

function inviteStatus(user: UserRow) {
  return user.invite_status || "Not Invited"
}

function securityWarnings(user: UserRow) {
  return [
    !user.email ? "Missing email" : "",
    !user.warehouse_id && !["SUPER_ADMIN", "ADMIN"].includes(user.role) ? "No warehouse" : "",
    user.role === "CLIENT" ? "Review client access" : "",
    !user.mfa_enabled ? "No MFA" : "",
    user.locked ? "Locked" : "",
  ].filter(Boolean)
}

export default function UsersPage() {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const usersQuery = useUsers()
  const rolesQuery = useRoles()
  const warehousesQuery = useAdminResource("warehouses")
  const saveMutation = useSaveUser()
  const deleteMutation = useDeleteUser()

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [roleFilter, setRoleFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [inviteFilter, setInviteFilter] = useState("all")
  const [securityFilter, setSecurityFilter] = useState("all")
  const [sortKey, setSortKey] = useState<SortKey>("full_name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)
  const [detailsUser, setDetailsUser] = useState<UserRow | null>(null)
  const [actionUser, setActionUser] = useState<UserRow | null>(null)
  const [deactivateUser, setDeactivateUser] = useState<UserRow | null>(null)
  const [roleConfirmOpen, setRoleConfirmOpen] = useState(false)
  const [pendingSave, setPendingSave] = useState<Record<string, unknown> | null>(null)
  const [form, setForm] = useState(blankForm)
  const [isPortalDialogOpen, setIsPortalDialogOpen] = useState(false)
  const [portalUser, setPortalUser] = useState<UserRow | null>(null)
  const [portalSearch, setPortalSearch] = useState("")
  const [portalClients, setPortalClients] = useState<ClientOption[]>([])
  const [mappedClientIds, setMappedClientIds] = useState<number[]>([])
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalPermissions, setPortalPermissions] = useState<string[]>([])

  const users = (usersQuery.data as UserRow[] | undefined) ?? []
  const roleOptions = (rolesQuery.data as Array<{ role_code: string; role_name: string }> | undefined) ?? []
  const warehouseOptions = ((warehousesQuery.data as WarehouseOption[] | undefined) ?? []).filter((warehouse) => warehouse.is_active)
  const selectedUsers = users.filter((user) => selectedIds.includes(user.id))

  const searchSuggestions = useMemo(
    () => users.flatMap((user) => [user.full_name, user.username, user.email || "", user.role, user.warehouse_name || ""]),
    [users]
  )

  const duplicateWarnings = useMemo(() => {
    const username = form.username.trim().toLowerCase()
    const email = form.email.trim().toLowerCase()
    return users
      .filter((user) => user.id !== editUser?.id)
      .flatMap((user) => [
        username && user.username.trim().toLowerCase() === username ? "Username already exists" : "",
        email && String(user.email || "").trim().toLowerCase() === email ? "Email already exists" : "",
      ])
      .filter(Boolean)
  }, [editUser, form.email, form.username, users])

  const metrics = useMemo(() => {
    const admins = users.filter((u) => ["SUPER_ADMIN", "ADMIN"].includes(u.role)).length
    const clientUsers = users.filter((u) => u.role === "CLIENT").length
    const unassigned = users.filter((u) => !u.warehouse_id && !["SUPER_ADMIN", "ADMIN"].includes(u.role)).length
    const noMfa = users.filter((u) => !u.mfa_enabled).length
    const pendingInvites = users.filter((u) => ["Pending", "Invited"].includes(inviteStatus(u))).length
    return { admins, clientUsers, unassigned, noMfa, pendingInvites }
  }, [users])

  const filteredPortalClients = useMemo(() => {
    const term = portalSearch.trim().toLowerCase()
    if (!term) return portalClients
    return portalClients.filter((client) => client.client_name.toLowerCase().includes(term) || client.client_code.toLowerCase().includes(term))
  }, [portalClients, portalSearch])

  const activePortalClients = useMemo(() => portalClients.filter((client) => client.is_active), [portalClients])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = users.filter((user) => {
      const matchesSearch =
        !q ||
        [user.full_name, user.username, user.email, user.role, user.warehouse_name].some((value) =>
          String(value || "").toLowerCase().includes(q)
        )
      const matchesChip =
        statusFilter === "all" ||
        (statusFilter === "admins" && ["SUPER_ADMIN", "ADMIN"].includes(user.role)) ||
        (statusFilter === "operations" && ["OPERATIONS", "OPERATOR", "SUPERVISOR", "WAREHOUSE_MANAGER", "GATE_STAFF"].includes(user.role)) ||
        (statusFilter === "clients" && user.role === "CLIENT") ||
        (statusFilter === "unassigned" && !user.warehouse_id) ||
        (statusFilter === "inactive" && !user.is_active) ||
        (statusFilter === "invited" && inviteStatus(user) !== "Not Invited") ||
        (statusFilter === "not-invited" && inviteStatus(user) === "Not Invited")
      const matchesRole = roleFilter === "all" || user.role === roleFilter
      const matchesWarehouse = warehouseFilter === "all" || String(user.warehouse_id || "") === warehouseFilter
      const matchesInvite = inviteFilter === "all" || inviteStatus(user) === inviteFilter
      const matchesSecurity =
        securityFilter === "all" ||
        (securityFilter === "no-mfa" && !user.mfa_enabled) ||
        (securityFilter === "locked" && user.locked) ||
        (securityFilter === "missing-email" && !user.email)
      return matchesSearch && matchesChip && matchesRole && matchesWarehouse && matchesInvite && matchesSecurity
    })

    return [...rows].sort((a, b) => {
      const left = String(a[sortKey] ?? "").toLowerCase()
      const right = String(b[sortKey] ?? "").toLowerCase()
      return sortDir === "asc" ? left.localeCompare(right) : right.localeCompare(left)
    })
  }, [inviteFilter, roleFilter, search, securityFilter, sortDir, sortKey, statusFilter, users, warehouseFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / USERS_PER_PAGE))
  const effectivePage = Math.min(currentPage, totalPages)
  const paginatedUsers = filtered.slice((effectivePage - 1) * USERS_PER_PAGE, effectivePage * USERS_PER_PAGE)
  const allVisibleSelected = paginatedUsers.length > 0 && paginatedUsers.every((user) => selectedIds.includes(user.id))

  const savePortalMappingsMutation = useMutation({
    mutationFn: async () => {
      if (!portalUser) return null
      return apiClient.put("/admin/portal-mappings", {
        user_id: portalUser.id,
        client_ids: mappedClientIds,
        feature_permissions: portalPermissions,
      })
    },
    onSuccess: () => {
      toast.success("Portal access updated")
      setIsPortalDialogOpen(false)
    },
    onError: (error) => handleError(error, "Failed to update portal access"),
  })

  const createInviteMutation = useMutation({
    mutationFn: async (userId: number) =>
      apiClient.post<{ activation_url: string; expires_at: string }>("/admin/portal-invites", {
        user_id: userId,
        expires_hours: 72,
      }),
    onSuccess: async (res) => {
      const activationUrl = String(res.data?.activation_url || "")
      if (activationUrl && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(activationUrl)
          toast.success("Invite link copied to clipboard")
          return
        } catch {
          // use fallback toast
        }
      }
      toast.success(`Invite created: ${activationUrl || "link generated"}`)
    },
    onError: (error) => handleError(error, "Failed to create portal invite"),
  })

  const openCreate = () => {
    setEditUser(null)
    setForm(blankForm(roleOptions[0]?.role_code || ""))
    setIsDialogOpen(true)
  }

  const openEdit = (user: UserRow) => {
    setEditUser(user)
    setForm({
      full_name: user.full_name,
      username: user.username,
      email: user.email || "",
      role: String(user.role || "").toUpperCase(),
      warehouse_id: user.warehouse_id ? String(user.warehouse_id) : "",
      password: "",
      is_active: user.is_active,
    })
    setIsDialogOpen(true)
  }

  const buildPayload = () => ({
    ...(editUser ? { id: editUser.id } : {}),
    ...form,
    warehouse_id: form.warehouse_id ? Number(form.warehouse_id) : null,
    ...(!editUser ? { password: form.password.trim() } : {}),
  })

  const performSave = async (payload: Record<string, unknown>) => {
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
    setPendingSave(null)
    setRoleConfirmOpen(false)
  }

  const handleSave = async () => {
    if (!form.full_name || !form.username || !form.role || duplicateWarnings.length > 0) return
    if (!editUser && !form.password.trim()) return

    const payload = buildPayload()
    const beforeRole = editUser?.role || ""
    const afterRole = String(form.role || "")
    const highRiskRoleChange =
      Boolean(editUser) &&
      beforeRole !== afterRole &&
      (["SUPER_ADMIN", "ADMIN"].includes(beforeRole) || ["SUPER_ADMIN", "ADMIN"].includes(afterRole))
    if (highRiskRoleChange) {
      setPendingSave(payload)
      setRoleConfirmOpen(true)
      return
    }
    await performSave(payload)
  }

  const openPortalAccess = async (user: UserRow) => {
    try {
      setPortalLoading(true)
      setPortalUser(user)
      setPortalSearch("")
      setIsPortalDialogOpen(true)
      const res = await apiClient.get<{
        user: UserRow
        clients: ClientOption[]
        mapped_client_ids: number[]
        feature_permissions: string[]
      }>(`/admin/portal-mappings?user_id=${user.id}`)
      setPortalClients(res.data?.clients ?? [])
      setMappedClientIds((res.data?.mapped_client_ids ?? []).map((v) => Number(v)))
      const existing = (res.data?.feature_permissions ?? []).map((v) => String(v))
      setPortalPermissions(existing.length > 0 ? existing : portalFeatures.map((f) => f.key))
    } catch (error) {
      handleError(error, "Failed to load portal access")
      setIsPortalDialogOpen(false)
    } finally {
      setPortalLoading(false)
    }
  }

  const toggleClient = (clientId: number, checked: boolean) => {
    setMappedClientIds((prev) => (checked ? Array.from(new Set([...prev, clientId])) : prev.filter((id) => id !== clientId)))
  }

  const togglePermission = (featureKey: string, checked: boolean) => {
    setPortalPermissions((prev) => (checked ? Array.from(new Set([...prev, featureKey])) : prev.filter((key) => key !== featureKey)))
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const toggleVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !paginatedUsers.some((user) => user.id === id)))
      return
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...paginatedUsers.map((user) => user.id)])))
  }

  const clearFilters = () => {
    setSearch("")
    setStatusFilter("all")
    setRoleFilter("all")
    setWarehouseFilter("all")
    setInviteFilter("all")
    setSecurityFilter("all")
    setCurrentPage(1)
  }

  const handleImport = async (file: File) => {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    for (const row of rows) {
      const role = String(row.Role || "").trim().toUpperCase()
      const warehouseName = String(row.Warehouse || "").trim().toLowerCase()
      const warehouse = warehouseOptions.find((option) => option.warehouse_name.trim().toLowerCase() === warehouseName)
      const payload = {
        full_name: String(row["Full Name"] || "").trim(),
        username: String(row.Username || "").trim(),
        email: String(row.Email || "").trim(),
        role,
        warehouse_id: warehouse ? warehouse.id : null,
        password: String(row.Password || "").trim(),
        is_active: String(row.Status || "Active").toLowerCase() !== "inactive",
      }
      if (payload.full_name && payload.username && payload.email && payload.role && payload.password) {
        await saveMutation.mutateAsync(payload)
      }
    }
    if (importInputRef.current) importInputRef.current.value = ""
  }

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDir("asc")
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">User Management</h1>
          <p className="mt-1 text-gray-500">Manage system users, roles, access scope, and security posture</p>
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
          <Button variant="outline" onClick={() => exportUserTemplateToExcel()}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Template
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={() => exportUsersToExcel(filtered)}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <Metric icon={<Users className="h-4 w-4" />} label="Total Users" value={users.length} />
        <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={users.filter((u) => u.is_active).length} tone="green" />
        <Metric icon={<Shield className="h-4 w-4" />} label="Admins" value={metrics.admins} tone="rose" />
        <Metric icon={<Clock3 className="h-4 w-4" />} label="Pending Invites" value={metrics.pendingInvites} tone="amber" />
        <Metric icon={<LockKeyhole className="h-4 w-4" />} label="No MFA" value={metrics.noMfa} tone="amber" />
        <Metric icon={<Warehouse className="h-4 w-4" />} label="Unassigned" value={metrics.unassigned} />
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            {[
              ["all", "All"],
              ["admins", "Admins"],
              ["operations", "Operations"],
              ["clients", "Clients"],
              ["unassigned", "Unassigned"],
              ["inactive", "Inactive"],
              ["invited", "Invited"],
              ["not-invited", "Not Invited"],
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
                  placeholder="Name, username, email, role, warehouse"
                />
              </div>
            </div>
            <FilterSelect label="Role" value={roleFilter} onChange={setRoleFilter} options={roleOptions.map((role) => ({ value: role.role_code, label: role.role_name }))} />
            <FilterSelect label="Warehouse" value={warehouseFilter} onChange={setWarehouseFilter} options={warehouseOptions.map((warehouse) => ({ value: String(warehouse.id), label: warehouse.warehouse_name }))} />
            <FilterSelect label="Invite" value={inviteFilter} onChange={setInviteFilter} options={["Not Invited", "Pending", "Invited", "Expired"].map((value) => ({ value, label: value }))} />
            <FilterSelect label="Security" value={securityFilter} onChange={setSecurityFilter} options={[{ value: "no-mfa", label: "No MFA" }, { value: "locked", label: "Locked" }, { value: "missing-email", label: "Missing Email" }]} />
          </div>
          <Button variant="outline" onClick={clearFilters}>
            <X className="mr-2 h-4 w-4" />
            Clear Filters
          </Button>
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-blue-900">{selectedIds.length} user(s) selected</p>
          <Button size="sm" variant="outline" onClick={() => exportUsersToExcel(selectedUsers)}>Export selected</Button>
          <Button size="sm" variant="outline" onClick={() => selectedUsers.forEach((user) => createInviteMutation.mutate(user.id))}>Invite selected</Button>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>Clear selection</Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b p-4">
            <div>
              <p className="font-semibold">User Directory</p>
              <p className="text-sm text-slate-500">
                Showing {filtered.length === 0 ? 0 : (effectivePage - 1) * USERS_PER_PAGE + 1}-{Math.min(effectivePage * USERS_PER_PAGE, filtered.length)} of {filtered.length}
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
                  <SortableHead label="User" active={sortKey === "full_name"} dir={sortDir} onClick={() => sortBy("full_name")} />
                  <SortableHead label="Username" active={sortKey === "username"} dir={sortDir} onClick={() => sortBy("username")} />
                  <SortableHead label="Email" active={sortKey === "email"} dir={sortDir} onClick={() => sortBy("email")} />
                  <SortableHead label="Role" active={sortKey === "role"} dir={sortDir} onClick={() => sortBy("role")} />
                  <TableHead>Access Scope</TableHead>
                  <TableHead>Invite</TableHead>
                  <SortableHead label="Last Login" active={sortKey === "last_login"} dir={sortDir} onClick={() => sortBy("last_login")} />
                  <TableHead>Security</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedUsers.map((user) => (
                  <TableRow key={user.id} className="hover:bg-blue-50/40">
                    <TableCell><input type="checkbox" checked={selectedIds.includes(user.id)} onChange={() => toggleSelect(user.id)} /></TableCell>
                    <TableCell className="min-w-56">
                      <button className="flex items-center gap-3 text-left" onClick={() => setDetailsUser(user)}>
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
                          {initials(user.full_name)}
                        </div>
                        <div>
                          <div className="font-medium">{user.full_name}</div>
                          <div className="text-xs text-slate-500">{securityWarnings(user).slice(0, 2).join(" · ")}</div>
                        </div>
                      </button>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{user.username}</TableCell>
                    <TableCell>{user.email || <span className="text-slate-400">Missing</span>}</TableCell>
                    <TableCell><RoleBadge role={user.role} /></TableCell>
                    <TableCell className="min-w-44">
                      <Badge variant="outline">{user.warehouse_name || "Unassigned"}</Badge>
                      {user.role === "CLIENT" && <div className="mt-1 text-xs text-slate-500">Client access configurable</div>}
                    </TableCell>
                    <TableCell><InviteBadge status={inviteStatus(user)} /></TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(user.last_login)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline" className={user.mfa_enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                          {user.mfa_enabled ? "MFA" : "No MFA"}
                        </Badge>
                        {user.locked && <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">Locked</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={user.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                        {user.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" onClick={() => setActionUser(user)} aria-label={`Actions for ${user.full_name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-12 text-center text-sm text-slate-500">
                      No users match the selected filters. Clear filters or add a new user.
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

      <Dialog open={!!actionUser} onOpenChange={(open) => !open && setActionUser(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>User Actions</DialogTitle>
            <DialogDescription>{actionUser?.full_name}</DialogDescription>
          </DialogHeader>
          {actionUser && (
            <div className="grid gap-2">
              <Button variant="outline" onClick={() => { setDetailsUser(actionUser); setActionUser(null) }}><Eye className="mr-2 h-4 w-4" />View Details</Button>
              <Button variant="outline" onClick={() => { openEdit(actionUser); setActionUser(null) }}>Edit</Button>
              <Button variant="outline" onClick={() => { void openPortalAccess(actionUser); setActionUser(null) }}><Link2 className="mr-2 h-4 w-4" />Assign Clients</Button>
              <Button variant="outline" onClick={() => { createInviteMutation.mutate(actionUser.id); setActionUser(null) }} disabled={createInviteMutation.isPending}>Send Invite</Button>
              <Button variant="outline" onClick={() => { toast.success("Password reset flow queued") ; setActionUser(null) }}><KeyRound className="mr-2 h-4 w-4" />Reset Password</Button>
              <Button
                variant="outline"
                className="text-rose-600"
                disabled={actionUser.role === "SUPER_ADMIN"}
                onClick={() => { setDeactivateUser(actionUser); setActionUser(null) }}
              >
                Deactivate
              </Button>
              {actionUser.role === "SUPER_ADMIN" && <p className="text-xs text-rose-600">Super Admin deactivation is protected.</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deactivateUser} onOpenChange={(open) => !open && setDeactivateUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate user?</DialogTitle>
            <DialogDescription>This removes active access while preserving audit history.</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Review assigned clients, warehouse access, active sessions, and open tasks before deactivating {deactivateUser?.full_name}.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateUser(null)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => {
              if (deactivateUser) deleteMutation.mutate(deactivateUser.id)
              setDeactivateUser(null)
            }}>Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailsUser} onOpenChange={(open) => !open && setDetailsUser(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-3rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{detailsUser?.full_name}</DialogTitle>
            <DialogDescription>{detailsUser?.username}</DialogDescription>
          </DialogHeader>
          {detailsUser && <UserDetails user={detailsUser} />}
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editUser ? "Edit User" : "Add New User"}</DialogTitle>
            <DialogDescription>{editUser ? "Update user identity, role, and access scope." : "Create a user and assign their initial role."}</DialogDescription>
          </DialogHeader>
          {duplicateWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {Array.from(new Set(duplicateWarnings)).join(", ")}
            </div>
          )}
          {editUser && editUser.role !== form.role && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              Role changes affect permissions and will require confirmation for admin roles.
            </div>
          )}
          <div className="grid gap-4 pt-2">
            <Field label="Full Name *" value={form.full_name} onChange={(value) => setForm({ ...form, full_name: value })} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Username *" value={form.username} onChange={(value) => setForm({ ...form, username: value })} />
              <Field label="Email *" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Role *</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role) => <SelectItem key={role.role_code} value={role.role_code}>{role.role_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Warehouse</Label>
                <Select value={form.warehouse_id || "__none__"} onValueChange={(v) => setForm({ ...form, warehouse_id: v === "__none__" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {warehouseOptions.map((warehouse) => <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.warehouse_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Status *</Label>
                <Select value={form.is_active ? "active" : "inactive"} onValueChange={(v) => setForm({ ...form, is_active: v === "active" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Field label={editUser ? "New Password" : "Password *"} type="password" value={form.password} onChange={(value) => setForm({ ...form, password: value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700" disabled={duplicateWarnings.length > 0 || saveMutation.isPending || (!editUser && !form.password.trim())}>
              Save User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={roleConfirmOpen} onOpenChange={setRoleConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm role change</DialogTitle>
            <DialogDescription>Changing admin-level roles can grant or remove sensitive permissions.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p>Review this change carefully before saving. Audit history will record the update.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleConfirmOpen(false)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => pendingSave && void performSave(pendingSave)}>Confirm Role Change</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPortalDialogOpen} onOpenChange={setIsPortalDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Portal Access Mapping</DialogTitle>
            <DialogDescription>{portalUser ? `${portalUser.full_name} (${portalUser.username})` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2">
              <Input value={portalSearch} onChange={(e) => setPortalSearch(e.target.value)} placeholder="Search client name/code..." />
              <Button type="button" variant="outline" onClick={() => setMappedClientIds(activePortalClients.map((c) => c.id))} disabled={portalLoading || savePortalMappingsMutation.isPending}>Select All</Button>
              <Button type="button" variant="outline" onClick={() => setMappedClientIds([])} disabled={portalLoading || savePortalMappingsMutation.isPending}>Clear</Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto rounded-md border p-2">
              {portalLoading ? (
                <p className="text-sm text-gray-500">Loading mappings...</p>
              ) : filteredPortalClients.length === 0 ? (
                <p className="text-sm text-gray-500">No clients found.</p>
              ) : (
                filteredPortalClients.map((client) => (
                  <label key={client.id} className={`flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 ${client.is_active ? "hover:bg-gray-50" : "bg-gray-50 text-gray-400"}`}>
                    <span className="text-sm">{client.client_name} <span className="font-mono text-xs text-gray-500">({client.client_code})</span></span>
                    <input type="checkbox" checked={mappedClientIds.includes(client.id)} onChange={(e) => toggleClient(client.id, e.target.checked)} disabled={!client.is_active || savePortalMappingsMutation.isPending} />
                  </label>
                ))
              )}
            </div>
            <div className="space-y-2 rounded-md border p-2">
              <p className="text-xs font-medium text-gray-700">Portal Feature Permissions</p>
              <div className="grid grid-cols-2 gap-2">
                {portalFeatures.map((feature) => (
                  <label key={feature.key} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-50">
                    <span className="text-xs">{feature.label}</span>
                    <input type="checkbox" checked={portalPermissions.includes(feature.key)} onChange={(e) => togglePermission(feature.key, e.target.checked)} disabled={savePortalMappingsMutation.isPending} />
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-gray-600">Selected clients: {mappedClientIds.length}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPortalDialogOpen(false)} disabled={savePortalMappingsMutation.isPending}>Cancel</Button>
            <Button className="bg-blue-600" onClick={() => savePortalMappingsMutation.mutate()} disabled={!portalUser || portalLoading || savePortalMappingsMutation.isPending}>Save Portal Access</Button>
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

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge className={roleColors[role] || "bg-gray-100 text-gray-800"}>
      <Shield className="mr-1 h-3 w-3" />
      {prettyRole(role)}
    </Badge>
  )
}

function InviteBadge({ status }: { status: string }) {
  const className =
    status === "Not Invited"
      ? "border-slate-200 bg-slate-50 text-slate-700"
      : status === "Expired"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : "border-amber-200 bg-amber-50 text-amber-700"
  return <Badge variant="outline" className={className}>{status}</Badge>
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function UserDetails({ user }: { user: UserRow }) {
  const warnings = securityWarnings(user)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge className={user.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{user.is_active ? "Active" : "Inactive"}</Badge>
        <RoleBadge role={user.role} />
        <InviteBadge status={inviteStatus(user)} />
        <Badge variant="outline" className={user.mfa_enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{user.mfa_enabled ? "MFA Enabled" : "No MFA"}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Detail title="Profile" rows={[
          ["Full Name", user.full_name],
          ["Username", user.username],
          ["Email", user.email || "Missing"],
          ["Status", user.is_active ? "Active" : "Inactive"],
          ["Created", formatDateTime(user.created_at)],
        ]} />
        <Detail title="Access Scope" rows={[
          ["Role", prettyRole(user.role)],
          ["Warehouse", user.warehouse_name || "Unassigned"],
          ["Clients", user.role === "CLIENT" ? "Configured in portal access" : "All permitted by role/policy"],
          ["Products", "WMS"],
        ]} />
        <Detail title="Security State" rows={[
          ["Last Login", formatDateTime(user.last_login)],
          ["MFA", user.mfa_enabled ? "Enabled" : "Not enabled"],
          ["Password Reset", user.password_reset_required ? "Required" : "Not required"],
          ["Locked", user.locked ? "Yes" : "No"],
        ]} />
        <Detail title="Recent Activity" rows={[
          ["Last Portal Invite", inviteStatus(user)],
          ["Last Update", "Available in audit log"],
          ["Recent Session", formatDateTime(user.last_login)],
        ]} />
      </div>
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Data/security warnings: {warnings.join(", ")}
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
