"use client"

import { useMemo, useState } from "react"
import { Building2, Edit, Plus, Search, Trash2, UserPlus } from "lucide-react"

import { useAuth } from "@/hooks/use-auth"
import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
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

type CompanyRow = {
  id: number
  company_code: string
  company_name: string
  domain?: string
  storage_bucket?: string
  subscription_plan?: "BASIC" | "PRO" | "ENTERPRISE"
  storage_used_gb?: number
  billing_status?: "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED"
  is_active: boolean
  users_count?: number
  active_users?: number
}

export default function CompaniesPage() {
  const { user, isLoading } = useAuth()
  const canManageCompanies =
    user?.permissions?.includes("admin.companies.manage") || user?.role === "SUPER_ADMIN"
  const companiesQuery = useAdminResource("companies")
  const saveMutation = useSaveAdminResource("companies")
  const deleteMutation = useDeleteAdminResource("companies")

  const [search, setSearch] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<CompanyRow | null>(null)
  const [form, setForm] = useState({
    company_code: "",
    company_name: "",
    domain: "",
    storage_bucket: "",
    subscription_plan: "BASIC",
    storage_used_gb: "0",
    billing_status: "TRIAL",
    admin_username: "",
    admin_email: "",
    admin_full_name: "",
    admin_password: "",
    is_active: true,
  })

  const companies = (companiesQuery.data as CompanyRow[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () => companies.flatMap((company) => [company.company_code, company.company_name, company.domain || ""]),
    [companies]
  )
  const filtered = companies.filter((c) =>
    `${c.company_code} ${c.company_name}`.toLowerCase().includes(search.toLowerCase())
  )

  const openCreate = () => {
    setEditRow(null)
    setForm({
      company_code: "",
      company_name: "",
      domain: "",
      storage_bucket: "",
      subscription_plan: "BASIC",
      storage_used_gb: "0",
      billing_status: "TRIAL",
      admin_username: "",
      admin_email: "",
      admin_full_name: "",
      admin_password: "",
      is_active: true,
    })
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
    })
    setIsDialogOpen(true)
  }

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
        admin_username: form.admin_username,
        admin_email: form.admin_email,
        admin_full_name: form.admin_full_name,
        admin_password: form.admin_password,
      })
    }

    setIsDialogOpen(false)
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Company Management</h1>
          <p className="mt-1 text-gray-500">Create and manage SaaS tenant companies</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add Company
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editRow ? "Edit Company" : "Create Company + First Admin"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
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

              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Subscription Plan</Label>
                  <Select
                    value={form.subscription_plan}
                    onValueChange={(v) =>
                      setForm({ ...form, subscription_plan: v as "BASIC" | "PRO" | "ENTERPRISE" })
                    }
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
                    onValueChange={(v) =>
                      setForm({
                        ...form,
                        billing_status: v as "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED",
                      })
                    }
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
                    onValueChange={(v) =>
                      setForm({
                        ...form,
                        is_active: v === "ACTIVE",
                      })
                    }
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

              <div className="grid grid-cols-2 gap-4">
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

              {!editRow && (
                <div className="rounded-md border p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <UserPlus className="h-4 w-4" />
                    First Admin User
                  </div>
                  <div className="grid grid-cols-2 gap-4">
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
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4">
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

              <div className="flex gap-3 pt-2">
                <Button className="flex-1 bg-blue-600" onClick={handleSave}>
                  Save
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500">Total Companies</p>
            <p className="text-2xl font-bold">{companies.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500">Active Companies</p>
            <p className="text-2xl font-bold">{companies.filter((c) => c.is_active).length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500">Total Tenant Users</p>
            <p className="text-2xl font-bold">
              {companies.reduce((sum, c) => sum + Number(c.users_count || 0), 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="relative mb-4 max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            <TypeaheadInput
              className="pl-9"
              value={search}
              onValueChange={setSearch}
              suggestions={searchSuggestions}
              placeholder="Search companies..."
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Company</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Active Users</TableHead>
                <TableHead>Storage Used</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead>Users</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
                        <Building2 className="h-4 w-4 text-emerald-700" />
                      </div>
                      <div>
                        <p className="font-medium">{row.company_name}</p>
                        <p className="text-xs font-mono text-gray-500">{row.company_code}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className="bg-blue-100 text-blue-800">{row.subscription_plan || "BASIC"}</Badge>
                  </TableCell>
                  <TableCell>{row.active_users ?? 0}</TableCell>
                  <TableCell>{Number(row.storage_used_gb || 0).toFixed(2)} GB</TableCell>
                  <TableCell>
                    <Badge
                      className={
                        row.billing_status === "ACTIVE"
                          ? "bg-green-100 text-green-800"
                          : row.billing_status === "PAST_DUE"
                            ? "bg-orange-100 text-orange-800"
                            : row.billing_status === "SUSPENDED"
                              ? "bg-red-100 text-red-800"
                              : "bg-gray-100 text-gray-800"
                      }
                    >
                      {row.billing_status || "TRIAL"}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.domain || "-"}</TableCell>
                  <TableCell className="font-mono text-sm">{row.storage_bucket || "-"}</TableCell>
                  <TableCell>{row.users_count ?? 0}</TableCell>
                  <TableCell>
                    <Badge className={row.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {row.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        onClick={() => deleteMutation.mutate(row.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
