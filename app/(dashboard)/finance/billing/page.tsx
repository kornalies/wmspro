"use client"

import { useEffect, useState } from "react"
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
import { useAuth } from "@/hooks/use-auth"
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

type BillingProfile = {
  id: number
  client_id: number
  client_name: string
  client_code: string
  billing_cycle: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
  billing_day_of_week?: number | null
  billing_day_of_month?: number | null
  storage_billing_method: "SNAPSHOT" | "DURATION"
  storage_grace_days?: number
  credit_days?: number
  currency?: string
  invoice_prefix?: string
  minimum_billing_enabled?: boolean
  minimum_billing_amount?: number
  auto_finalize?: boolean
  is_active?: boolean
}

type BillingProfileForm = {
  billing_cycle: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY"
  billing_day_of_week: string
  billing_day_of_month: string
  storage_billing_method: "SNAPSHOT" | "DURATION"
  storage_grace_days: string
  credit_days: string
  currency: string
  invoice_prefix: string
  minimum_billing_enabled: boolean
  minimum_billing_amount: string
  auto_finalize: boolean
  is_active: boolean
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

function blankBillingProfileForm(): BillingProfileForm {
  return {
    billing_cycle: "MONTHLY",
    billing_day_of_week: "1",
    billing_day_of_month: "1",
    storage_billing_method: "SNAPSHOT",
    storage_grace_days: "0",
    credit_days: "30",
    currency: "INR",
    invoice_prefix: "INV",
    minimum_billing_enabled: false,
    minimum_billing_amount: "0",
    auto_finalize: false,
    is_active: true,
  }
}

function mapBillingProfileToForm(profile: BillingProfile | null): BillingProfileForm {
  if (!profile) return blankBillingProfileForm()
  return {
    billing_cycle: profile.billing_cycle || "MONTHLY",
    billing_day_of_week: String(profile.billing_day_of_week ?? 1),
    billing_day_of_month: String(profile.billing_day_of_month ?? 1),
    storage_billing_method: profile.storage_billing_method || "SNAPSHOT",
    storage_grace_days: String(profile.storage_grace_days ?? 0),
    credit_days: String(profile.credit_days ?? 30),
    currency: profile.currency || "INR",
    invoice_prefix: profile.invoice_prefix || "INV",
    minimum_billing_enabled: Boolean(profile.minimum_billing_enabled),
    minimum_billing_amount: String(profile.minimum_billing_amount ?? 0),
    auto_finalize: Boolean(profile.auto_finalize),
    is_active: profile.is_active !== false,
  }
}

export default function BillingPage() {
  const { user } = useAuth()
  const companyKey = user?.company_id ?? "unknown"
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [clientFilter, setClientFilter] = useState("all")
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [applied, setApplied] = useState({ dateFrom, dateTo, clientFilter: "all", warehouseFilter: "all" })
  const [pageSection, setPageSection] = useState<"operations" | "preview" | "exceptions" | "analytics">("operations")
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
  const [profileClientId, setProfileClientId] = useState("")
  const [profileDraft, setProfileDraft] = useState<BillingProfileForm | null>(null)

  const clientsQuery = useQuery({
    queryKey: ["clients", "active", companyKey],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; client_name: string }[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })
  const billingProfilesQuery = useQuery({
    queryKey: ["finance", "billing-profile", companyKey],
    queryFn: async () => {
      const res = await apiClient.get<BillingProfile[]>("/finance/billing-profile")
      return res.data ?? []
    },
  })
  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active", companyKey],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const billingQuery = useQuery({
    queryKey: ["finance", "billing", companyKey, applied],
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
  const saveBillingProfileMutation = useMutation({
    mutationFn: async () => {
      const dayOfWeek = Number(resolvedProfileForm.billing_day_of_week || "1")
      const dayOfMonth = Number(resolvedProfileForm.billing_day_of_month || "1")
      const storageGraceDays = Number(resolvedProfileForm.storage_grace_days || "0")
      const creditDays = Number(resolvedProfileForm.credit_days || "30")
      const minimumAmount = Number(resolvedProfileForm.minimum_billing_amount || "0")

      return apiClient.put("/finance/billing-profile", {
        client_id: Number(effectiveProfileClientId),
        billing_cycle: resolvedProfileForm.billing_cycle,
        billing_day_of_week:
          resolvedProfileForm.billing_cycle === "WEEKLY"
            ? Math.max(1, Math.min(7, Number.isFinite(dayOfWeek) ? dayOfWeek : 1))
            : null,
        billing_day_of_month:
          resolvedProfileForm.billing_cycle !== "WEEKLY"
            ? Math.max(1, Math.min(28, Number.isFinite(dayOfMonth) ? dayOfMonth : 1))
            : 1,
        storage_billing_method: resolvedProfileForm.storage_billing_method,
        storage_grace_days: Math.max(0, Number.isFinite(storageGraceDays) ? storageGraceDays : 0),
        credit_days: Math.max(0, Number.isFinite(creditDays) ? creditDays : 30),
        currency: (resolvedProfileForm.currency || "INR").trim().toUpperCase(),
        invoice_prefix: (resolvedProfileForm.invoice_prefix || "INV").trim().toUpperCase(),
        minimum_billing_enabled: resolvedProfileForm.minimum_billing_enabled,
        minimum_billing_amount: resolvedProfileForm.minimum_billing_enabled
          ? Math.max(0, Number.isFinite(minimumAmount) ? minimumAmount : 0)
          : 0,
        auto_finalize: resolvedProfileForm.auto_finalize,
        is_active: resolvedProfileForm.is_active,
      })
    },
    onSuccess: () => {
      toast.success("Billing profile saved")
      setProfileDraft(null)
      billingProfilesQuery.refetch()
    },
    onError: (error) => handleError(error, "Failed to save billing profile"),
  })

  const clients = clientsQuery.data ?? []
  const effectiveProfileClientId = profileClientId || (clients.length ? String(clients[0].id) : "")
  const selectedBillingProfile =
    (billingProfilesQuery.data ?? []).find((row) => String(row.client_id) === effectiveProfileClientId) ?? null
  const resolvedProfileForm = profileDraft ?? mapBillingProfileToForm(selectedBillingProfile)

  useEffect(() => {
    setDateFrom(THIRTY_DAYS_AGO_ISO)
    setDateTo(TODAY_ISO)
    setProfileClientId("")
    setProfileDraft(null)
    setClientFilter("all")
    setWarehouseFilter("all")
    setApplied({ dateFrom: THIRTY_DAYS_AGO_ISO, dateTo: TODAY_ISO, clientFilter: "all", warehouseFilter: "all" })
    setPreview(null)
  }, [companyKey])

  const unratedQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "unrated", companyKey, applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("status", "UNRATED")
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      if (applied.warehouseFilter !== "all") qp.set("warehouse_id", applied.warehouseFilter)
      const res = await apiClient.get<UnratedTransaction[]>(`/finance/billing-transactions?${qp.toString()}`)
      return res.data ?? []
    },
  })

  const unbilledQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "unbilled", companyKey, applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("status", "UNBILLED")
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      if (applied.warehouseFilter !== "all") qp.set("warehouse_id", applied.warehouseFilter)
      const res = await apiClient.get<UnratedTransaction[]>(`/finance/billing-transactions?${qp.toString()}`)
      return res.data ?? []
    },
  })

  const allTransactionsQuery = useQuery({
    queryKey: ["finance", "billing-transactions", "all", companyKey, applied],
    queryFn: async () => {
      const qp = new URLSearchParams()
      qp.set("date_from", applied.dateFrom)
      qp.set("date_to", applied.dateTo)
      if (applied.clientFilter !== "all") qp.set("client_id", applied.clientFilter)
      if (applied.warehouseFilter !== "all") qp.set("warehouse_id", applied.warehouseFilter)
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
  const unbilledRows = unbilledQuery.data ?? []
  const unratedRows = unratedQuery.data ?? []
  const allRows = allTransactionsQuery.data ?? []
  const analyticsTransactions = allRows.filter(
    (tx) => !["VOID", "UNRATED"].includes(tx.status || "") && Number(tx.amount || 0) > 0
  )
  const transactionRevenue = analyticsTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
  const analyticsRevenue = summary.totalRevenue > 0 ? summary.totalRevenue : transactionRevenue
  const analyticsBasis =
    invoices.length > 0
      ? "Invoice-based analytics"
      : analyticsTransactions.length > 0
        ? "Transaction-based preview"
        : "No billing data in selected filter"

  const transactionSourceMix = Object.entries(
    analyticsTransactions.reduce<Record<string, number>>((acc, tx) => {
      const key = tx.source_type || "UNKNOWN"
      acc[key] = (acc[key] || 0) + Number(tx.amount || 0)
      return acc
    }, {})
  ).map(([source_type, amount]) => ({ source_type, amount }))

  const transactionChargeMix = Object.entries(
    analyticsTransactions.reduce<Record<string, number>>((acc, tx) => {
      const key = tx.charge_type || "UNKNOWN"
      acc[key] = (acc[key] || 0) + Number(tx.amount || 0)
      return acc
    }, {})
  ).map(([charge_type, amount]) => ({ charge_type, amount }))

  const sourceMixData = (insights.sourceMix.length > 0 ? insights.sourceMix : transactionSourceMix).map((row) => ({
    name: toLabel(row.source_type),
    amount: Number(row.amount || 0),
  }))

  const chargeMixData = (insights.chargeMix.length > 0 ? insights.chargeMix : transactionChargeMix).map((row) => ({
    name: toLabel(row.charge_type),
    amount: Number(row.amount || 0),
  }))

  const waterfallData = sourceMixData.reduce<Array<{ name: string; offset: number; amount: number }>>((acc, item) => {
    const previous = acc.length === 0 ? 0 : acc[acc.length - 1].offset + acc[acc.length - 1].amount
    acc.push({ name: item.name, offset: previous, amount: item.amount })
    return acc
  }, [])
  if (analyticsRevenue > 0) {
    waterfallData.push({ name: "Total", offset: 0, amount: analyticsRevenue })
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

  const clientRollupSource =
    invoices.length > 0
      ? invoices.map((row) => ({
          client: row.client_name,
          amount: Number(row.total_amount || 0),
          pending: Number(row.balance || 0),
        }))
      : analyticsTransactions.map((row) => ({
          client: row.client_name,
          amount: Number(row.amount || 0),
          pending: 0,
        }))

  const clientRollup = clientRollupSource.reduce<Record<string, { count: number; amount: number; pending: number }>>((acc, row) => {
    const key = row.client || "Unknown"
    if (!acc[key]) acc[key] = { count: 0, amount: 0, pending: 0 }
    acc[key].count += 1
    acc[key].amount += row.amount
    acc[key].pending += row.pending
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

  const trendSource =
    invoices.length > 0
      ? invoices.map((row) => ({
          date: row.invoice_date,
          invoiced: Number(row.total_amount || 0),
          collected: Number(row.paid_amount || 0),
        }))
      : analyticsTransactions.map((row) => ({
          date: row.event_date,
          invoiced: Number(row.amount || 0),
          collected: 0,
        }))

  const trendMap = trendSource.reduce<Record<string, { invoiced: number; collected: number }>>((acc, row) => {
    const date = new Date(row.date)
    if (Number.isNaN(date.getTime())) return acc
    const key = date.toLocaleString("en-US", { month: "short", year: "2-digit" })
    if (!acc[key]) acc[key] = { invoiced: 0, collected: 0 }
    acc[key].invoiced += row.invoiced
    acc[key].collected += row.collected
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
    PAID: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
    PENDING: "bg-yellow-100 text-yellow-800 dark:bg-amber-900/40 dark:text-amber-200",
    OVERDUE: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  }

  const overdueCount = invoices.filter((bill) => bill.status === "OVERDUE").length
  const activeBillingProfiles = (billingProfilesQuery.data ?? []).filter((profile) => profile.is_active !== false)
  const activeProfileClientIds = new Set(activeBillingProfiles.map((profile) => Number(profile.client_id)))

  const exceptionRows: ExceptionRow[] = (() => {
    const rows: ExceptionRow[] = []
    const scopedClients =
      applied.clientFilter === "all"
        ? clients
        : clients.filter((client) => String(client.id) === applied.clientFilter)

    scopedClients.forEach((client) => {
      if (activeProfileClientIds.has(Number(client.id))) return
      rows.push({
        id: `missing-profile-${client.id}`,
        exceptionType: "Missing Billing Profile",
        severity: "HIGH",
        sourceRef: `CLIENT-${client.id}`,
        client: client.client_name,
        detectedOn: TODAY_ISO,
        status: "OPEN",
        owner: "Billing Ops",
      })
    })

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
  const activeProfileCount = activeBillingProfiles.length
  const clientsMissingProfile = Math.max(0, clients.length - activeProfileCount)
  const previewReady = Boolean(preview && preview.unratedTransactionCount === 0 && openExceptionCount === 0 && preview.billableTransactions > 0)
  const readinessCards = [
    { label: "Active Profiles", value: activeProfileCount, tone: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200" },
    { label: "Missing Profiles", value: clientsMissingProfile, tone: clientsMissingProfile > 0 ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200" },
    { label: "Unrated Tx", value: unratedRows.length, tone: unratedRows.length > 0 ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200" : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200" },
    { label: "Open Exceptions", value: openExceptionCount, tone: openExceptionCount > 0 ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200" },
    { label: "Preview Status", value: previewReady ? "Ready" : preview ? "Review" : "Pending", tone: previewReady ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  ]

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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Billing & Finance</h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">Billing operations and revenue analytics</p>
        </div>
        <Badge className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">Run preview before generation</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {readinessCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="pt-5">
              <p className="text-xs text-slate-500 dark:text-slate-400">{card.label}</p>
              <p className={`mt-2 inline-flex rounded-md px-2 py-1 text-xl font-semibold ${card.tone}`}>{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { key: "operations", label: "Operations" },
          { key: "preview", label: "Preview" },
          { key: "exceptions", label: "Exceptions" },
          { key: "analytics", label: "Analytics" },
        ].map((section) => (
          <Button
            key={section.key}
            variant={pageSection === section.key ? "default" : "outline"}
            size="sm"
            className={pageSection === section.key ? "bg-slate-950 text-white hover:bg-slate-900" : ""}
            onClick={() => {
              setPageSection(section.key as typeof pageSection)
              if (section.key === "exceptions") setWorkspaceTab("exceptions")
            }}
          >
            {section.label}
          </Button>
        ))}
      </div>

      {pageSection === "operations" ? (
      <>
      <Card>
        <CardHeader>
          <CardTitle>Billing Profile Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[260px]">
              <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Client</p>
              <Select
                value={effectiveProfileClientId || undefined}
                onValueChange={(value) => {
                  setProfileClientId(value)
                  setProfileDraft(null)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={String(client.id)}>
                      {client.client_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Badge className={selectedBillingProfile ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"}>
              {selectedBillingProfile ? "Existing Profile" : "New Profile"}
            </Badge>
          </div>

          {effectiveProfileClientId ? (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Billing Cycle</p>
                  <Select
                    value={resolvedProfileForm.billing_cycle}
                    onValueChange={(value) =>
                      setProfileDraft({
                        ...resolvedProfileForm,
                        billing_cycle: value as BillingProfileForm["billing_cycle"],
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="WEEKLY">WEEKLY</SelectItem>
                      <SelectItem value="MONTHLY">MONTHLY</SelectItem>
                      <SelectItem value="QUARTERLY">QUARTERLY</SelectItem>
                      <SelectItem value="YEARLY">YEARLY</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {resolvedProfileForm.billing_cycle === "WEEKLY" ? (
                  <div>
                    <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Billing Day of Week (1-7)</p>
                    <Input
                      type="number"
                      min="1"
                      max="7"
                      value={resolvedProfileForm.billing_day_of_week}
                      onChange={(e) => setProfileDraft({ ...resolvedProfileForm, billing_day_of_week: e.target.value })}
                    />
                  </div>
                ) : (
                  <div>
                    <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Billing Day of Month (1-28)</p>
                    <Input
                      type="number"
                      min="1"
                      max="28"
                      value={resolvedProfileForm.billing_day_of_month}
                      onChange={(e) => setProfileDraft({ ...resolvedProfileForm, billing_day_of_month: e.target.value })}
                    />
                  </div>
                )}
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Storage Billing Method</p>
                  <Select
                    value={resolvedProfileForm.storage_billing_method}
                    onValueChange={(value) =>
                      setProfileDraft({
                        ...resolvedProfileForm,
                        storage_billing_method: value as BillingProfileForm["storage_billing_method"],
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SNAPSHOT">SNAPSHOT</SelectItem>
                      <SelectItem value="DURATION">DURATION</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Storage Grace Days</p>
                  <Input
                    type="number"
                    min="0"
                    value={resolvedProfileForm.storage_grace_days}
                    onChange={(e) => setProfileDraft({ ...resolvedProfileForm, storage_grace_days: e.target.value })}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Credit Days</p>
                  <Input
                    type="number"
                    min="0"
                    value={resolvedProfileForm.credit_days}
                    onChange={(e) => setProfileDraft({ ...resolvedProfileForm, credit_days: e.target.value })}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Currency</p>
                  <Input
                    value={resolvedProfileForm.currency}
                    onChange={(e) => setProfileDraft({ ...resolvedProfileForm, currency: e.target.value.toUpperCase() })}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Invoice Prefix</p>
                  <Input
                    value={resolvedProfileForm.invoice_prefix}
                    onChange={(e) => setProfileDraft({ ...resolvedProfileForm, invoice_prefix: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Minimum Billing</p>
                  <Select
                    value={resolvedProfileForm.minimum_billing_enabled ? "YES" : "NO"}
                    onValueChange={(value) =>
                      setProfileDraft({
                        ...resolvedProfileForm,
                        minimum_billing_enabled: value === "YES",
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NO">Disabled</SelectItem>
                      <SelectItem value="YES">Enabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Minimum Billing Amount</p>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={!resolvedProfileForm.minimum_billing_enabled}
                    value={resolvedProfileForm.minimum_billing_amount}
                    onChange={(e) => setProfileDraft({ ...resolvedProfileForm, minimum_billing_amount: e.target.value })}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Auto Finalize</p>
                  <Select
                    value={resolvedProfileForm.auto_finalize ? "YES" : "NO"}
                    onValueChange={(value) =>
                      setProfileDraft({
                        ...resolvedProfileForm,
                        auto_finalize: value === "YES",
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NO">No</SelectItem>
                      <SelectItem value="YES">Yes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Profile Status</p>
                  <Select
                    value={resolvedProfileForm.is_active ? "ACTIVE" : "INACTIVE"}
                    onValueChange={(value) =>
                      setProfileDraft({
                        ...resolvedProfileForm,
                        is_active: value === "ACTIVE",
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                      <SelectItem value="INACTIVE">INACTIVE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setProfileDraft(null)
                  }}
                >
                  Reset
                </Button>
                <Button
                  className="bg-blue-600 hover:bg-blue-700"
                  disabled={saveBillingProfileMutation.isPending || billingProfilesQuery.isLoading}
                  onClick={() => {
                    if (!effectiveProfileClientId) {
                      toast.error("Select a client")
                      return
                    }
                    saveBillingProfileMutation.mutate()
                  }}
                >
                  {saveBillingProfileMutation.isPending ? "Saving..." : "Save Billing Profile"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">Create at least one active client to set billing profile.</p>
          )}
        </CardContent>
      </Card>

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
      </>
      ) : null}

      {pageSection === "preview" ? (
      <Card>
        <CardHeader>
          <CardTitle>Billing Run Preview</CardTitle>
        </CardHeader>
        <CardContent>
          {!preview ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Run preview to inspect scope, expected totals, and warnings before draft generation.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Billing Period</p><p className="font-semibold">{preview.periodFrom} to {preview.periodTo}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Client Scope</p><p className="font-semibold">{preview.clientScope}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Warehouse Scope</p><p className="font-semibold">{preview.warehouseScope}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Billable Tx</p><p className="font-semibold">{preview.billableTransactions}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Expected Invoices</p><p className="font-semibold">{preview.expectedInvoiceCount}</p></div>
                <div className="rounded border p-2 text-xs"><p className="text-slate-500 dark:text-slate-400">Expected Revenue</p><p className="font-semibold">{asInr(preview.expectedRevenue)}</p></div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded border p-3">
                  <p className="mb-2 text-sm font-semibold">Grouped Expected Totals by Client</p>
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50 dark:bg-slate-900">
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
      ) : null}

      {pageSection === "analytics" ? (
      <>
      <Card className="border-blue-100 bg-blue-50/60 dark:border-blue-900/50 dark:bg-blue-950/20">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">{analyticsBasis}</p>
            <p className="text-xs text-blue-700 dark:text-blue-200">
              Showing data for {applied.dateFrom} to {applied.dateTo}
              {applied.clientFilter !== "all" ? " with the selected client filter" : ""}
              {applied.warehouseFilter !== "all" ? " and warehouse filter" : ""}.
            </p>
          </div>
          <Badge className="bg-white text-blue-700 dark:bg-blue-900 dark:text-blue-100">
            {invoices.length > 0 ? `${invoices.length} invoices` : `${analyticsTransactions.length} billable transactions`}
          </Badge>
        </CardContent>
      </Card>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">{invoices.length > 0 ? "Total Revenue" : "Billable Value"}</p><p className="text-2xl font-semibold">{asInr(analyticsRevenue)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">Collected</p><p className="text-2xl font-semibold">{asInr(summary.totalPaid)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">Collection Rate</p><p className="text-2xl font-semibold">{insights.collectionEfficiencyPct.toFixed(1)}%</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">{invoices.length > 0 ? "Avg Invoice" : "Avg Transaction"}</p><p className="text-2xl font-semibold">{asInr(invoices.length > 0 ? insights.avgInvoiceValue : analyticsTransactions.length ? analyticsRevenue / analyticsTransactions.length : 0)}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">Days to Due</p><p className="text-2xl font-semibold">{avgDaysToDue}</p></CardContent></Card>
        <Card><CardContent className="pt-5"><p className="text-xs text-slate-500 dark:text-slate-400">Overdue Risk</p><p className="text-2xl font-semibold">{insights.overdueSharePct.toFixed(1)}%</p></CardContent></Card>
      </div>
      </>
      ) : null}

      {pageSection === "exceptions" ? (
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
                  <TableRow className="bg-slate-50 dark:bg-slate-900">
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
                      <TableCell className="text-xs text-slate-600 dark:text-slate-300">{tx.remarks || "Pending billing run"}</TableCell>
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
                      <TableCell colSpan={8} className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
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
                  <TableRow className="bg-slate-50 dark:bg-slate-900">
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
                      <TableCell className="text-xs text-slate-600 dark:text-slate-300">{tx.remarks || "No applicable rate rule found"}</TableCell>
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
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
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
                <TableRow className="bg-slate-50 dark:bg-slate-900">
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
                      <Badge className={ex.severity === "HIGH" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : ex.severity === "MEDIUM" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"}>
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
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200"
                            : ex.status === "IGNORED"
                              ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                              : ex.status === "REVIEW"
                                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
                                : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
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
                        <p className="mt-1 max-w-[340px] text-right text-[11px] text-slate-500 dark:text-slate-400">
                          {ex.rootCause ? `Cause: ${ex.rootCause}. ` : ""}
                          {ex.resolutionNote ? `Note: ${ex.resolutionNote}` : ""}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {exceptionDisplayRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                      No exceptions detected in selected period.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
      ) : null}

      {pageSection === "analytics" ? (
      <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Revenue by Source</CardTitle></CardHeader>
          <CardContent className="h-64">
            {sourceMixData.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No source mix available for this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sourceMixData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(value) => asInr(Number(value))} tick={{ fontSize: 11 }} />
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
              <p className="text-sm text-slate-500 dark:text-slate-400">No charge mix available for this filter.</p>
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
              <p className="text-sm text-slate-500 dark:text-slate-400">No revenue data available.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={waterfallData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(value) => asInr(Number(value))} tick={{ fontSize: 11 }} />
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
              <p className="text-sm text-slate-500 dark:text-slate-400">No client concentration data available.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid />
                  <XAxis type="number" dataKey="x" name="Invoices" allowDecimals={false} tick={{ fontSize: 10 }} />
                  <YAxis type="number" dataKey="y" name="Revenue" tickFormatter={(value) => asInr(Number(value))} tick={{ fontSize: 10 }} />
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
                    <span className="text-slate-600 dark:text-slate-300">{row.label}</span>
                    <span className="font-medium">{row.value}{row.unit}</span>
                  </div>
                  <div className="h-2 rounded bg-slate-100 dark:bg-slate-800">
                    <div className="h-2 rounded" style={{ width: `${width}%`, background: colors[index % colors.length] }} />
                  </div>
                </div>
              )
            })}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-slate-300">DO/GRN Ratio</span>
                <span className="font-medium">{doToGrnRatio.toFixed(1)}x</span>
              </div>
              <div className="h-2 rounded bg-slate-100 dark:bg-slate-800">
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
                <TableRow className="bg-slate-50 dark:bg-slate-900">
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
              <p className="text-sm text-slate-500 dark:text-slate-400">No trend data available for this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={(value) => asInr(Number(value))} tick={{ fontSize: 10 }} />
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
              <p className="text-sm text-slate-500 dark:text-slate-400">No pending revenue in this filter.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pendingByClientData} layout="vertical" margin={{ left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(value) => asInr(Number(value))} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="client" width={120} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(value: number | string | undefined) => asInr(Number(value ?? 0))} />
                  <Bar dataKey="pending" radius={[0, 4, 4, 0]} fill="#7c3aed" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
      </>
      ) : null}

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



