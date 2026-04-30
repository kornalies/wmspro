"use client"

import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  DollarSign,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { exportInvoicePDF, exportInvoicesToExcel } from "@/lib/export-utils"
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
  credit_note_total?: number
  reversal_credit_total?: number
  status: "DRAFT" | "FINALIZED" | "SENT" | "PAID" | "OVERDUE" | "VOID" | "REVERSED"
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
  const [clientFilter, setClientFilter] = useState("all")
  const [invoiceFrom, setInvoiceFrom] = useState("")
  const [invoiceTo, setInvoiceTo] = useState("")
  const [dueFrom, setDueFrom] = useState("")
  const [dueTo, setDueTo] = useState("")
  const [sortKey, setSortKey] = useState("invoice_date_desc")
  const [page, setPage] = useState(1)
  const [showAccounting, setShowAccounting] = useState(false)
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
  const [reversalInvoice, setReversalInvoice] = useState<Invoice | null>(null)
  const [reversalReason, setReversalReason] = useState("")

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
      if (statusFilter && statusFilter !== "all" && statusFilter !== "PARTIAL") qp.set("status", statusFilter)
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

  const reverseInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (!reversalInvoice) throw new Error("No invoice selected")
      const lines = (reversalInvoice.items ?? []).map((item) => ({
        ...(item.invoice_line_id ? { invoice_line_id: item.invoice_line_id } : {}),
        description: `Invoice reversal - ${item.description}`,
        quantity: Number(item.quantity || 0),
        rate: Number(item.rate || 0),
        tax_rate: Number(reversalInvoice.gst_rate || 18),
      })).filter((line) => line.quantity > 0)

      if (!lines.length) throw new Error("Invoice has no reversible lines")

      return apiClient.post("/finance/credit-notes", {
        invoice_id: reversalInvoice.id,
        note_date: todayIso,
        reason: `Invoice reversal: ${reversalReason.trim()}`,
        lines,
      })
    },
    onSuccess: () => {
      toast.success("Invoice reversal credit note issued")
      if (reversalInvoice) {
        const reversedValue = Number(reversalInvoice.grand_total ?? reversalInvoice.total_amount ?? 0)
        setViewInvoice((current) =>
          current?.id === reversalInvoice.id
            ? {
                ...current,
                status: "REVERSED",
                credit_note_total: Math.max(Number(current.credit_note_total || 0), reversedValue),
                reversal_credit_total: Math.max(Number(current.reversal_credit_total || 0), reversedValue),
                balance: 0,
              }
            : current
        )
      }
      setReversalInvoice(null)
      setReversalReason("")
      invoicesQuery.refetch()
      trialBalanceQuery.refetch()
      journalsQuery.refetch()
      creditNotesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to reverse invoice"),
  })

  const payload = invoicesQuery.data
  const invoices = payload?.invoices ?? []
  const searchSuggestions = useMemo(
    () => invoices.flatMap((invoice) => [invoice.invoice_number, invoice.client_name]),
    [invoices]
  )
  const clientOptions = useMemo(() => {
    const map = new Map<number, string>()
    for (const invoice of invoices) map.set(invoice.client_id, invoice.client_name)
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [invoices])
  const summary = payload?.summary ?? {
    totalRevenue: 0,
    totalPaid: 0,
    totalOutstanding: 0,
    totalTax: 0,
    totalInvoiceValue: 0,
    overdueCount: 0,
  }
  const filteredInvoices = useMemo(() => {
    const byDate = (value: string, from: string, to: string) => {
      const date = value?.slice(0, 10)
      if (from && date < from) return false
      if (to && date > to) return false
      return true
    }

    return invoices
      .filter((invoice) => {
        if (clientFilter !== "all" && String(invoice.client_id) !== clientFilter) return false
        if (statusFilter === "PARTIAL" && !(Number(invoice.paid_amount) > 0 && Number(invoice.balance) > 0)) return false
        if (!byDate(invoice.invoice_date, invoiceFrom, invoiceTo)) return false
        if (!byDate(invoice.due_date, dueFrom, dueTo)) return false
        return true
      })
      .sort((a, b) => {
        const moneyA = Number(a.grand_total ?? a.total_amount ?? 0)
        const moneyB = Number(b.grand_total ?? b.total_amount ?? 0)
        const balanceA = Number(a.balance ?? 0)
        const balanceB = Number(b.balance ?? 0)
        switch (sortKey) {
          case "invoice_date_asc":
            return a.invoice_date.localeCompare(b.invoice_date)
          case "due_date_asc":
            return a.due_date.localeCompare(b.due_date)
          case "due_date_desc":
            return b.due_date.localeCompare(a.due_date)
          case "value_desc":
            return moneyB - moneyA
          case "balance_desc":
            return balanceB - balanceA
          case "status_asc":
            return a.status.localeCompare(b.status)
          case "invoice_date_desc":
          default:
            return b.invoice_date.localeCompare(a.invoice_date)
        }
      })
  }, [clientFilter, dueFrom, dueTo, invoiceFrom, invoiceTo, invoices, sortKey])

  const pageSize = 10
  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pagedInvoices = filteredInvoices.slice((safePage - 1) * pageSize, safePage * pageSize)
  const statusChips = [
    { key: "all", label: "All", count: invoices.length },
    { key: "DRAFT", label: "Draft", count: invoices.filter((invoice) => invoice.status === "DRAFT").length },
    { key: "SENT", label: "Finalized", count: invoices.filter((invoice) => invoice.status === "SENT" || invoice.status === "FINALIZED").length },
    { key: "PAID", label: "Paid", count: invoices.filter((invoice) => invoice.status === "PAID").length },
    { key: "PARTIAL", label: "Partially Paid", count: invoices.filter((invoice) => Number(invoice.paid_amount) > 0 && Number(invoice.balance) > 0).length },
    { key: "OVERDUE", label: "Overdue", count: invoices.filter((invoice) => invoice.status === "OVERDUE").length },
    { key: "REVERSED", label: "Reversed", count: invoices.filter((invoice) => invoice.status === "REVERSED").length },
  ]

  useEffect(() => {
    setPage(1)
  }, [clientFilter, dueFrom, dueTo, invoiceFrom, invoiceTo, search, sortKey, statusFilter, warehouseFilter])

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
      case "REVERSED":
        return <RotateCcw className="h-4 w-4" />
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
      REVERSED: "bg-red-100 text-red-800",
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

  const formatDate = (value?: string) => {
    if (!value) return "-"
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
  }

  const money = (value: number) => `INR ${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

  const compactMoney = (value: number) => {
    const amount = Number(value || 0)
    if (Math.abs(amount) >= 100000) return `INR ${(amount / 100000).toFixed(1)}L`
    if (Math.abs(amount) >= 1000) return `INR ${(amount / 1000).toFixed(1)}k`
    return money(amount)
  }

  const dueHealth = (invoice: Invoice) => {
    if (invoice.status === "PAID" || Number(invoice.balance || 0) <= 0) {
      if (invoice.status === "REVERSED") return <Badge className="bg-red-100 text-red-800">Reversed</Badge>
      return <Badge className="bg-green-100 text-green-800">Paid</Badge>
    }
    const due = new Date(invoice.due_date)
    if (Number.isNaN(due.getTime())) return <Badge variant="outline">No due date</Badge>
    const days = Math.ceil((due.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (days < 0) return <Badge className="bg-red-100 text-red-800">Overdue by {Math.abs(days)}d</Badge>
    if (days <= 7) return <Badge className="bg-amber-100 text-amber-800">Due in {days}d</Badge>
    return <Badge className="bg-slate-100 text-slate-700">Due in {days}d</Badge>
  }

  const openPaymentDialog = (invoice: Invoice) => {
    setPaymentInvoice(invoice)
    setPaymentAmount(String(Number(invoice.balance)))
    setPaymentDate(new Date().toISOString().slice(0, 10))
    setPaymentMode("BANK_TRANSFER")
    setPaymentRef("")
    setPaymentNotes("")
  }

  const clearInvoiceFilters = () => {
    setSearchInput("")
    setSearch("")
    setStatusFilter("all")
    setWarehouseFilter("all")
    setClientFilter("all")
    setInvoiceFrom("")
    setInvoiceTo("")
    setDueFrom("")
    setDueTo("")
    setSortKey("invoice_date_desc")
  }

  const creditNoteTotal = (invoice?: Invoice | null) => {
    if (!invoice) return 0
    if (viewInvoice?.id === invoice.id && (creditNotesQuery.data ?? []).length > 0) {
      return (creditNotesQuery.data ?? []).reduce((sum, note) => sum + Number(note.grand_total || 0), 0)
    }
    return Number(invoice.credit_note_total || 0)
  }

  const canReverseInvoice = (invoice: Invoice, creditTotal = 0) => {
    if (invoice.status === "DRAFT" || invoice.status === "VOID" || invoice.status === "REVERSED") return false
    const invoiceValue = Number(invoice.grand_total ?? invoice.total_amount ?? 0)
    return invoiceValue > 0 && creditTotal + 0.01 < invoiceValue
  }

  const openReversalDialog = (invoice: Invoice) => {
    const existingCredit = viewInvoice?.id === invoice.id ? creditNoteTotal(invoice) : 0
    if (!canReverseInvoice(invoice, existingCredit)) {
      toast.error(invoice.status === "DRAFT" ? "Finalize the invoice before reversal" : "Invoice is already fully reversed or not reversible")
      return
    }
    setReversalInvoice(invoice)
    setReversalReason("")
  }

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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Invoice Management</h1>
          <p className="mt-1 text-gray-500">Generate, collect, reconcile, and track client invoices.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => exportInvoicesToExcel(filteredInvoices)}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button variant="outline" onClick={() => setIsJournalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Journal Voucher
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
              <p className="text-sm text-gray-600">Invoice Value</p>
              <p className="text-2xl font-bold">{compactMoney(summary.totalInvoiceValue)}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-green-100 p-3">
              <CheckCircle2 className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Collected</p>
              <p className="text-2xl font-bold">{compactMoney(summary.totalPaid)}</p>
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
              <p className="text-2xl font-bold">{compactMoney(summary.totalOutstanding)}</p>
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
              <p className="text-sm text-gray-600">Drafts</p>
              <p className="text-2xl font-bold">{invoices.filter((invoice) => invoice.status === "DRAFT").length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-100 p-3">
              <DollarSign className="h-6 w-6 text-indigo-700" />
            </div>
            <div>
              <p className="text-sm text-gray-600">GST</p>
              <p className="text-2xl font-bold">{compactMoney(summary.totalTax)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap gap-2">
          {statusChips.map((chip) => (
            <Button
              key={chip.key}
              variant={statusFilter === chip.key ? "default" : "outline"}
              className={statusFilter === chip.key ? "bg-slate-950 text-white hover:bg-slate-900" : ""}
              onClick={() => setStatusFilter(chip.key)}
            >
              {chip.label}
              <span className="ml-2 rounded-full bg-white/20 px-1.5 text-xs">{chip.count}</span>
            </Button>
          ))}
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(280px,1fr)_220px_220px_180px]">
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

        <Select value={clientFilter} onValueChange={setClientFilter}>
          <SelectTrigger>
            <SelectValue placeholder="All clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {clientOptions.map(([id, name]) => (
              <SelectItem key={id} value={String(id)}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
          <SelectTrigger>
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

        <Select value={sortKey} onValueChange={setSortKey}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="invoice_date_desc">Invoice date newest</SelectItem>
            <SelectItem value="invoice_date_asc">Invoice date oldest</SelectItem>
            <SelectItem value="due_date_asc">Due date earliest</SelectItem>
            <SelectItem value="due_date_desc">Due date latest</SelectItem>
            <SelectItem value="value_desc">Invoice value high</SelectItem>
            <SelectItem value="balance_desc">Balance high</SelectItem>
            <SelectItem value="status_asc">Status A-Z</SelectItem>
          </SelectContent>
        </Select>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input type="date" value={invoiceFrom} onChange={(e) => setInvoiceFrom(e.target.value)} aria-label="Invoice from date" />
            <Input type="date" value={invoiceTo} onChange={(e) => setInvoiceTo(e.target.value)} aria-label="Invoice to date" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} aria-label="Due from date" />
            <Input type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} aria-label="Due to date" />
          </div>
          <Button variant="outline" onClick={clearInvoiceFilters}>
            <X className="mr-2 h-4 w-4" /> Clear
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Invoice Register</h2>
            <p className="text-sm text-gray-500">
              Showing {filteredInvoices.length ? `${(safePage - 1) * pageSize + 1}-${Math.min(safePage * pageSize, filteredInvoices.length)}` : "0"} of {filteredInvoices.length} invoices
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <SlidersHorizontal className="h-4 w-4" />
            Amount columns are right aligned for reconciliation.
          </div>
        </div>
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
                  {pagedInvoices.map((invoice) => (
                    <TableRow key={invoice.id} className="hover:bg-gray-50">
                      <TableCell className="font-mono font-medium">{invoice.invoice_number}</TableCell>
                      <TableCell>{invoice.client_name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-gray-400" />
                          {invoice.billing_period}
                        </div>
                      </TableCell>
                      <TableCell>{formatDate(invoice.invoice_date)}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <span className={invoice.status === "OVERDUE" ? "font-medium text-red-600" : ""}>
                            {formatDate(invoice.due_date)}
                          </span>
                          <div>{dueHealth(invoice)}</div>
                        </div>
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
                                openPaymentDialog(invoice)
                              }}
                            >
                              <CreditCard className="h-4 w-4" />
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
                  {!pagedInvoices.length && (
                    <TableRow>
                      <TableCell colSpan={14}>
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <FileText className="h-10 w-10 text-gray-300" />
                          <h3 className="mt-3 font-semibold text-gray-900">No invoices found</h3>
                          <p className="mt-1 text-sm text-gray-500">Clear filters or generate invoice drafts for the selected period.</p>
                          <Button className="mt-4 bg-blue-600" onClick={() => generateInvoiceMutation.mutate()}>
                            <FileText className="mr-2 h-4 w-4" /> Generate Invoice
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3">
          <Button variant="outline" disabled={safePage <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>Previous</Button>
          <span className="text-sm text-gray-500">Page {safePage} of {totalPages}</span>
          <Button variant="outline" disabled={safePage >= totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>Next</Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Accounting Workspace</h2>
            <p className="text-sm text-gray-500">Trial balance and journals are available when you need ledger context.</p>
          </div>
          <Button variant="outline" onClick={() => setShowAccounting((value) => !value)}>
            {showAccounting ? "Hide Accounting" : "Show Accounting"}
          </Button>
        </div>
      </div>

      {showAccounting && (
      <>
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
      </>
      )}

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

      <Dialog open={Boolean(reversalInvoice)} onOpenChange={(open) => !open && setReversalInvoice(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Reverse Invoice</DialogTitle>
          </DialogHeader>
          {reversalInvoice && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="font-semibold text-red-900">{reversalInvoice.invoice_number}</p>
                <p className="mt-1 text-red-800">
                  This will create a full credit note for {money(Number(reversalInvoice.grand_total ?? reversalInvoice.total_amount))}.
                  The original invoice remains available for audit history.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-gray-500">Client</p>
                  <p className="font-medium">{reversalInvoice.client_name}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-gray-500">Current Balance</p>
                  <p className="font-medium">{money(Number(reversalInvoice.balance))}</p>
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-500">Reversal reason *</p>
                <Input
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  placeholder="Example: duplicate invoice, wrong billing period, client cancellation"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setReversalInvoice(null)}>Cancel</Button>
                <Button
                  className="bg-red-600 hover:bg-red-700"
                  disabled={reverseInvoiceMutation.isPending}
                  onClick={() => {
                    if (reversalReason.trim().length < 5) {
                      toast.error("Enter a clear reversal reason")
                      return
                    }
                    reverseInvoiceMutation.mutate()
                  }}
                >
                  {reverseInvoiceMutation.isPending ? "Reversing..." : "Create Reversal Credit Note"}
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
                <div className="flex justify-between">
                  <span className="text-gray-600">Credit Notes</span>
                  <span className="font-medium text-red-700">{money(creditNoteTotal(viewInvoice))}</span>
                </div>
              </div>

              <div className="rounded-md border bg-white p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900">Credit / Debit Notes</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-red-700"
                      disabled={creditNotesQuery.isLoading || !canReverseInvoice(viewInvoice, creditNoteTotal(viewInvoice))}
                      onClick={() => openReversalDialog(viewInvoice)}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Reverse Invoice
                    </Button>
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
