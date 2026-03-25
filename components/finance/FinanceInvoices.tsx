"use client"

import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Download,
  Eye,
  FileText,
  Loader2,
  Plus,
  Search,
  Send,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { exportInvoicePDF } from "@/lib/export-utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Invoice = {
  id: number
  invoice_number: string
  created_at?: string
  created_by_name?: string | null
  client_name: string
  client_id: number
  client_gstin?: string | null
  place_of_supply?: string | null
  supply_type?: "INTRA_STATE" | "INTER_STATE"
  supplier_name?: string | null
  supplier_gstin?: string | null
  supplier_pan?: string | null
  supplier_address?: string | null
  supplier_state?: string | null
  supplier_state_code?: string | null
  billing_period: string
  invoice_date: string
  due_date: string
  taxable_amount?: number
  gst_rate?: number
  cgst_amount?: number
  sgst_amount?: number
  igst_amount?: number
  total_tax_amount?: number
  grand_total?: number
  total_amount: number
  paid_amount: number
  balance: number
  status: "DRAFT" | "FINALIZED" | "SENT" | "PAID" | "OVERDUE" | "VOID"
  items: {
    invoice_line_id?: number
    description: string
    quantity: number
    rate: number
    amount: number
  }[]
  payments?: Array<{
    id: number
    payment_date: string
    amount: number
    payment_mode?: string | null
    reference_no?: string | null
    notes?: string | null
  }>
}

type InvoicePayload = {
  invoices: Invoice[]
  summary: {
    totalRevenue: number
    totalPaid: number
    totalOutstanding: number
    totalTax: number
    totalInvoiceValue: number
    overdueCount: number
  }
  trailBalance: {
    rows: Array<{
      client_id: number
      client_name: string
      opening_debit: number
      opening_credit: number
      period_debit: number
      period_credit: number
      closing_debit: number
      closing_credit: number
    }>
    totals: {
      opening_debit: number
      opening_credit: number
      period_debit: number
      period_credit: number
      closing_debit: number
      closing_credit: number
    }
  }
}

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type NoteHeader = {
  id: number
  note_number: string
  note_date: string
  reason: string
  grand_total: number
  status: string
}

type NoteDraftLine = {
  key: string
  invoice_line_id?: number
  description: string
  max_quantity: number
  quantity: string
  rate: string
  tax_rate: string
  selected: boolean
  is_custom?: boolean
}

