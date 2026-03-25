"use client"

import { useMemo, useState } from "react"
import { Building2, Edit, MapPin, Phone, Plus, Search, Trash2 } from "lucide-react"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

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

export function AdminClients() {
  const CLIENTS_PER_PAGE = 10
  const clientsQuery = useAdminResource("clients")
  const saveMutation = useSaveAdminResource("clients")
  const deleteMutation = useDeleteAdminResource("clients")

  const [search, setSearch] = useState("")
  const [currentPage, setCurrentPage] = useState(1)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [formData, setFormData] = useState({
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
  })

  const clients = (clientsQuery.data as Client[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () =>
      clients.flatMap((client) => [
        client.client_code,
        client.client_name,
        client.contact_person || "",
      ]),
    [clients]
  )
  const filteredClients = clients.filter(
    (client) =>
      client.client_name.toLowerCase().includes(search.toLowerCase()) ||
      client.client_code.toLowerCase().includes(search.toLowerCase()) ||
      (client.contact_person || "").toLowerCase().includes(search.toLowerCase())
  )
  const totalPages = Math.max(1, Math.ceil(filteredClients.length / CLIENTS_PER_PAGE))
  const effectiveCurrentPage = Math.min(currentPage, totalPages)
  const paginatedClients = filteredClients.slice(
    (effectiveCurrentPage - 1) * CLIENTS_PER_PAGE,
    effectiveCurrentPage * CLIENTS_PER_PAGE
  )

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
      setFormData({
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
      })
    }
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    const payload = selectedClient ? { id: selectedClient.id, ...formData } : formData
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  const formatMoney = (value?: number | string, currency?: string) => {
    const amount = Number(value ?? 0)
    return `${currency || "INR"} ${amount.toFixed(2)}`
  }

  const formatDate = (value?: string) => {
    if (!value) return "N/A"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "N/A"
    return date.toLocaleDateString()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Client Management</h1>
          <p className="mt-1 text-gray-500">Manage client accounts and contacts</p>
        </div>
        <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => handleOpenDialog()}>
          <Plus className="mr-2 h-4 w-4" />
          Add Client
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-100 p-3">
              <Building2 className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Clients</p>
              <p className="text-2xl font-bold">{clients.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-green-100 p-3">
              <Building2 className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Active</p>
              <p className="text-2xl font-bold">{clients.filter((c) => c.is_active).length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-orange-100 p-3">
              <Building2 className="h-6 w-6 text-orange-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Inactive</p>
              <p className="text-2xl font-bold">{clients.filter((c) => !c.is_active).length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <TypeaheadInput
          value={search}
          onValueChange={(value) => {
            setSearch(value)
            setCurrentPage(1)
          }}
          suggestions={searchSuggestions}
          className="max-w-md"
          placeholder="Search by client code/name/contact"
        />
        <Button variant="secondary">
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <div className="rounded-lg border bg-white p-4 shadow">
        <div className="space-y-3">
          {paginatedClients.map((client) => (
            <div
              key={client.id}
              className="rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:bg-gray-50"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="grid flex-1 gap-3 md:grid-cols-2">
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Client Details</p>
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-gray-700">{client.client_code}</span>
                        <Badge className={client.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}>
                          {client.is_active ? "ACTIVE" : "INACTIVE"}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-base font-semibold text-gray-900">{client.client_name}</p>
                        {client.gst_number ? <p className="text-xs text-gray-500">GST: {client.gst_number}</p> : null}
                      </div>
                      <div className="space-y-1 text-sm text-gray-600">
                        <p>{client.contact_person || "No contact person"}</p>
                        <p className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {client.contact_phone || "No phone"}
                        </p>
                        <p className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {client.city || "N/A"}, {client.state || "N/A"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Contract Details</p>
                    {client.contract_code ? (
                      <div className="mt-2 grid gap-1 text-sm text-gray-700">
                        <p>
                          <span className="font-medium">Contract:</span> {client.contract_code}
                        </p>
                        <p>
                          <span className="font-medium">Contract Dates:</span> {formatDate(client.effective_from)} to{" "}
                          {client.effective_to ? formatDate(client.effective_to) : "Open ended"}
                        </p>
                        <p>
                          <span className="font-medium">Contract Rates:</span>{" "}
                          Storage {formatMoney(client.storage_rate_per_unit, client.contract_currency)}, Handling{" "}
                          {formatMoney(client.handling_rate_per_unit, client.contract_currency)}, Minimum Guarantee{" "}
                          {formatMoney(client.minimum_guarantee_amount, client.contract_currency)}
                        </p>
                        <p>
                          <span className="font-medium">Billing Terms:</span> {client.billing_terms || "N/A"}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-gray-500">No active contract configured.</p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 md:self-start">
                  <Button variant="ghost" size="sm" onClick={() => handleOpenDialog(client)}>
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600"
                    onClick={() => deleteMutation.mutate(client.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}

          {filteredClients.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
              No clients found.
            </div>
          ) : null}
        </div>

        {filteredClients.length > 0 ? (
          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <p className="text-sm text-gray-600">
              Showing {(effectiveCurrentPage - 1) * CLIENTS_PER_PAGE + 1}-
              {Math.min(effectiveCurrentPage * CLIENTS_PER_PAGE, filteredClients.length)} of{" "}
              {filteredClients.length}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={effectiveCurrentPage === 1}
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-gray-600">
                Page {effectiveCurrentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={effectiveCurrentPage === totalPages}
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedClient ? "Edit Client" : "Add New Client"}</DialogTitle>
            <DialogDescription>
              {selectedClient ? "Update client information" : "Enter details for new client"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Client Code *</Label>
                <Input value={formData.client_code} onChange={(e) => setFormData({ ...formData, client_code: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Client Name *</Label>
                <Input value={formData.client_name} onChange={(e) => setFormData({ ...formData, client_name: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Contact Person</Label>
                <Input value={formData.contact_person} onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Contact Phone</Label>
                <Input value={formData.contact_phone} onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Email</Label>
              <Input value={formData.contact_email} onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })} />
            </div>

            <div className="space-y-2">
              <Label>Address</Label>
              <Textarea value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} rows={2} />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>City</Label>
                <Input value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>State</Label>
                <Input value={formData.state} onChange={(e) => setFormData({ ...formData, state: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Pincode</Label>
                <Input value={formData.pincode} onChange={(e) => setFormData({ ...formData, pincode: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>GST Number</Label>
                <Input value={formData.gst_number} onChange={(e) => setFormData({ ...formData, gst_number: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={formData.is_active ? "ACTIVE" : "INACTIVE"}
                  onValueChange={(value) => setFormData({ ...formData, is_active: value === "ACTIVE" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="INACTIVE">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700">
              {selectedClient ? "Update Client" : "Create Client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
