"use client"

import { useMemo, useState } from "react"
import { Edit, Link2, Plus, Search, Shield, Trash2, User } from "lucide-react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { useAdminResource, useDeleteUser, useRoles, useSaveUser, useUsers } from "@/hooks/use-admin"
import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent } from "@/components/ui/card"

type UserRow = {
  id: number
  username: string
  full_name: string
  email?: string
  role: string
  warehouse_id?: number | null
  warehouse_name?: string | null
  is_active: boolean
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
  ADMIN: "bg-red-100 text-red-800",
  WAREHOUSE_MANAGER: "bg-indigo-100 text-indigo-800",
  SUPERVISOR: "bg-blue-100 text-blue-800",
  OPERATOR: "bg-green-100 text-green-800",
  OPERATIONS: "bg-cyan-100 text-cyan-800",
  GATE_STAFF: "bg-emerald-100 text-emerald-800",
  FINANCE: "bg-purple-100 text-purple-800",
}

export default function UsersPage() {
  const usersQuery = useUsers()
  const rolesQuery = useRoles()
  const warehousesQuery = useAdminResource("warehouses")
  const saveMutation = useSaveUser()
  const deleteMutation = useDeleteUser()

  const [search, setSearch] = useState("")
  const [searchInputKey, setSearchInputKey] = useState(0)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)
  const [form, setForm] = useState({
    full_name: "",
    username: "",
    email: "",
    role: "",
    warehouse_id: "",
    password: "",
    is_active: true,
  })
  const [isPortalDialogOpen, setIsPortalDialogOpen] = useState(false)
  const [portalUser, setPortalUser] = useState<UserRow | null>(null)
  const [portalSearch, setPortalSearch] = useState("")
  const [portalClients, setPortalClients] = useState<ClientOption[]>([])
  const [mappedClientIds, setMappedClientIds] = useState<number[]>([])
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalPermissions, setPortalPermissions] = useState<string[]>([])

  const users = (usersQuery.data as UserRow[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () => users.flatMap((user) => [user.full_name, user.username, user.email || ""]),
    [users]
  )
  const roleOptions = (rolesQuery.data as Array<{ role_code: string; role_name: string }> | undefined) ?? []
  const warehouseOptions = (
    (warehousesQuery.data as WarehouseOption[] | undefined) ?? []
  ).filter((warehouse) => warehouse.is_active)
  const filtered = users.filter(
    (u) =>
      u.full_name.toLowerCase().includes(search.toLowerCase()) ||
      u.username.toLowerCase().includes(search.toLowerCase())
  )
  const filteredPortalClients = useMemo(() => {
    const term = portalSearch.trim().toLowerCase()
    if (!term) return portalClients
    return portalClients.filter(
      (client) =>
        client.client_name.toLowerCase().includes(term) ||
        client.client_code.toLowerCase().includes(term)
    )
  }, [portalClients, portalSearch])
  const activePortalClients = useMemo(
    () => portalClients.filter((client) => client.is_active),
    [portalClients]
  )

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
          // fall through to toast below
        }
      }
      toast.success(`Invite created: ${activationUrl || "link generated"}`)
    },
    onError: (error) => handleError(error, "Failed to create portal invite"),
  })

  const openCreate = () => {
    setEditUser(null)
    setSearch("")
    setSearchInputKey((prev) => prev + 1)
    setForm({
      full_name: "",
      username: "",
      email: "",
      role: roleOptions[0]?.role_code || "",
      warehouse_id: "",
      password: "",
      is_active: true,
    })
    setIsDialogOpen(true)
  }

  const openEdit = (user: UserRow) => {
    setEditUser(user)
    setSearch("")
    setSearchInputKey((prev) => prev + 1)
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

  const handleSave = async () => {
    if (!form.full_name || !form.username || !form.role) return
    if (!editUser && !form.password.trim()) return

    const payload = {
      ...(editUser ? { id: editUser.id } : {}),
      ...form,
      warehouse_id: form.warehouse_id ? Number(form.warehouse_id) : null,
      ...(!editUser ? { password: form.password.trim() } : {}),
    }
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
    setSearch("")
    setSearchInputKey((prev) => prev + 1)
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
    setMappedClientIds((prev) => {
      if (checked) {
        if (prev.includes(clientId)) return prev
        return [...prev, clientId]
      }
      return prev.filter((id) => id !== clientId)
    })
  }
  const togglePermission = (featureKey: string, checked: boolean) => {
    setPortalPermissions((prev) => {
      if (checked) {
        if (prev.includes(featureKey)) return prev
        return [...prev, featureKey]
      }
      return prev.filter((key) => key !== featureKey)
    })
  }
  const handleUserDialogOpenChange = (open: boolean) => {
    setIsDialogOpen(open)
    if (open) {
      setSearch("")
      setSearchInputKey((prev) => prev + 1)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">User Management</h1>
          <p className="mt-1 text-gray-500">Manage system users and roles</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={handleUserDialogOpenChange}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> Add User
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editUser ? "Edit User" : "Add New User"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Full Name *</Label>
                <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Username *</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Role *</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role) => (
                      <SelectItem key={role.role_code} value={role.role_code}>
                        {role.role_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Warehouse</Label>
                <Select
                  value={form.warehouse_id || "__none__"}
                  onValueChange={(v) => setForm({ ...form, warehouse_id: v === "__none__" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select warehouse (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {warehouseOptions.map((warehouse) => (
                      <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                        {warehouse.warehouse_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status *</Label>
                <Select
                  value={form.is_active ? "active" : "inactive"}
                  onValueChange={(v) => setForm({ ...form, is_active: v === "active" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{editUser ? "New Password (optional)" : "Password *"}</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={handleSave} className="flex-1 bg-blue-600" disabled={!editUser && !form.password.trim()}>
                  Save User
                </Button>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={isPortalDialogOpen} onOpenChange={setIsPortalDialogOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>
                Portal Access Mapping
                {portalUser ? ` - ${portalUser.full_name} (${portalUser.username})` : ""}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between gap-2">
                <Input
                  value={portalSearch}
                  onChange={(e) => setPortalSearch(e.target.value)}
                  placeholder="Search client name/code..."
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMappedClientIds(activePortalClients.map((c) => c.id))}
                  disabled={portalLoading || savePortalMappingsMutation.isPending}
                >
                  Select All
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMappedClientIds([])}
                  disabled={portalLoading || savePortalMappingsMutation.isPending}
                >
                  Clear
                </Button>
              </div>

              <div className="max-h-80 space-y-2 overflow-auto rounded-md border p-2">
                {portalLoading ? (
                  <p className="text-sm text-gray-500">Loading mappings...</p>
                ) : filteredPortalClients.length === 0 ? (
                  <p className="text-sm text-gray-500">No clients found.</p>
                ) : (
                  filteredPortalClients.map((client) => (
                    <label
                      key={client.id}
                      className={`flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 ${
                        client.is_active ? "hover:bg-gray-50" : "bg-gray-50 text-gray-400"
                      }`}
                    >
                      <span className="text-sm">
                        {client.client_name}{" "}
                        <span className="font-mono text-xs text-gray-500">({client.client_code})</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={mappedClientIds.includes(client.id)}
                        onChange={(e) => toggleClient(client.id, e.target.checked)}
                        disabled={!client.is_active || savePortalMappingsMutation.isPending}
                      />
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
                      <input
                        type="checkbox"
                        checked={portalPermissions.includes(feature.key)}
                        onChange={(e) => togglePermission(feature.key, e.target.checked)}
                        disabled={savePortalMappingsMutation.isPending}
                      />
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-xs text-gray-600">Selected clients: {mappedClientIds.length}</p>

              <div className="flex gap-3 pt-1">
                <Button
                  className="flex-1 bg-blue-600"
                  onClick={() => savePortalMappingsMutation.mutate()}
                  disabled={!portalUser || portalLoading || savePortalMappingsMutation.isPending}
                >
                  Save Portal Access
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setIsPortalDialogOpen(false)}
                  disabled={savePortalMappingsMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Users", value: users.length, color: "blue" },
          { label: "Active", value: users.filter((u) => u.is_active).length, color: "green" },
          { label: "Inactive", value: users.filter((u) => !u.is_active).length, color: "red" },
          {
            label: "Admins",
            value: users.filter((u) => ["SUPER_ADMIN", "ADMIN"].includes(u.role)).length,
            color: "purple",
          },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <p className="text-sm font-medium">{stat.label}</p>
              <p className="text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="relative mb-4 max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            <TypeaheadInput
              key={searchInputKey}
              className="pl-9"
              value={search}
              onValueChange={setSearch}
              suggestions={searchSuggestions}
              placeholder="Search users..."
            />
          </div>
          <div className="rounded-md border">
            <div className="max-h-[560px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-white">
                  <TableRow className="bg-gray-50">
                    <TableHead>User</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100">
                            <User className="h-4 w-4 text-blue-600" />
                          </div>
                          <div className="font-medium">{user.full_name}</div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{user.username}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Badge className={roleColors[user.role] || "bg-gray-100 text-gray-800"}>
                          <Shield className="mr-1 h-3 w-3" />
                          {user.role}
                        </Badge>
                      </TableCell>
                      <TableCell>{user.warehouse_name || "Unassigned"}</TableCell>
                      <TableCell>
                        <Badge className={user.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                          {user.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(user)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Portal Access"
                            onClick={() => void openPortalAccess(user)}
                          >
                            <Link2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Send Portal Invite"
                            onClick={() => createInviteMutation.mutate(user.id)}
                            disabled={createInviteMutation.isPending}
                          >
                            Invite
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600"
                            onClick={() => deleteMutation.mutate(user.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
