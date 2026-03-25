"use client"

import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Download, FileText, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

type BillingInvoice = {
  id: number
  invoice_number: string
  client_id: number
  client_name: string
  billing_period: string
  invoice_date: string
  due_date: string
  total_amount: number
  paid_amount: number
  balance: number
  status: "PAID" | "PENDING" | "OVERDUE"
}

type WarehouseOption = {
  id: number
  warehouse_name: string
}

type UnratedTransaction = {
  id: number
  client_id?: number
  warehouse_id?: number | null
  warehouse_name?: string | null
  client_name: string
  source_type: string
  source_doc_id?: number | null
  source_line_id?: number | null
  source_ref_no?: string | null
  charge_type: string
  quantity: number
  uom?: string
  amount?: number
  gst_rate?: number
  total_tax_amount?: number
  rate_master_id?: number | null
  rate_detail_id?: number | null
  status?: string
  event_date: string
  remarks?: string | null
}

type BillingPreview = {
  periodFrom: string
  periodTo: string
  clientScope: string
  warehouseScope: string
  billableTransactions: number
  unbilledTransactionCount: number
  unratedTransactionCount: number
  skippedTransactions: number
  expectedRevenue: number
  expectedInvoiceCount: number
  groupedTotalsByClient: Array<{ client: string; transactions: number; expectedRevenue: number }>
  warnings: string[]
}

type ExceptionRow = {
  id: string
  exceptionType: string
  severity: "HIGH" | "MEDIUM" | "LOW"
  sourceRef: string
  client: string
  detectedOn: string
  status: "OPEN" | "REVIEW" | "RESOLVED" | "IGNORED"
  owner: string
  rootCause?: string
  resolutionNote?: string
}

type ExceptionAction = "RESOLVE" | "IGNORE" | "REVIEW"

type ExceptionActionLog = {
  status: "RESOLVED" | "IGNORED" | "REVIEW"
  owner: string
  rootCause: string
  resolutionNote: string
}

const TODAY = new Date()
const TODAY_ISO = TODAY.toISOString().slice(0, 10)
const THIRTY_DAYS_AGO_ISO = new Date(TODAY.getTime() - 30 * 86400000).toISOString().slice(0, 10)
const colors = ["#2563b0", "#7c3aed", "#0891b2", "#64748b", "#0f766e", "#d97706"]
const ROOT_CAUSES = [
  "Master Data Gap",
  "Rate Card Configuration",
  "Source Data Error",
  "Tax Mapping Error",
  "Duplicate Processing",
  "Contract Exception",
  "Manual Override Approved",
]

const asInr = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0)

const toLabel = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())