export function FinanceInvoices() {
  const today = new Date()
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  const fyStart = `${fyStartYear}-04-01`
  const todayIso = today.toISOString().slice(0, 10)

  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null)
  const [tbFromInput, setTbFromInput] = useState(fyStart)
  const [tbToInput, setTbToInput] = useState(todayIso)
  const [tbFrom, setTbFrom] = useState(fyStart)
  const [tbTo, setTbTo] = useState(todayIso)
  const [isJournalOpen, setIsJournalOpen] = useState(false)
  const [journalDate, setJournalDate] = useState(todayIso)
  const [journalDescription, setJournalDescription] = useState("")
  const [journalLines, setJournalLines] = useState<Array<{ account_code: string; debit: string; credit: string; narration: string }>>([
    { account_code: "", debit: "", credit: "", narration: "" },
    { account_code: "", debit: "", credit: "", narration: "" },
  ])
  const [paymentInvoice, setPaymentInvoice] = useState<Invoice | null>(null)
  const [paymentDate, setPaymentDate] = useState(todayIso)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMode, setPaymentMode] = useState("BANK_TRANSFER")
  const [paymentRef, setPaymentRef] = useState("")
  const [paymentNotes, setPaymentNotes] = useState("")
  const [noteType, setNoteType] = useState<"CREDIT" | "DEBIT" | null>(null)
  const [noteDate, setNoteDate] = useState(todayIso)
  const [noteReason, setNoteReason] = useState("")
  const [noteLines, setNoteLines] = useState<NoteDraftLine[]>([])

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const invoicesQuery = useQuery({
    queryKey: ["finance", "invoices", { search, statusFilter, warehouseFilter }],
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (search) qp.set("search", search)
      if (statusFilter && statusFilter !== "all") qp.set("status", statusFilter)
      if (warehouseFilter !== "all") qp.set("warehouse_id", warehouseFilter)
      const res = await apiClient.get<InvoicePayload>(`/finance/invoices${qp.toString() ? `?${qp.toString()}` : ""}`)
      return res.data
    },
  })

  const sendEmailMutation = useMutation({
    mutationFn: async (invoice: Invoice) =>
      apiClient.post("/invoices/send-email", {
        invoice_number: invoice.invoice_number,
        client_name: invoice.client_name,
        invoice_date: invoice.invoice_date,
        due_date: invoice.due_date,
        total_amount: invoice.total_amount,
        paid_amount: invoice.paid_amount,
        balance: invoice.balance,
        status: invoice.status,
      }),
    onSuccess: (_, invoice) => {
      toast.success(`Invoice ${invoice.invoice_number} email queued successfully.`)
    },
    onError: (error) => handleError(error, "Failed to queue invoice email"),
  })

  const generateInvoiceMutation = useMutation({
    mutationFn: async () => apiClient.post<{ generated_count: number }>("/finance/invoices"),
    onSuccess: (res) => {
      toast.success(`Invoices generated: ${res.data?.generated_count ?? 0}`)
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to generate invoices"),
  })

  const trialBalanceQuery = useQuery({
    queryKey: ["finance", "trial-balance", tbFrom, tbTo, warehouseFilter],
    queryFn: async () => {
      const qp = new URLSearchParams({ date_from: tbFrom, date_to: tbTo })
      if (warehouseFilter !== "all") qp.set("warehouse_id", warehouseFilter)
      const res = await apiClient.get<{
        date_from: string
        date_to: string
        rows: Array<{
          account_code: string
          account_name: string
          account_type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE"
          opening_debit: number
          opening_credit: number
          period_debit: number
          period_credit: number
          closing_debit: number
          closing_credit: number
        }>
        totals: {
          opening_debit: number
          opening_credit: number
          period_debit: number
          period_credit: number
          closing_debit: number
          closing_credit: number
        }
        is_balanced: boolean
      }>(`/finance/trial-balance?${qp.toString()}`)
      return res.data
    },
  })

  const journalsQuery = useQuery({
    queryKey: ["finance", "journals", warehouseFilter],
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (warehouseFilter !== "all") qp.set("warehouse_id", warehouseFilter)
      const res = await apiClient.get<{
        accounts: Array<{ account_code: string; account_name: string; account_type: string }>
        journals: Array<{
          id: number
          entry_date: string
          entry_type: string
          external_ref: string
          description: string
          created_at?: string
          updated_at?: string
          modified_by_name?: string
          total_debit: number
          total_credit: number
        }>
      }>(`/finance/journals${qp.toString() ? `?${qp.toString()}` : ""}`)
      return res.data
    },
  })

  const creditNotesQuery = useQuery({
    queryKey: ["finance", "credit-notes", viewInvoice?.id],
    enabled: Boolean(viewInvoice?.id),
    queryFn: async () => {
      if (!viewInvoice?.id) return []
      const res = await apiClient.get<NoteHeader[]>(`/finance/credit-notes?invoice_id=${viewInvoice.id}`)
      return res.data ?? []
    },
  })

  const debitNotesQuery = useQuery({
    queryKey: ["finance", "debit-notes", viewInvoice?.id],
    enabled: Boolean(viewInvoice?.id),
    queryFn: async () => {
      if (!viewInvoice?.id) return []
      const res = await apiClient.get<NoteHeader[]>(`/finance/debit-notes?invoice_id=${viewInvoice.id}`)
      return res.data ?? []
    },
  })

  const postJournalMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        entry_date: journalDate,
        description: journalDescription,
        lines: journalLines.map((line) => ({
          account_code: line.account_code,
          debit: line.debit ? Number(line.debit) : 0,
          credit: line.credit ? Number(line.credit) : 0,
          narration: line.narration || undefined,
        })),
      }
      return apiClient.post("/finance/journals", payload)
    },
    onSuccess: () => {
      toast.success("Journal voucher posted")
      setJournalDescription("")
      setJournalLines([
        { account_code: "", debit: "", credit: "", narration: "" },
        { account_code: "", debit: "", credit: "", narration: "" },
      ])
      setIsJournalOpen(false)
      journalsQuery.refetch()
      trialBalanceQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to post journal voucher"),
  })

  const recordPaymentMutation = useMutation({
    mutationFn: async () => {
      if (!paymentInvoice) throw new Error("No invoice selected")
      return apiClient.post(`/finance/invoices/${paymentInvoice.id}/payments`, {
        payment_date: paymentDate,
        amount: Number(paymentAmount),
        payment_mode: paymentMode,
        reference_no: paymentRef || undefined,
        notes: paymentNotes || undefined,
      })
    },
    onSuccess: () => {
      toast.success("Payment recorded")
      setPaymentInvoice(null)
      setPaymentAmount("")
      setPaymentRef("")
      setPaymentNotes("")
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to record payment"),
  })

  const finalizeInvoiceMutation = useMutation({
    mutationFn: async (invoiceId: number) => apiClient.post(`/finance/invoices/${invoiceId}/finalize`),
    onSuccess: () => {
      toast.success("Invoice finalized")
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to finalize invoice"),
  })

  const createCreditNoteMutation = useMutation({
    mutationFn: async () => {
      if (!viewInvoice) throw new Error("No invoice selected")
      const lines = noteLines
        .filter((line) => line.selected)
        .map((line) => ({
          ...(line.invoice_line_id ? { invoice_line_id: line.invoice_line_id } : {}),
          description: line.description,
          quantity: Number(line.quantity),
          rate: Number(line.rate),
          tax_rate: Number(line.tax_rate || "18"),
        }))
      return apiClient.post("/finance/credit-notes", {
        invoice_id: viewInvoice.id,
        note_date: noteDate,
        reason: noteReason,
        lines,
      })
    },
    onSuccess: () => {
      toast.success("Credit note issued")
      setNoteType(null)
      setNoteReason("")
      setNoteLines([])
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
      creditNotesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to issue credit note"),
  })

  const createDebitNoteMutation = useMutation({
    mutationFn: async () => {
      if (!viewInvoice) throw new Error("No invoice selected")
      const lines = noteLines
        .filter((line) => line.selected)
        .map((line) => ({
          ...(line.invoice_line_id ? { invoice_line_id: line.invoice_line_id } : {}),
          description: line.description,
          quantity: Number(line.quantity),
          rate: Number(line.rate),
          tax_rate: Number(line.tax_rate || "18"),
        }))
      return apiClient.post("/finance/debit-notes", {
        invoice_id: viewInvoice.id,
        note_date: noteDate,
        reason: noteReason,
        lines,
      })
    },
    onSuccess: () => {
      toast.success("Debit note issued")
      setNoteType(null)
      setNoteReason("")
      setNoteLines([])
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
      debitNotesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to issue debit note"),
  })

  const payload = invoicesQuery.data
  const invoices = payload?.invoices ?? []
  const searchSuggestions = useMemo(
    () => invoices.flatMap((invoice) => [invoice.invoice_number, invoice.client_name]),
    [invoices]
  )
  const summary = payload?.summary ?? {
    totalRevenue: 0,
    totalPaid: 0,
    totalOutstanding: 0,
    totalTax: 0,
    totalInvoiceValue: 0,
    overdueCount: 0,
  }
  const handleDownloadPDF = (invoice: Invoice) => {
    try {
      exportInvoicePDF(invoice)
    } catch (error) {
      handleError(error, "Failed to export invoice PDF")
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "PAID":
        return <CheckCircle2 className="h-4 w-4" />
      case "SENT":
        return <Send className="h-4 w-4" />
      case "OVERDUE":
        return <AlertCircle className="h-4 w-4" />
      case "DRAFT":
        return <FileText className="h-4 w-4" />
      default:
        return <Clock className="h-4 w-4" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, string> = {
      PAID: "bg-green-100 text-green-800",
      SENT: "bg-blue-100 text-blue-800",
      FINALIZED: "bg-indigo-100 text-indigo-800",
      OVERDUE: "bg-red-100 text-red-800",
      DRAFT: "bg-gray-100 text-gray-800",
      VOID: "bg-gray-100 text-gray-600",
    }

    return (
      <Badge className={variants[status] || "bg-gray-100 text-gray-800"}>
        <span className="flex items-center gap-1">
          {getStatusIcon(status)}
          {status}
        </span>
      </Badge>
    )
  }
  const formatDateTime = (value?: string) => {
    if (!value) return "-"
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  }

  const money = (value: number) => `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

  const initializeNoteLines = (invoice: Invoice) => {
    const mapped = (invoice.items ?? []).map((item, idx) => ({
      key: `inv-${invoice.id}-${item.invoice_line_id ?? idx}`,
      invoice_line_id: item.invoice_line_id,
      description: item.description,
      max_quantity: Number(item.quantity || 0),
      quantity: String(item.quantity || 0),
      rate: String(item.rate || 0),
      tax_rate: "18",
      selected: true,
      is_custom: false,
    }))
    setNoteLines(mapped)
  }

  const openNoteForm = (type: "CREDIT" | "DEBIT") => {
    if (!viewInvoice) return
    setNoteType(type)
    setNoteDate(todayIso)
    setNoteReason("")
    initializeNoteLines(viewInvoice)
  }

  const addCustomNoteLine = () => {
    setNoteLines((prev) => [
      ...prev,
      {
        key: `custom-${Date.now()}-${prev.length + 1}`,
        description: "",
        max_quantity: 0,
        quantity: "1",
        rate: "0",
        tax_rate: "18",
        selected: true,
        is_custom: true,
      },
    ])
  }

  useEffect(() => {
    if (!viewInvoice || !noteType) return
    initializeNoteLines(viewInvoice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewInvoice?.id, noteType])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Invoices</h1>
          <p className="mt-1 text-gray-500">Generate and track client invoices</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setIsJournalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Post Journal Voucher
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => generateInvoiceMutation.mutate()}
            disabled={generateInvoiceMutation.isPending}
          >
            <FileText className="mr-2 h-4 w-4" />
            {generateInvoiceMutation.isPending ? "Generating..." : "Generate Invoice"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-100 p-3">
              <DollarSign className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Revenue</p>
              <p className="text-2xl font-bold">{`Rs ${(summary.totalRevenue / 1000).toFixed(0)}k`}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-green-100 p-3">
              <CheckCircle2 className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Paid</p>
              <p className="text-2xl font-bold">{`Rs ${(summary.totalPaid / 1000).toFixed(0)}k`}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-orange-100 p-3">
              <Clock className="h-6 w-6 text-orange-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Outstanding</p>
              <p className="text-2xl font-bold">{`Rs ${(summary.totalOutstanding / 1000).toFixed(0)}k`}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-red-100 p-3">
              <AlertCircle className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Overdue</p>
              <p className="text-2xl font-bold">{summary.overdueCount}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-violet-100 p-3">
              <FileText className="h-6 w-6 text-violet-700" />
            </div>
            <div>
              <p className="text-sm text-gray-600">GST Tax</p>
              <p className="text-2xl font-bold">{`₹ ${(summary.totalTax / 1000).toFixed(0)}k`}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-100 p-3">
              <DollarSign className="h-6 w-6 text-indigo-700" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Invoice Value</p>
              <p className="text-2xl font-bold">{`₹ ${(summary.totalInvoiceValue / 1000).toFixed(0)}k`}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex max-w-md flex-1 gap-2">
          <TypeaheadInput
            value={searchInput}
            onValueChange={setSearchInput}
            suggestions={searchSuggestions}
            placeholder="Search invoice or client"
          />
          <Button variant="secondary" onClick={() => setSearch(searchInput.trim())}>
            <Search className="h-4 w-4" />
          </Button>
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="SENT">Sent</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
            <SelectItem value="OVERDUE">Overdue</SelectItem>
            <SelectItem value="VOID">Void</SelectItem>
          </SelectContent>
        </Select>

        <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="All Warehouses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {(warehousesQuery.data ?? []).map((warehouse) => (
              <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                {warehouse.warehouse_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-white shadow">
        {invoicesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="m-4 rounded-md border">
            <div className="max-h-[560px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-white">
                  <TableRow className="bg-gray-50">
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Invoice Date</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead>Created On</TableHead>
                    <TableHead>Created By</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">GST</TableHead>
                    <TableHead className="text-right">Invoice Value</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id} className="hover:bg-gray-50">
                      <TableCell className="font-mono font-medium">{invoice.invoice_number}</TableCell>
                      <TableCell>{invoice.client_name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-gray-400" />
                          {invoice.billing_period}
                        </div>
                      </TableCell>
                      <TableCell>{invoice.invoice_date}</TableCell>
                      <TableCell>
                        <span className={invoice.status === "OVERDUE" ? "font-medium text-red-600" : ""}>
                          {invoice.due_date}
                        </span>
                      </TableCell>
                      <TableCell>{formatDateTime(invoice.created_at)}</TableCell>
                      <TableCell>{invoice.created_by_name || "-"}</TableCell>
                      <TableCell className="text-right font-medium">{money(Number(invoice.taxable_amount ?? invoice.total_amount))}</TableCell>
                      <TableCell className="text-right text-violet-700">{money(Number(invoice.total_tax_amount ?? 0))}</TableCell>
                      <TableCell className="text-right font-semibold text-indigo-700">{money(Number(invoice.grand_total ?? invoice.total_amount))}</TableCell>
                      <TableCell className="text-right text-green-600">{money(Number(invoice.paid_amount))}</TableCell>
                      <TableCell className="text-right">
                        <span className={Number(invoice.balance) > 0 ? "font-medium text-orange-600" : "text-gray-400"}>
                          {money(Number(invoice.balance))}
                        </span>
                      </TableCell>
                      <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" title="View" onClick={() => setViewInvoice(invoice)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Download PDF" onClick={() => handleDownloadPDF(invoice)}>
                            <Download className="h-4 w-4" />
                          </Button>
                          {Number(invoice.balance) > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-emerald-700"
                              title="Record Payment"
                              onClick={() => {
                                setPaymentInvoice(invoice)
                                setPaymentAmount(String(Number(invoice.balance)))
                                setPaymentDate(new Date().toISOString().slice(0, 10))
                                setPaymentMode("BANK_TRANSFER")
                                setPaymentRef("")
                                setPaymentNotes("")
                              }}
                            >
                              Pay
                            </Button>
                          )}
                          {invoice.status !== "PAID" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-blue-600"
                              title="Send Email"
                              disabled={sendEmailMutation.isPending}
                              onClick={() => sendEmailMutation.mutate(invoice)}
                            >
                              <Send className="h-4 w-4" />
                            </Button>
                          )}
                          {invoice.status === "DRAFT" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-indigo-700"
                              title="Finalize"
                              disabled={finalizeInvoiceMutation.isPending}
                              onClick={() => finalizeInvoiceMutation.mutate(invoice.id)}
                            >
                              Finalize
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-white shadow">
        <div className="border-b bg-gray-50 px-4 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Full Trial Balance</h2>
              <p className="text-xs text-gray-600">Account-wise debit/credit summary from invoice, GRN, DO, and manual journal postings</p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <p className="mb-1 text-xs text-gray-500">From</p>
                <Input type="date" value={tbFromInput} onChange={(e) => setTbFromInput(e.target.value)} className="h-8 w-[145px]" />
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-500">To</p>
                <Input type="date" value={tbToInput} onChange={(e) => setTbToInput(e.target.value)} className="h-8 w-[145px]" />
              </div>
              <Button
                size="sm"
                className="bg-blue-600"
                onClick={() => {
                  if (!tbFromInput || !tbToInput || tbFromInput > tbToInput) {
                    toast.error("Select a valid trial balance date range")
                    return
                  }
                  setTbFrom(tbFromInput)
                  setTbTo(tbToInput)
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
        {trialBalanceQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="border-b px-4 py-2 text-xs">
              <Badge className={trialBalanceQuery.data?.is_balanced ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                {trialBalanceQuery.data?.is_balanced ? "Balanced" : "Not Balanced"}
              </Badge>
              <span className="ml-2 text-gray-500">
                Period: {trialBalanceQuery.data?.date_from} to {trialBalanceQuery.data?.date_to}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Opening Dr</TableHead>
                  <TableHead className="text-right">Opening Cr</TableHead>
                  <TableHead className="text-right">Period Dr</TableHead>
                  <TableHead className="text-right">Period Cr</TableHead>
                  <TableHead className="text-right">Closing Dr</TableHead>
                  <TableHead className="text-right">Closing Cr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(trialBalanceQuery.data?.rows ?? []).map((row) => (
                  <TableRow key={row.account_code}>
                    <TableCell className="font-mono text-xs">{row.account_code}</TableCell>
                    <TableCell className="font-medium">{row.account_name}</TableCell>
                    <TableCell>{row.account_type}</TableCell>
                    <TableCell className="text-right">{money(row.opening_debit)}</TableCell>
                    <TableCell className="text-right">{money(row.opening_credit)}</TableCell>
                    <TableCell className="text-right">{money(row.period_debit)}</TableCell>
                    <TableCell className="text-right">{money(row.period_credit)}</TableCell>
                    <TableCell className="text-right font-semibold text-orange-700">{money(row.closing_debit)}</TableCell>
                    <TableCell className="text-right font-semibold text-emerald-700">{money(row.closing_credit)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-gray-50">
                  <TableCell colSpan={3} className="font-semibold">Total</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.opening_debit ?? 0))}</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.opening_credit ?? 0))}</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.period_debit ?? 0))}</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.period_credit ?? 0))}</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.closing_debit ?? 0))}</TableCell>
                  <TableCell className="text-right font-semibold">{money(Number(trialBalanceQuery.data?.totals.closing_credit ?? 0))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>
        )}
      </div>

      <div className="rounded-lg border bg-white shadow">
        <div className="border-b bg-gray-50 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900">Recent Journal Vouchers</h2>
        </div>
        {journalsQuery.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="m-4 rounded-md border">
            <div className="max-h-[460px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-white">
                  <TableRow>
                    <TableHead>Date & Time</TableHead>
                    <TableHead>Modified User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(journalsQuery.data?.journals ?? []).map((jv) => (
                    <TableRow key={jv.id}>
                      <TableCell>{formatDateTime(jv.created_at || jv.updated_at)}</TableCell>
                      <TableCell>{jv.modified_by_name || "System"}</TableCell>
                      <TableCell>{jv.entry_type}</TableCell>
                      <TableCell className="font-mono text-xs">{jv.external_ref}</TableCell>
                      <TableCell>{jv.description}</TableCell>
                      <TableCell className="text-right">{money(Number(jv.total_debit))}</TableCell>
                      <TableCell className="text-right">{money(Number(jv.total_credit))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      <Dialog open={isJournalOpen} onOpenChange={setIsJournalOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Post Manual Journal Voucher</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-xs text-gray-500">Entry Date</p>
                <Input type="date" value={journalDate} onChange={(e) => setJournalDate(e.target.value)} />
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-500">Description</p>
                <Input value={journalDescription} onChange={(e) => setJournalDescription(e.target.value)} placeholder="Journal narration" />
              </div>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead>Narration</TableHead>
                    <TableHead className="w-[60px] text-right">#</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journalLines.map((line, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Select
                          value={line.account_code || undefined}
                          onValueChange={(value) =>
                            setJournalLines((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, account_code: value } : x))
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                          <SelectContent>
                            {(journalsQuery.data?.accounts ?? []).map((acc) => (
                              <SelectItem key={acc.account_code} value={acc.account_code}>
                                {acc.account_code} - {acc.account_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.debit}
                          onChange={(e) =>
                            setJournalLines((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, debit: e.target.value } : x))
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.credit}
                          onChange={(e) =>
                            setJournalLines((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, credit: e.target.value } : x))
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={line.narration}
                          onChange={(e) =>
                            setJournalLines((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, narration: e.target.value } : x))
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setJournalLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)))
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setJournalLines((prev) => [...prev, { account_code: "", debit: "", credit: "", narration: "" }])
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Line
              </Button>
              <Button
                className="bg-blue-600"
                disabled={postJournalMutation.isPending}
                onClick={() => {
                  if (!journalDescription.trim()) {
                    toast.error("Journal description is required")
                    return
                  }
                  const totalDebit = journalLines.reduce((sum, line) => sum + Number(line.debit || 0), 0)
                  const totalCredit = journalLines.reduce((sum, line) => sum + Number(line.credit || 0), 0)
                  if (Math.abs(totalDebit - totalCredit) > 0.01) {
                    toast.error("Debit and credit totals must match")
                    return
                  }
                  if (journalLines.some((line) => !line.account_code)) {
                    toast.error("Select account for all journal lines")
                    return
                  }
                  postJournalMutation.mutate()
                }}
              >
                {postJournalMutation.isPending ? "Posting..." : "Post Voucher"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(paymentInvoice)} onOpenChange={(open) => !open && setPaymentInvoice(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record Invoice Payment</DialogTitle>
          </DialogHeader>
          {paymentInvoice && (
            <div className="space-y-4">
              <div className="rounded border bg-gray-50 p-3 text-sm">
                <p className="font-medium">{paymentInvoice.invoice_number}</p>
                <p className="text-xs text-gray-500">{paymentInvoice.client_name}</p>
                <p className="mt-1 text-xs text-gray-600">
                  Outstanding: <span className="font-semibold text-orange-700">{money(Number(paymentInvoice.balance))}</span>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1 text-xs text-gray-500">Payment Date</p>
                  <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                </div>
                <div>
                  <p className="mb-1 text-xs text-gray-500">Amount</p>
                  <Input type="number" min="0" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1 text-xs text-gray-500">Mode</p>
                  <Select value={paymentMode} onValueChange={setPaymentMode}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BANK_TRANSFER">Bank Transfer</SelectItem>
                      <SelectItem value="CASH">Cash</SelectItem>
                      <SelectItem value="UPI">UPI</SelectItem>
                      <SelectItem value="CHEQUE">Cheque</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-xs text-gray-500">Reference</p>
                  <Input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="UTR/Cheque no." />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-500">Notes</p>
                <Input value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} placeholder="Optional notes" />
              </div>
              <div className="flex justify-end">
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={recordPaymentMutation.isPending}
                  onClick={() => {
                    const amount = Number(paymentAmount)
                    if (!paymentDate || Number.isNaN(amount) || amount <= 0) {
                      toast.error("Enter valid payment date and amount")
                      return
                    }
                    if (amount > Number(paymentInvoice.balance) + 0.01) {
                      toast.error("Payment cannot exceed outstanding balance")
                      return
                    }
                    recordPaymentMutation.mutate()
                  }}
                >
                  {recordPaymentMutation.isPending ? "Recording..." : "Record Payment"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(viewInvoice)}
        onOpenChange={(open) => {
          if (!open) {
            setViewInvoice(null)
            setNoteType(null)
            setNoteLines([])
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Invoice Details</DialogTitle>
          </DialogHeader>
          {viewInvoice && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-md border bg-gray-50 p-3">
                <div>
                  <p className="text-xs text-gray-500">Invoice #</p>
                  <p className="font-medium">{viewInvoice.invoice_number}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Status</p>
                  <div className="mt-0.5">{getStatusBadge(viewInvoice.status)}</div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Client</p>
                  <p className="font-medium">{viewInvoice.client_name}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Client GSTIN</p>
                  <p className="font-medium">{viewInvoice.client_gstin || "-"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Supply Type</p>
                  <p className="font-medium">{viewInvoice.supply_type === "INTER_STATE" ? "Inter-State (IGST)" : "Intra-State (CGST+SGST)"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Place of Supply</p>
                  <p className="font-medium">{viewInvoice.place_of_supply || "-"}</p>
                </div>
              </div>

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {viewInvoice.items.map((item, idx) => (
                      <TableRow key={`${viewInvoice.id}-${idx}`}>
                        <TableCell>{item.description}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">{money(item.rate)}</TableCell>
                        <TableCell className="text-right">{money(item.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="ml-auto w-full max-w-md space-y-2 rounded-md border bg-gray-50 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Taxable Amount</span>
                  <span className="font-medium">{money(Number(viewInvoice.taxable_amount ?? viewInvoice.total_amount))}</span>
                </div>
                {viewInvoice.supply_type === "INTRA_STATE" ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-600">CGST @9%</span>
                      <span className="font-medium">{money(Number(viewInvoice.cgst_amount ?? 0))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">SGST @9%</span>
                      <span className="font-medium">{money(Number(viewInvoice.sgst_amount ?? 0))}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-gray-600">IGST @18%</span>
                    <span className="font-medium">{money(Number(viewInvoice.igst_amount ?? 0))}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-2">
                  <span className="font-semibold text-gray-900">Invoice Total</span>
                  <span className="font-bold text-indigo-700">{money(Number(viewInvoice.grand_total ?? viewInvoice.total_amount))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Paid</span>
                  <span className="font-medium text-green-700">{money(Number(viewInvoice.paid_amount))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Balance</span>
                  <span className="font-semibold text-orange-700">{money(Number(viewInvoice.balance))}</span>
                </div>
              </div>

              <div className="rounded-md border bg-white p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900">Credit / Debit Notes</p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => openNoteForm("CREDIT")}>
                      Issue Credit Note
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => openNoteForm("DEBIT")}>
                      Issue Debit Note
                    </Button>
                  </div>
                </div>

                {noteType ? (
                  <div className="mb-3 space-y-2 rounded-md border bg-gray-50 p-3">
                    <p className="text-xs font-semibold text-gray-700">
                      {noteType === "CREDIT" ? "New Credit Note" : "New Debit Note"}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="mb-1 text-xs text-gray-500">Note Date</p>
                        <Input type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
                      </div>
                      <div className="col-span-1">
                        <p className="mb-1 text-xs text-gray-500">Reason</p>
                        <Input value={noteReason} onChange={(e) => setNoteReason(e.target.value)} />
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded-md border bg-white">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[44px] text-center">Sel</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">Max Qty</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead className="text-right">Rate</TableHead>
                            <TableHead className="text-right">Tax %</TableHead>
                            <TableHead className="text-right">Line Total</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {noteLines.map((line, idx) => {
                            const lineTotal = Number(line.quantity || 0) * Number(line.rate || 0)
                            return (
                              <TableRow key={line.key}>
                                <TableCell className="text-center">
                                  <input
                                    type="checkbox"
                                    checked={line.selected}
                                    onChange={(e) =>
                                      setNoteLines((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, selected: e.target.checked } : x))
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={line.description}
                                    onChange={(e) =>
                                      setNoteLines((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x))
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell className="text-right">{line.max_quantity > 0 ? line.max_quantity : "-"}</TableCell>
                                <TableCell>
                                  <Input
                                    className="text-right"
                                    type="number"
                                    min="0"
                                    step="0.001"
                                    value={line.quantity}
                                    onChange={(e) =>
                                      setNoteLines((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x))
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    className="text-right"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={line.rate}
                                    onChange={(e) =>
                                      setNoteLines((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, rate: e.target.value } : x))
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    className="text-right"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={line.tax_rate}
                                    onChange={(e) =>
                                      setNoteLines((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, tax_rate: e.target.value } : x))
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell className="text-right font-medium">{money(lineTotal)}</TableCell>
                              </TableRow>
                            )
                          })}
                          {noteLines.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={7} className="py-4 text-center text-xs text-gray-500">
                                No invoice lines available.
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={addCustomNoteLine}>
                        Add Custom Line
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setNoteType(null)}>
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-indigo-600"
                        disabled={createCreditNoteMutation.isPending || createDebitNoteMutation.isPending}
                        onClick={() => {
                          if (!noteDate || !noteReason.trim()) {
                            toast.error("Enter valid note date and reason")
                            return
                          }
                          const selected = noteLines.filter((line) => line.selected)
                          if (selected.length === 0) {
                            toast.error("Select at least one line")
                            return
                          }
                          const hasInvalid = selected.some((line) => {
                            const qty = Number(line.quantity)
                            const rate = Number(line.rate)
                            const taxRate = Number(line.tax_rate)
                            if (!line.description.trim()) return true
                            if (!Number.isFinite(qty) || qty <= 0) return true
                            if (!Number.isFinite(rate) || rate < 0) return true
                            if (!Number.isFinite(taxRate) || taxRate < 0) return true
                            if (!line.is_custom && line.max_quantity > 0 && qty > line.max_quantity) return true
                            return false
                          })
                          if (hasInvalid) {
                            toast.error("Fix line values (description, qty/rate/tax, qty <= invoice qty)")
                            return
                          }
                          if (noteType === "CREDIT") {
                            createCreditNoteMutation.mutate()
                          } else {
                            createDebitNoteMutation.mutate()
                          }
                        }}
                      >
                        {noteType === "CREDIT"
                          ? createCreditNoteMutation.isPending
                            ? "Issuing..."
                            : "Submit Credit Note"
                          : createDebitNoteMutation.isPending
                            ? "Issuing..."
                            : "Submit Debit Note"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-semibold text-gray-700">Credit Notes</p>
                    {creditNotesQuery.isLoading ? (
                      <p className="text-xs text-gray-500">Loading...</p>
                    ) : (creditNotesQuery.data ?? []).length === 0 ? (
                      <p className="text-xs text-gray-500">No credit notes</p>
                    ) : (
                      <div className="space-y-2">
                        {(creditNotesQuery.data ?? []).slice(0, 5).map((note) => (
                          <div key={note.id} className="rounded border px-2 py-1 text-xs">
                            <p className="font-medium">{note.note_number}</p>
                            <p>{note.note_date?.slice(0, 10)} | {money(Number(note.grand_total || 0))}</p>
                            <p className="text-gray-500">{note.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold text-gray-700">Debit Notes</p>
                    {debitNotesQuery.isLoading ? (
                      <p className="text-xs text-gray-500">Loading...</p>
                    ) : (debitNotesQuery.data ?? []).length === 0 ? (
                      <p className="text-xs text-gray-500">No debit notes</p>
                    ) : (
                      <div className="space-y-2">
                        {(debitNotesQuery.data ?? []).slice(0, 5).map((note) => (
                          <div key={note.id} className="rounded border px-2 py-1 text-xs">
                            <p className="font-medium">{note.note_number}</p>
                            <p>{note.note_date?.slice(0, 10)} | {money(Number(note.grand_total || 0))}</p>
                            <p className="text-gray-500">{note.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-md border bg-white p-3">
                <p className="mb-2 text-sm font-semibold text-gray-900">Payment History</p>
                {(viewInvoice.payments ?? []).length === 0 ? (
                  <p className="text-xs text-gray-500">No payments recorded</p>
                ) : (
                  <div className="space-y-2">
                    {(viewInvoice.payments ?? []).map((payment) => (
                      <div key={payment.id} className="flex items-center justify-between rounded border px-3 py-2 text-xs">
                        <div>
                          <p className="font-medium">{payment.payment_date}</p>
                          <p className="text-gray-500">
                            {payment.payment_mode || "N/A"}
                            {payment.reference_no ? ` | Ref: ${payment.reference_no}` : ""}
                          </p>
                        </div>
                        <p className="font-semibold text-emerald-700">{money(Number(payment.amount))}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

