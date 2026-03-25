"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, Edit, Paperclip, Plus, Search, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { useAdminResource, useDeleteAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

type ClientRow = {
  id: number
  client_code: string
  client_name: string
}

type ContractRow = {
  id: number
  client_id: number
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

export default function ContractsPage() {
  const contractsQuery = useAdminResource("contracts")
  const clientsQuery = useAdminResource("clients")
  const saveMutation = useSaveAdminResource("contracts")
  const deleteMutation = useDeleteAdminResource("contracts")

  const [search, setSearch] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
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

  const contracts = useMemo(
    () => (contractsQuery.data as ContractRow[] | undefined) ?? [],
    [contractsQuery.data]
  )
  const clients = useMemo(
    () => (clientsQuery.data as ClientRow[] | undefined) ?? [],
    [clientsQuery.data]
  )

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return contracts
    return contracts.filter((row) =>
      `${row.contract_code} ${row.client_name}`.toLowerCase().includes(term)
    )
  }, [contracts, search])
  const searchSuggestions = useMemo(
    () => contracts.flatMap((row) => [row.contract_code, row.client_name]),
    [contracts]
  )

  const contractRefNo = editRow?.contract_code || ""

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
      const res = await fetch(
        `/api/attachments?referenceType=CONTRACT&referenceNo=${encodeURIComponent(referenceNo)}`,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        }
      )
      const body = (await res.json()) as { success?: boolean; data?: AttachmentRow[]; error?: { message?: string } }
      if (!res.ok || body.success === false) {
        throw new Error(body.error?.message || "Failed to load attachments")
      }
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
        headers: {
          "x-idempotency-key": crypto.randomUUID(),
        },
      })
      const body = (await res.json()) as { success?: boolean; error?: { message?: string } }
      if (!res.ok || body.success === false) {
        throw new Error(body.error?.message || "Upload failed")
      }

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

  const openCreate = () => {
    setEditRow(null)
    setAttachments([])
    setAttachmentFile(null)
    setAttachmentRemarks("")
    setAttachmentType("CONTRACT_AGREEMENT")
    setAttachmentInputKey((v) => v + 1)
    setForm({
      client_id: clients[0]?.id ? String(clients[0].id) : "",
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

  const openEdit = (row: ContractRow) => {
    setEditRow(row)
    setAttachmentFile(null)
    setAttachmentRemarks("")
    setAttachmentType("CONTRACT_AGREEMENT")
    setAttachmentInputKey((v) => v + 1)
    setForm({
      client_id: String(row.client_id),
      contract_code: row.contract_code,
      effective_from: String(row.effective_from || "").slice(0, 10),
      effective_to: row.effective_to ? String(row.effective_to).slice(0, 10) : "",
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
    if (!form.client_id || !form.contract_code || !form.effective_from) return

    const payload = {
      client_id: Number(form.client_id),
      contract_code: form.contract_code,
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

    if (editRow) {
      await saveMutation.mutateAsync({ id: editRow.id, ...payload })
    } else {
      await saveMutation.mutateAsync(payload)
    }

    setIsDialogOpen(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Contract Management</h1>
          <p className="mt-1 text-gray-500">Storage rate, handling rate and minimum guarantee control</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add Contract
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{editRow ? "Edit Contract" : "Create Contract"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 pt-2 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label>Client *</Label>
                <Select value={form.client_id} onValueChange={(v) => setForm({ ...form, client_id: v })}>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue className="block max-w-full truncate" placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((client) => (
                      <SelectItem key={client.id} value={String(client.id)}>
                        {client.client_code} - {client.client_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label>Contract Code *</Label>
                <Input
                  value={form.contract_code}
                  onChange={(e) => setForm({ ...form, contract_code: e.target.value.toUpperCase() })}
                />
              </div>
              <div className="space-y-2">
                <Label>Effective From *</Label>
                <Input
                  type="date"
                  value={form.effective_from}
                  onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Effective To</Label>
                <Input
                  type="date"
                  value={form.effective_to}
                  onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Storage Rate</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.storage_rate_per_unit}
                  onChange={(e) => setForm({ ...form, storage_rate_per_unit: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Handling Rate</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.handling_rate_per_unit}
                  onChange={(e) => setForm({ ...form, handling_rate_per_unit: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Minimum Guarantee</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.minimum_guarantee_amount}
                  onChange={(e) => setForm({ ...form, minimum_guarantee_amount: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Billing Cycle</Label>
                <Select
                  value={form.billing_cycle}
                  onValueChange={(v) => setForm({ ...form, billing_cycle: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MONTHLY">MONTHLY</SelectItem>
                    <SelectItem value="QUARTERLY">QUARTERLY</SelectItem>
                    <SelectItem value="YEARLY">YEARLY</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Notes</Label>
                <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="space-y-3 rounded-md border p-3 md:col-span-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Paperclip className="h-4 w-4" />
                  Contract Documents
                </div>
                {!editRow ? (
                  <p className="text-sm text-gray-500">
                    Save the contract first, then you can upload agreement and GST documents.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-2 md:grid-cols-4">
                      <div className="space-y-1">
                        <Label>Document Type</Label>
                        <Select value={attachmentType} onValueChange={setAttachmentType}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CONTRACT_AGREEMENT">Contract Agreement</SelectItem>
                            <SelectItem value="GST_DOCUMENT">GST Document</SelectItem>
                            <SelectItem value="OTHER_DOCUMENT">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <Label>File</Label>
                        <Input
                          key={attachmentInputKey}
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
                          onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          className="w-full"
                          variant="secondary"
                          onClick={handleUploadAttachment}
                          disabled={attachmentUploading || !attachmentFile}
                        >
                          <Upload className="h-4 w-4" />
                          {attachmentUploading ? "Uploading..." : "Upload"}
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label>Remarks</Label>
                      <Input
                        value={attachmentRemarks}
                        onChange={(e) => setAttachmentRemarks(e.target.value)}
                        placeholder="Optional notes for this document"
                      />
                    </div>
                    <div className="max-h-40 overflow-auto rounded border">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-left">
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
                            <tr>
                              <td className="px-2 py-2 text-gray-500" colSpan={5}>
                                Loading documents...
                              </td>
                            </tr>
                          ) : attachments.length === 0 ? (
                            <tr>
                              <td className="px-2 py-2 text-gray-500" colSpan={5}>
                                No documents attached yet.
                              </td>
                            </tr>
                          ) : (
                            attachments.map((file) => (
                              <tr key={file.id} className="border-t">
                                <td className="px-2 py-1">{file.attachment_type}</td>
                                <td className="px-2 py-1">{file.file_name}</td>
                                <td className="px-2 py-1">{formatFileSize(file.file_size_bytes)}</td>
                                <td className="px-2 py-1">{new Date(file.created_at).toLocaleDateString()}</td>
                                <td className="px-2 py-1 text-right">
                                  <Button asChild size="sm" variant="outline">
                                    <a href={`/api/attachments/${file.id}`}>
                                      <Download className="h-4 w-4" />
                                      Download
                                    </a>
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
            <div className="mt-4 flex gap-3">
              <Button className="flex-1 bg-blue-600" onClick={handleSave}>
                Save Contract
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contracts</CardTitle>
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            <TypeaheadInput
              className="pl-9"
              value={search}
              onValueChange={setSearch}
              suggestions={searchSuggestions}
              placeholder="Search contract/client..."
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Contract</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Storage Rate</TableHead>
                <TableHead>Handling Rate</TableHead>
                <TableHead>Minimum Guarantee</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">{row.contract_code}</TableCell>
                  <TableCell>{row.client_name}</TableCell>
                  <TableCell>{Number(row.storage_rate_per_unit || 0).toFixed(2)}</TableCell>
                  <TableCell>{Number(row.handling_rate_per_unit || 0).toFixed(2)}</TableCell>
                  <TableCell>{Number(row.minimum_guarantee_amount || 0).toFixed(2)}</TableCell>
                  <TableCell>{row.billing_cycle}</TableCell>
                  <TableCell>
                    <Badge className={row.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {row.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
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