export default function BillingPage() {
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [clientFilter, setClientFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [applied, setApplied] = useState({ dateFrom, dateTo, clientFilter: "all", warehouseFilter: "all" })
  const [workspaceTab, setWorkspaceTab] = useState<"unbilled" | "unrated" | "exceptions">("unbilled")
  const [preview, setPreview] = useState<BillingPreview | null>(null)
  const [exceptionActions, setExceptionActions] = useState<Record<string, ExceptionActionLog>>({})
  const [exceptionDialogOpen, setExceptionDialogOpen] = useState(false)
  const [exceptionDraft, setExceptionDraft] = useState<{
    exception: ExceptionRow | null
    action: ExceptionAction
    rootCause: string
    note: string
  }>({
    exception: null,
    action: "RESOLVE",
    rootCause: "",
    note: "",
  })

  const clientsQuery = useQuery({
    queryKey: ["clients", "active"],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; client_name: string }[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })
  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const billingQuery = useQuery({
    queryKey: ["finance", "billing", applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      qp.set("client_id", applied.clientFilter)
      qp.set("warehouse_id", applied.warehouseFilter)
      const res = await apiClient.get<{
        invoices: BillingInvoice[]
        summary: { totalRevenue: number; totalPaid: number; totalPending: number; invoiceCount: number }
        insights: {
          collectionEfficiencyPct: number
          overdueSharePct: number
          avgInvoiceValue: number
          activeClients: number
          inboundGrnDocs: number
          outboundDoDocs: number
          unratedTransactionCount: number
          chargeMix: Array<{ charge_type: string; amount: number }>
          sourceMix: Array<{ source_type: string; amount: number }>
        }
      }>(`/finance/billing?${qp.toString()}`)
      return res.data
    },
  })

  const generateMutation = useMutation({
    mutationFn: async () => apiClient.post("/finance/invoices/draft", { period_from: applied.dateFrom, period_to: applied.dateTo }),
    onSuccess: () => {
      billingQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to generate invoice drafts"),
  })

  const runCycleMutation = useMutation({
    mutationFn: async () =>
      apiClient.post("/finance/jobs/invoice-cycle-run", {
        run_date: applied.dateTo,
        client_id: applied.clientFilter === "all" ? undefined : Number(applied.clientFilter),
      }),
    onSuccess: () => {
      billingQuery.refetch()
      unbilledQuery.refetch()
      unratedQuery.refetch()
      allTransactionsQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to run tenant billing cycle"),
  })
  const autoReprocessMutation = useMutation({
    mutationFn: async () =>
      apiClient.post("/finance/jobs/unrated-reprocess", {
        client_id: applied.clientFilter === "all" ? undefined : Number(applied.clientFilter),
        warehouse_id: applied.warehouseFilter === "all" ? undefined : Number(applied.warehouseFilter),
        date_from: applied.dateFrom,
        date_to: applied.dateTo,
        limit: 500,
      }),
    onSuccess: () => {
      billingQuery.refetch()
      unbilledQuery.refetch()
      unratedQuery.refetch()
      allTransactionsQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to run auto reprocess job"),
  })

  const unratedQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "unrated", applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("status", "UNRATED")
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      const res = await apiClient.get<UnratedTransaction[]>(`/finance/billing-transactions?${qp.toString()}`)
      return res.data ?? []
    },
  })

  const unbilledQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "unbilled", applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("status", "UNBILLED")
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      const res = await apiClient.get<UnratedTransaction[]>(`/finance/billing-transactions?${qp.toString()}`)
      return res.data ?? []
    },
  })

  const allTransactionsQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "all", applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      const res = await apiClient.get<UnratedTransaction[]>(`/finance/billing-transactions?${qp.toString()}`)
      return res.data ?? []
    },
  })

  const voidUnratedMutation = useMutation({
    mutationFn: async (id: number) => apiClient.put("/finance/billing-transactions", { id, action: "VOID" }),
    onSuccess: () => {
      unratedQuery.refetch()
      billingQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to void unrated transaction"),
  })

  const markForNextRunMutation = useMutation({
    mutationFn: async (id: number) => apiClient.put("/finance/billing-transactions", { id, action: "UNBILL" }),
    onSuccess: () => {
      unbilledQuery.refetch()
      billingQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to mark for next run"),
  })

  const reprocessUnratedMutation = useMutation({
    mutationFn: async (tx: UnratedTransaction) =>
      apiClient.post("/finance/billing-transactions", {
        client_id: Number(tx.client_id),
        warehouse_id: tx.warehouse_id ?? undefined,
        charge_type: tx.charge_type,
        source_type: tx.source_type,
        source_doc_id: tx.source_doc_id ?? undefined,
        source_line_id: tx.source_line_id ?? undefined,
        source_ref_no: tx.source_ref_no ?? undefined,
        event_date: tx.event_date?.slice(0, 10),
        period_from: tx.event_date?.slice(0, 10),
        period_to: tx.event_date?.slice(0, 10),
        quantity: Number(tx.quantity || 0),
        uom: tx.uom || "UNIT",
        remarks: tx.remarks || "Reprocessed from unrated queue",
      }),
    onSuccess: () => {
      unratedQuery.refetch()
      unbilledQuery.refetch()
      billingQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to reprocess unrated transaction"),
  })

  const invoices = billingQuery.data?.invoices ?? []
  const summary = billingQuery.data?.summary ?? {
    totalRevenue: 0,
    totalPaid: 0,
    totalPending: 0,
    invoiceCount: 0,
  }
  const insights = billingQuery.data?.insights ?? {
    collectionEfficiencyPct: 0,
    overdueSharePct: 0,
    avgInvoiceValue: 0,
    activeClients: 0,
    inboundGrnDocs: 0,
    outboundDoDocs: 0,
    unratedTransactionCount: 0,
    chargeMix: [] as Array<{ charge_type: string; amount: number }>,
    sourceMix: [] as Array<{ source_type: string; amount: number }>,
  }

  const sourceMixData = insights.sourceMix.map((row) => ({
    name: toLabel(row.source_type),
    amount: Number(row.amount || 0),
  }))

  const chargeMixData = insights.chargeMix.map((row) => ({
    name: toLabel(row.charge_type),
    amount: Number(row.amount || 0),
  }))

  const waterfallData = sourceMixData.reduce<Array<{ name: string; offset: number; amount: number }>>((acc, item) => {
    const previous = acc.length === 0 ? 0 : acc[acc.length - 1].offset + acc[acc.length - 1].amount
    acc.push({ name: item.name, offset: previous, amount: item.amount })
    return acc
  }, [])
  if (summary.totalRevenue > 0) {
    waterfallData.push({ name: "Total", offset: 0, amount: summary.totalRevenue })
  }

  const todayTs = new Date().setHours(0, 0, 0, 0)
  const unpaidInvoices = invoices.filter((invoice) => invoice.status !== "PAID")
  const avgDaysToDue =
    unpaidInvoices.length === 0
      ? 0
      : Math.round(
          unpaidInvoices.reduce((sum, invoice) => {
            const dueTs = new Date(invoice.due_date).setHours(0, 0, 0, 0)
            return sum + Math.round((dueTs - todayTs) / 86400000)
          }, 0) / unpaidInvoices.length
        )

  const agingBuckets = { "0-7d": 0, "8-14d": 0, "15-21d": 0, "22-30d": 0, "30d+": 0, Overdue: 0 }
  unpaidInvoices.forEach((invoice) => {
    const dueTs = new Date(invoice.due_date).setHours(0, 0, 0, 0)
    const days = Math.round((dueTs - todayTs) / 86400000)
    if (days < 0) agingBuckets.Overdue += 1
    else if (days <= 7) agingBuckets["0-7d"] += 1
    else if (days <= 14) agingBuckets["8-14d"] += 1
    else if (days <= 21) agingBuckets["15-21d"] += 1
    else if (days <= 30) agingBuckets["22-30d"] += 1
    else agingBuckets["30d+"] += 1
  })
  const agingData = Object.entries(agingBuckets).map(([name, count]) => ({ name, count }))

  const clientRollup = invoices.reduce<Record<string, { count: number; amount: number; pending: number }>>((acc, row) => {
    const key = row.client_name || "Unknown"
    if (!acc[key]) acc[key] = { count: 0, amount: 0, pending: 0 }
    acc[key].count += 1
    acc[key].amount += Number(row.total_amount || 0)
    acc[key].pending += Number(row.balance || 0)
    return acc
  }, {})

  const concentrationData = Object.entries(clientRollup)
    .map(([client, row]) => ({ client, x: row.count, y: Math.round(row.amount), z: Math.max(10, Math.round(row.amount / 1000)) }))
    .slice(0, 8)

  const pendingByClientData = Object.entries(clientRollup)
    .map(([client, row]) => ({ client, pending: Number(row.pending.toFixed(2)) }))
    .filter((row) => row.pending > 0)
    .sort((a, b) => b.pending - a.pending)
    .slice(0, 6)

  const trendMap = invoices.reduce<Record<string, { invoiced: number; collected: number }>>((acc, row) => {
    const date = new Date(row.invoice_date)
    if (Number.isNaN(date.getTime())) return acc
    const key = date.toLocaleString("en-US", { month: "short", year: "2-digit" })
    if (!acc[key]) acc[key] = { invoiced: 0, collected: 0 }
    acc[key].invoiced += Number(row.total_amount || 0)
    acc[key].collected += Number(row.paid_amount || 0)
    return acc
  }, {})
  const trendData = Object.entries(trendMap).map(([period, row]) => ({ period, ...row }))

  const doToGrnRatio = insights.inboundGrnDocs > 0 ? insights.outboundDoDocs / insights.inboundGrnDocs : 0
  const activityRows = [
    { label: "Inbound GRNs", value: insights.inboundGrnDocs, unit: "" },
    { label: "Outbound DOs", value: insights.outboundDoDocs, unit: "" },
    { label: "Active clients", value: insights.activeClients, unit: "" },
    { label: "Invoices", value: summary.invoiceCount, unit: "" },
  ]
  const activityMax = Math.max(...activityRows.map((row) => row.value), 1)

  const statusColors: Record<BillingInvoice["status"], string> = {
    PAID: "bg-green-100 text-green-800",
    PENDING: "bg-yellow-100 text-yellow-800",
    OVERDUE: "bg-red-100 text-red-800",
  }

  const overdueCount = invoices.filter((bill) => bill.status === "OVERDUE").length
  const unbilledRows = unbilledQuery.data ?? []
  const unratedRows = unratedQuery.data ?? []
  const allRows = allTransactionsQuery.data ?? []

  const exceptionRows: ExceptionRow[] = (() => {
    const rows: ExceptionRow[] = []
    const duplicateMap = new Map<string, number>()
    allRows.forEach((tx) => {
      const key = `${tx.source_type}|${tx.source_doc_id ?? 0}|${tx.source_line_id ?? 0}|${tx.charge_type}|${tx.event_date?.slice(0, 10)}`
      duplicateMap.set(key, (duplicateMap.get(key) || 0) + 1)
    })
    allRows.forEach((tx) => {
      const txDate = tx.event_date?.slice(0, 10) || "-"
      const sourceRef = tx.source_ref_no || `${tx.source_type}-${tx.source_doc_id ?? tx.id}`
      const client = tx.client_name || "Unknown"
      if ((tx.status || "") === "UNRATED") {
        const reason = (tx.remarks || "").toLowerCase()
        rows.push({
          id: `missing-rate-${tx.id}`,
          exceptionType: reason.includes("contract") ? "Missing Contract" : "Missing Active Rate",
          severity: "HIGH",
          sourceRef,
          client,
          detectedOn: txDate,
          status: "OPEN",
          owner: "Billing Ops",
        })
      }
      if (Number(tx.amount || 0) === 0 && (tx.status || "") !== "VOID") {
        rows.push({
          id: `zero-value-${tx.id}`,
          exceptionType: "Zero-value Derived Line",
          severity: "MEDIUM",
          sourceRef,
          client,
          detectedOn: txDate,
          status: "OPEN",
          owner: "Finance",
        })
      }
      if (Number(tx.amount || 0) > 0 && Number(tx.gst_rate || 0) <= 0) {
        rows.push({
          id: `invalid-tax-${tx.id}`,
          exceptionType: "Invalid Tax Mapping",
          severity: "HIGH",
          sourceRef,
          client,
          detectedOn: txDate,
          status: "OPEN",
          owner: "Tax Team",
        })
      }
      const key = `${tx.source_type}|${tx.source_doc_id ?? 0}|${tx.source_line_id ?? 0}|${tx.charge_type}|${tx.event_date?.slice(0, 10)}`
      if ((duplicateMap.get(key) || 0) > 1) {
        rows.push({
          id: `duplicate-${tx.id}`,
          exceptionType: "Duplicate Candidate",
          severity: "MEDIUM",
          sourceRef,
          client,
          detectedOn: txDate,
          status: "REVIEW",
          owner: "Billing Ops",
        })
      }
    })
    return rows.slice(0, 100)
  })()
  const exceptionDisplayRows: ExceptionRow[] = exceptionRows.map((row) => {
    const action = exceptionActions[row.id]
    if (!action) return row
    return {
      ...row,
      status: action.status,
      owner: action.owner,
      rootCause: action.rootCause,
      resolutionNote: action.resolutionNote,
    }
  })
  const openExceptionCount = exceptionDisplayRows.filter(
    (row) => row.status === "OPEN" || row.status === "REVIEW"
  ).length

  const openExceptionDialog = (row: ExceptionRow, action: ExceptionAction) => {
    const previous = exceptionActions[row.id]
    setExceptionDraft({
      exception: row,
      action,
      rootCause: previous?.rootCause || "",
      note: previous?.resolutionNote || "",
    })
    setExceptionDialogOpen(true)
  }

  const submitExceptionAction = () => {
    if (!exceptionDraft.exception) return
    const rootCause = exceptionDraft.rootCause.trim()
    const note = exceptionDraft.note.trim()
    if (!rootCause) {
      toast.error("Root cause is required")
      return
    }
    if (note.length < 8) {
      toast.error("Resolution note must be at least 8 characters")
      return
    }

    const statusByAction: Record<ExceptionAction, "RESOLVED" | "IGNORED" | "REVIEW"> = {
      RESOLVE: "RESOLVED",
      IGNORE: "IGNORED",
      REVIEW: "REVIEW",
    }
    const ownerByAction: Record<ExceptionAction, string> = {
      RESOLVE: "Billing Ops",
      IGNORE: "Finance",
      REVIEW: "Finance Review",
    }
    const nextStatus = statusByAction[exceptionDraft.action]
    const nextOwner = ownerByAction[exceptionDraft.action]
    setExceptionActions((prev) => ({
      ...prev,
      [exceptionDraft.exception!.id]: {
        status: nextStatus,
        owner: nextOwner,
        rootCause,
        resolutionNote: note,
      },
    }))
    setExceptionDialogOpen(false)
    setExceptionDraft({ exception: null, action: "RESOLVE", rootCause: "", note: "" })
    toast.success(`Exception ${nextStatus.toLowerCase()}`)
  }

  const previewMutation = useMutation({
    mutationFn: async () => {
      const byClient = new Map<string, { transactions: number; expectedRevenue: number }>()
      unbilledRows.forEach((tx) => {
        const key = tx.client_name || "Unknown"
        const row = byClient.get(key) || { transactions: 0, expectedRevenue: 0 }
        row.transactions += 1
        row.expectedRevenue += Number(tx.amount || 0)
        byClient.set(key, row)
      })
      const groupedTotalsByClient = Array.from(byClient.entries())
        .map(([client, value]) => ({ client, ...value }))
        .sort((a, b) => b.expectedRevenue - a.expectedRevenue)
      const warnings: string[] = []
      if (unratedRows.length > 0) warnings.push(`${unratedRows.length} unrated transactions will be skipped.`)
      if (openExceptionCount > 0) warnings.push(`${openExceptionCount} billing exceptions need review.`)
      if (unbilledRows.length === 0) warnings.push("No unbilled transactions found for selected scope.")
      const payload: BillingPreview = {
        periodFrom: applied.dateFrom,
        periodTo: applied.dateTo,
        clientScope: applied.clientFilter === "all" ? "All Clients" : (clientsQuery.data ?? []).find((x) => String(x.id) === applied.clientFilter)?.client_name || "Selected Client",
        warehouseScope: applied.warehouseFilter === "all" ? "All Warehouses" : (warehousesQuery.data ?? []).find((x) => String(x.id) === applied.warehouseFilter)?.warehouse_name || "Selected Warehouse",
        billableTransactions: unbilledRows.length,
        unbilledTransactionCount: unbilledRows.length,
        unratedTransactionCount: unratedRows.length,
        skippedTransactions: unratedRows.length,
        expectedRevenue: groupedTotalsByClient.reduce((sum, x) => sum + x.expectedRevenue, 0),
        expectedInvoiceCount: groupedTotalsByClient.length,
        groupedTotalsByClient,
        warnings,
      }
      return payload
    },
    onSuccess: (data) => setPreview(data),
  })

  const downloadPreview = () => {
    if (!preview) return
    const lines: string[] = [
      "Client,Transactions,ExpectedRevenue",
      ...preview.groupedTotalsByClient.map((row) => `${row.client},${row.transactions},${row.expectedRevenue.toFixed(2)}`),
      "",
      `Period From,${preview.periodFrom}`,
      `Period To,${preview.periodTo}`,
      `Unbilled Count,${preview.unbilledTransactionCount}`,
      `Unrated Count,${preview.unratedTransactionCount}`,
      `Skipped,${preview.skippedTransactions}`,
      `Expected Revenue,${preview.expectedRevenue.toFixed(2)}`,
    ]
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `billing_preview_${preview.periodFrom}_to_${preview.periodTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Billing & Finance</h1>
          <p className="mt-1 text-gray-500">Analytics Layer</p>
        </div>
        <Badge className="bg-slate-100 text-slate-800">Run preview before generation</Badge>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1">
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="flex-1">
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <Select value={clientFilter} onValueChange={setClientFilter}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clients</SelectItem>
                {(clientsQuery.data ?? []).map((client) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.client_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-56">
                <SelectValue />
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
            <Button className="bg-blue-600" onClick={() => setApplied({ dateFrom, dateTo, clientFilter, warehouseFilter })}>
              Filter
            </Button>
            <Button variant="outline" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
              <FileText className="mr-2 h-4 w-4" />
              {previewMutation.isPending ? "Previewing..." : "Preview Run"}
            </Button>
            <Button variant="outline" onClick={downloadPreview} disabled={!preview}>
              <Download className="mr-2 h-4 w-4" />
              Download Preview
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || !preview}
            >
              <FileText className="mr-2 h-4 w-4" />
              {generateMutation.isPending ? "Generating..." : "Generate Draft Invoices"}
            </Button>
            <Button
              variant="outline"
              onClick={() => runCycleMutation.mutate()}
              disabled={runCycleMutation.isPending}
            >
              <FileText className="mr-2 h-4 w-4" />
              {runCycleMutation.isPending ? "Running Cycle..." : "Run Billing Cycle (Tenant)"}
            </Button>
            <Button
              variant="outline"
              onClick={() => autoReprocessMutation.mutate()}
              disabled={autoReprocessMutation.isPending}
            >
              <FileText className="mr-2 h-4 w-4" />
              {autoReprocessMutation.isPending ? "Reprocessing UNRATED..." : "Auto Reprocess UNRATED"}
            </Button>
            <Button variant="outline" onClick={() => setWorkspaceTab("exceptions")}>
              View Exceptions First
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing Run Preview</CardTitle>
        </CardHeader>
        <CardContent>
          {!preview ? (
            <p className="text-sm text-gray-500">Run preview to inspect scope, expected totals, and warnings before draft generation.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Billing Period</p><p className="font-semibold">{preview.periodFrom} to {preview.periodTo}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Client Scope</p><p className="font-semibold">{preview.clientScope}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Warehouse Scope</p><p className="font-semibold">{preview.warehouseScope}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Billable Tx</p><p className="font-semibold">{preview.billableTransactions}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Expected Invoices</p><p className="font-semibold">{preview.expectedInvoiceCount}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-gray-500">Expected Revenue</p><p className="font-semibold">{asInr(preview.expectedRevenue)}</p></div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded border p-3">
                  <p className="mb-2 text-sm font-semibold">Grouped Expected Totals by Client</p>
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50">
                        <TableHead>Client</TableHead>
                        <TableHead className="text-right">Transactions</TableHead>
                        <TableHead className="text-right">Expected Revenue</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.groupedTotalsByClient.slice(0, 10).map((row) => (
                        <TableRow key={row.client}>
                          <TableCell>{row.client}</TableCell>
                          <TableCell className="text-right">{row.transactions}</TableCell>
                          <TableCell className="text-right">{asInr(row.expectedRevenue)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="rounded border p-3">
                  <p className="mb-2 text-sm font-semibold">Exception Summary</p>
                  <div className="space-y-1 text-sm">
                    <p>Unbilled transactions: <span className="font-semibold">{preview.unbilledTransactionCount}</span></p>
                    <p>Unrated transactions: <span className="font-semibold">{preview.unratedTransactionCount}</span></p>
                    <p>Skipped transactions: <span className="font-semibold">{preview.skippedTransactions}</span></p>
                  </div>
                  <div className="mt-3 space-y-1">
                    {preview.warnings.length === 0 ? (
                      <p className="text-xs text-green-700">No warnings.</p>
                    ) : (
                      preview.warnings.map((w, idx) => (
                        <p key={idx} className="text-xs text-amber-700">{w}</p>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Total Revenue</p><p className="text-2xl font-semibold">{asInr(summary.totalRevenue)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Collected</p><p className="text-2xl font-semibold">{asInr(summary.totalPaid)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Collection Rate</p><p className="text-2xl font-semibold">{insights.collectionEfficiencyPct.toFixed(1)}%</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Avg Invoice</p><p className="text-2xl font-semibold">{asInr(insights.avgInvoiceValue)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Days to Due</p><p className="text-2xl font-semibold">{avgDaysToDue}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-gray-500">Overdue Risk</p><p className="text-2xl font-semibold">{insights.overdueSharePct.toFixed(1)}%</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Unbilled Activities / Billing Exceptions</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button variant={workspaceTab === "unbilled" ? "default" : "outline"} size="sm" onClick={() => setWorkspaceTab("unbilled")}>
              Unbilled Activities
            </Button>
            <Button variant={workspaceTab === "unrated" ? "default" : "outline"} size="sm" onClick={() => setWorkspaceTab("unrated")}>
              Unrated Queue
            </Button>
            <Button variant={workspaceTab === "exceptions" ? "default" : "outline"} size="sm" onClick={() => setWorkspaceTab("exceptions")}>
              Exceptions
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workspaceTab === "unbilled" ? (
            unbilledQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead>Transaction Date</TableHead>
                    <TableHead>Source Type</TableHead>
                    <TableHead>Source Number</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead className="text-right">Qty / Basis</TableHead>
                    <TableHead>Reason Pending</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unbilledRows.slice(0, 30).map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell>{tx.event_date?.slice(0, 10)}</TableCell>
                      <TableCell>{tx.source_type}</TableCell>
                      <TableCell className="font-mono text-xs">{tx.source_ref_no || tx.source_doc_id || "-"}</TableCell>
                      <TableCell>{tx.client_name}</TableCell>
                      <TableCell>{tx.warehouse_name || "-"}</TableCell>
                      <TableCell className="text-right">{Number(tx.quantity || 0).toFixed(3)} {tx.uom || ""}</TableCell>
                      <TableCell className="text-xs text-gray-600">{tx.remarks || "Pending billing run"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => window.alert(`Source: ${tx.source_type} ${tx.source_ref_no || tx.source_doc_id || "-"}`)}>
                            View Source
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => markForNextRunMutation.mutate(tx.id)} disabled={markForNextRunMutation.isPending}>
                            Mark Next Run
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => window.alert(tx.remarks || "No billing trace details")}>
                            Inspect Trace
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {unbilledRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-6 text-center text-sm text-gray-500">
                        No unbilled activities for selected filter.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )
          ) : null}

          {workspaceTab === "unrated" ? (
            unratedQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead>Source</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Charge Basis</TableHead>
                    <TableHead>Missing Rule Reason</TableHead>
                    <TableHead>Suggested Contract/Rate</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unratedRows.slice(0, 30).map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell className="text-xs">{tx.source_type} {tx.source_ref_no ? `(${tx.source_ref_no})` : ""}</TableCell>
                      <TableCell>{tx.client_name}</TableCell>
                      <TableCell>{toLabel(tx.charge_type)} | Qty {Number(tx.quantity || 0).toFixed(3)}</TableCell>
                      <TableCell className="text-xs text-gray-600">{tx.remarks || "No applicable rate rule found"}</TableCell>
                      <TableCell className="text-xs">Create/Map active rate card detail</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => (window.location.href = "/finance/rates")}>Add Rule</Button>
                          <Button variant="outline" size="sm" onClick={() => (window.location.href = "/finance/rates")}>Map Existing Rule</Button>
                          <Button variant="outline" size="sm" onClick={() => reprocessUnratedMutation.mutate(tx)} disabled={reprocessUnratedMutation.isPending}>Reprocess</Button>
                          <Button variant="outline" size="sm" onClick={() => voidUnratedMutation.mutate(tx.id)} disabled={voidUnratedMutation.isPending}>Void</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {unratedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-gray-500">
                        No unrated transactions for selected filter.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )
          ) : null}

          {workspaceTab === "exceptions" ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Exception Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Source Ref</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Detected On</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exceptionDisplayRows.slice(0, 50).map((ex) => (
                  <TableRow key={ex.id}>
                    <TableCell>{ex.exceptionType}</TableCell>
                    <TableCell>
                      <Badge className={ex.severity === "HIGH" ? "bg-red-100 text-red-700" : ex.severity === "MEDIUM" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"}>
                        {ex.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{ex.sourceRef}</TableCell>
                    <TableCell>{ex.client}</TableCell>
                    <TableCell>{ex.detectedOn}</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          ex.status === "RESOLVED"
                            ? "bg-green-100 text-green-700"
                            : ex.status === "IGNORED"
                              ? "bg-slate-100 text-slate-700"
                              : ex.status === "REVIEW"
                                ? "bg-indigo-100 text-indigo-700"
                                : "bg-amber-100 text-amber-700"
                        }
                      >
                        {ex.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{ex.owner}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openExceptionDialog(ex, "RESOLVE")}>Resolve</Button>
                        <Button variant="outline" size="sm" onClick={() => openExceptionDialog(ex, "IGNORE")}>Ignore with Reason</Button>
                        <Button variant="outline" size="sm" onClick={() => openExceptionDialog(ex, "REVIEW")}>Send to Finance Review</Button>
                      </div>
                      {(ex.rootCause || ex.resolutionNote) && (
                        <p className="mt-1 max-w-[340px] text-right text-[11px] text-gray-500">
                          {ex.rootCause ? `Cause: ${ex.rootCause}. ` : ""}
                          {ex.resolutionNote ? `Note: ${ex.resolutionNote}` : ""}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {exceptionDisplayRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-sm text-gray-500">
                      No exceptions detected in selected period.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Revenue by Source</CardTitle></CardHeader>
          <CardContent className="h-64">
            {sourceMixData.length === 0 ? (
              <p className="text-sm text-gray-500">No source mix available for this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sourceMixData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(value) => `?${value}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                    {sourceMixData.map((entry, index) => <Cell key={entry.name} fill={colors[index % colors.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Charge Mix</CardTitle></CardHeader>
          <CardContent className="h-64">
            {chargeMixData.length === 0 ? (
              <p className="text-sm text-gray-500">No charge mix available for this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={chargeMixData} dataKey="amount" nameKey="name" innerRadius={55} outerRadius={85}>
                    {chargeMixData.map((entry, index) => <Cell key={entry.name} fill={colors[index % colors.length]} />)}
                  </Pie>
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Revenue Waterfall</CardTitle></CardHeader>
          <CardContent className="h-64">
            {waterfallData.length === 0 ? (
              <p className="text-sm text-gray-500">No revenue data available.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={waterfallData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(value) => `?${value}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Bar dataKey="offset" stackId="stack" fill="transparent" />
                  <Bar dataKey="amount" stackId="stack" radius={[4, 4, 0, 0]}>
                    {waterfallData.map((entry, index) => <Cell key={entry.name} fill={colors[index % colors.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Collection Efficiency Gauge</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                innerRadius="70%"
                outerRadius="100%"
                data={[{ name: "Collection", value: Math.max(0, Math.min(100, insights.collectionEfficiencyPct)) }]}
                startAngle={210}
                endAngle={-30}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                <RadialBar dataKey="value" cornerRadius={8} fill="#2563b0" />
                <Tooltip formatter={(value: number | string | undefined) => `${Number(value ?? 0).toFixed(1)}%`} />
              </RadialBarChart>
            </ResponsiveContainer>
            <p className="mt-2 text-center text-xl font-semibold">{insights.collectionEfficiencyPct.toFixed(1)}%</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Invoice Aging</CardTitle></CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={agingData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {agingData.map((entry, index) => <Cell key={entry.name} fill={colors[index % colors.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Revenue Concentration by Client</CardTitle></CardHeader>
          <CardContent className="h-56">
            {concentrationData.length === 0 ? (
              <p className="text-sm text-gray-500">No client concentration data available.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid />
                  <XAxis type="number" dataKey="x" name="Invoices" allowDecimals={false} tick={{ fontSize: 10 }} />
                  <YAxis type="number" dataKey="y" name="Revenue" tickFormatter={(value) => `?${value}`} tick={{ fontSize: 10 }} />
                  <ZAxis type="number" dataKey="z" range={[60, 320]} />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))}
                  />
                  <Scatter name="Clients" data={concentrationData} fill="#2563b0" />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Activity Volume Ratio</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {activityRows.map((row, index) => {
              const width = Math.max(4, Math.round((row.value / activityMax) * 100))
              return (
                <div key={row.label}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-gray-600">{row.label}</span>
                    <span className="font-medium">{row.value}{row.unit}</span>
                  </div>
                  <div className="h-2 rounded bg-gray-100">
                    <div className="h-2 rounded" style={{ width: `${width}%`, background: colors[index % colors.length] }} />
                  </div>
                </div>
              )
            })}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-gray-600">DO/GRN Ratio</span>
                <span className="font-medium">{doToGrnRatio.toFixed(1)}x</span>
              </div>
              <div className="h-2 rounded bg-gray-100">
                <div className="h-2 rounded bg-orange-500" style={{ width: `${Math.min(100, Math.round(doToGrnRatio * 20))}%` }} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{`Invoice Register (${invoices.length}) • Overdue: ${overdueCount}`}</CardTitle>
        </CardHeader>
        <CardContent>
          {billingQuery.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Invoice No.</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((bill) => (
                  <TableRow key={bill.id}>
                    <TableCell className="font-mono font-medium">{bill.invoice_number}</TableCell>
                    <TableCell>{bill.client_name}</TableCell>
                    <TableCell className="text-right font-semibold">{asInr(Number(bill.total_amount))}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Badge className={statusColors[bill.status]}>{bill.status}</Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Revenue Recognition Trend</CardTitle></CardHeader>
          <CardContent className="h-56">
            {trendData.length === 0 ? (
              <p className="text-sm text-gray-500">No trend data available for this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={(value) => `?${value}`} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Legend />
                  <Line type="monotone" dataKey="invoiced" stroke="#2563b0" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="collected" stroke="#0f766e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pending Revenue by Client</CardTitle></CardHeader>
          <CardContent className="h-56">
            {pendingByClientData.length === 0 ? (
              <p className="text-sm text-gray-500">No pending revenue in this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pendingByClientData} layout="vertical" margin={{ left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(value) => `?${value}`} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="client" width={120} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Bar dataKey="pending" radius={[0, 4, 4, 0]} fill="#7c3aed" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={exceptionDialogOpen} onOpenChange={setExceptionDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {exceptionDraft.action === "RESOLVE"
                ? "Resolve Billing Exception"
                : exceptionDraft.action === "IGNORE"
                  ? "Ignore Exception with Reason"
                  : "Send Exception to Finance Review"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-slate-50 p-3 text-sm">
              <p><span className="font-semibold">Type:</span> {exceptionDraft.exception?.exceptionType || "-"}</p>
              <p><span className="font-semibold">Source:</span> {exceptionDraft.exception?.sourceRef || "-"}</p>
              <p><span className="font-semibold">Client:</span> {exceptionDraft.exception?.client || "-"}</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Root Cause</label>
              <Select
                value={exceptionDraft.rootCause || undefined}
                onValueChange={(value) => setExceptionDraft((prev) => ({ ...prev, rootCause: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select root cause" />
                </SelectTrigger>
                <SelectContent>
                  {ROOT_CAUSES.map((cause) => (
                    <SelectItem key={cause} value={cause}>
                      {cause}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Resolution Note</label>
              <Textarea
                rows={4}
                placeholder="Write what was checked, what changed, and why this action is approved."
                value={exceptionDraft.note}
                onChange={(e) => setExceptionDraft((prev) => ({ ...prev, note: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setExceptionDialogOpen(false)}>Cancel</Button>
              <Button onClick={submitExceptionAction}>
                {exceptionDraft.action === "RESOLVE"
                  ? "Mark Resolved"
                  : exceptionDraft.action === "IGNORE"
                    ? "Ignore Exception"
                    : "Send to Review"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

