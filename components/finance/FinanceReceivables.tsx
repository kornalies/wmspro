"use client"

import { Fragment, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  FileText,
  Loader2,
  Printer,
  Users,
  Wallet,
} from "lucide-react"
import Link from "next/link"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { exportReceivablesToExcel } from "@/lib/export-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

/**
 * Client-wise outstanding, aged.
 *
 * Kept out of FinanceInvoices deliberately: that component is already a
 * thousand-plus lines carrying the whole invoice lifecycle, and receivables is a
 * different job done by different people. This screen is read-only — recording a
 * payment stays on the invoices page so there is one mutation path.
 */

type AgingRow = {
  client_id: number
  client_name: string
  client_code: string | null
  open_invoices: number
  overdue_invoices: number
  oldest_due_date: string | null
  days_oldest: number
  billed: number
  collected: number
  credit_notes: number
  outstanding: number
  overdue: number
  current: number
  bucket_1_30: number
  bucket_31_60: number
  bucket_61_90: number
  bucket_90_plus: number
}

type Totals = Omit<AgingRow, "client_id" | "client_name" | "client_code" | "oldest_due_date"> & {
  clients: number
}

type OpenItem = {
  id: number
  invoice_number: string
  invoice_date: string
  due_date: string
  billing_period: string | null
  days_overdue: number
  grand_total: number
  paid_amount: number
  credit_note_total: number
  balance: number
  status: string
}

type ReceivablesPayload = {
  rows: AgingRow[]
  totals: Totals
  openItems: OpenItem[]
  asOf: string
}

type WarehouseOption = { id: number; warehouse_name: string; warehouse_code?: string }

type SortKey = "outstanding" | "bucket_90_plus" | "client_name" | "days_oldest"

const BUCKETS: Array<{ key: keyof AgingRow; label: string }> = [
  { key: "current", label: "Not due" },
  { key: "bucket_1_30", label: "1-30" },
  { key: "bucket_31_60", label: "31-60" },
  { key: "bucket_61_90", label: "61-90" },
  { key: "bucket_90_plus", label: "90+" },
]

const todayIso = new Date().toISOString().slice(0, 10)

export function FinanceReceivables() {
  const [asOf, setAsOf] = useState(todayIso)
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [sortKey, setSortKey] = useState<SortKey>("outstanding")
  const [criticalOnly, setCriticalOnly] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const receivablesQuery = useQuery({
    queryKey: ["finance", "receivables", { asOf, warehouseFilter }],
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (asOf) qp.set("as_of", asOf)
      if (warehouseFilter !== "all") qp.set("warehouse_id", warehouseFilter)
      const res = await apiClient.get<ReceivablesPayload>(`/finance/receivables?${qp.toString()}`)
      return res.data
    },
  })

  // The drill-down is its own request rather than a client-side slice: the list
  // query returns per-client aggregates, not the invoices behind them.
  const openItemsQuery = useQuery({
    queryKey: ["finance", "receivables", "open-items", { asOf, warehouseFilter, client: expanded }],
    enabled: expanded !== null,
    queryFn: async () => {
      const qp = new URLSearchParams()
      if (asOf) qp.set("as_of", asOf)
      if (warehouseFilter !== "all") qp.set("warehouse_id", warehouseFilter)
      qp.set("client_id", String(expanded))
      const res = await apiClient.get<ReceivablesPayload>(`/finance/receivables?${qp.toString()}`)
      return res.data?.openItems ?? []
    },
  })

  const rows = useMemo(() => {
    const all = receivablesQuery.data?.rows ?? []
    const filtered = criticalOnly ? all.filter((row) => row.bucket_90_plus > 0) : all
    return filtered.slice().sort((a, b) => {
      if (sortKey === "client_name") return a.client_name.localeCompare(b.client_name)
      return Number(b[sortKey]) - Number(a[sortKey])
    })
  }, [criticalOnly, receivablesQuery.data?.rows, sortKey])

  // Totals are folded from the rows actually shown, not taken from the payload —
  // the invoices page's outstanding tile ignores its own filter and reads wrong
  // next to a filtered table. This one cannot.
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.clients += 1
          acc.open_invoices += row.open_invoices
          acc.outstanding += row.outstanding
          acc.overdue += row.overdue
          acc.current += row.current
          acc.bucket_90_plus += row.bucket_90_plus
          acc.bucket_1_30 += row.bucket_1_30
          acc.bucket_31_60 += row.bucket_31_60
          acc.bucket_61_90 += row.bucket_61_90
          acc.days_oldest = Math.max(acc.days_oldest, row.days_oldest)
          return acc
        },
        {
          clients: 0,
          open_invoices: 0,
          outstanding: 0,
          overdue: 0,
          current: 0,
          bucket_1_30: 0,
          bucket_31_60: 0,
          bucket_61_90: 0,
          bucket_90_plus: 0,
          days_oldest: 0,
        }
      ),
    [rows]
  )

  const money = (value: number) =>
    `INR ${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

  const compactMoney = (value: number) => {
    const amount = Number(value || 0)
    if (Math.abs(amount) >= 100000) return `INR ${(amount / 100000).toFixed(1)}L`
    if (Math.abs(amount) >= 1000) return `INR ${(amount / 1000).toFixed(1)}k`
    return money(amount)
  }

  const fmtDate = (value: string | null) => {
    if (!value) return "-"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
  }

  /** Zero cells are muted so the eye lands on the buckets that actually carry money. */
  const bucketCell = (value: number, danger = false) => (
    <span className={value > 0 ? (danger ? "font-semibold text-red-700" : "text-gray-900") : "text-gray-300"}>
      {value > 0 ? money(value) : "-"}
    </span>
  )

  const kpis = [
    {
      label: "Total Outstanding",
      value: compactMoney(totals.outstanding),
      icon: Wallet,
      tint: "bg-blue-100 text-blue-600",
    },
    {
      label: "Overdue",
      value: compactMoney(totals.overdue),
      icon: AlertTriangle,
      tint: "bg-red-100 text-red-600",
    },
    {
      label: "Not Yet Due",
      value: compactMoney(totals.current),
      icon: Clock,
      tint: "bg-emerald-100 text-emerald-600",
    },
    {
      label: "Clients With Balance",
      value: String(totals.clients),
      icon: Users,
      tint: "bg-violet-100 text-violet-600",
    },
    {
      label: "Oldest Item",
      value: totals.days_oldest > 0 ? `${totals.days_oldest} days` : "None overdue",
      icon: Clock,
      tint: "bg-amber-100 text-amber-600",
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Receivables</h1>
          <p className="mt-1 text-gray-500">
            Client-wise outstanding, aged from the due date. Balances are net of credit notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              try {
                exportReceivablesToExcel(rows, asOf)
              } catch (error) {
                handleError(error, "Failed to export receivables")
              }
            }}
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button asChild variant="outline">
            <Link href="/finance/invoices">
              <FileText className="mr-2 h-4 w-4" />
              Invoices
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border bg-white p-4">
            <div className="flex items-center gap-3">
              <div className={`rounded-lg p-3 ${kpi.tint}`}>
                <kpi.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">{kpi.label}</p>
                <p className="text-2xl font-bold">{kpi.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-white shadow">
        <div className="flex flex-wrap items-end gap-3 border-b bg-gray-50 px-4 py-3">
          <div>
            <p className="mb-1 text-xs text-gray-500">As of</p>
            <Input
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value || todayIso)}
              className="h-9 w-[160px]"
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500">Warehouse</p>
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue placeholder="All warehouses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {(warehousesQuery.data ?? []).map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500">Sort by</p>
            <Select value={sortKey} onValueChange={(value) => setSortKey(value as SortKey)}>
              <SelectTrigger className="h-9 w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outstanding">Outstanding (high to low)</SelectItem>
                <SelectItem value="bucket_90_plus">90+ days (high to low)</SelectItem>
                <SelectItem value="days_oldest">Oldest item first</SelectItem>
                <SelectItem value="client_name">Client name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant={criticalOnly ? "default" : "outline"}
            className={criticalOnly ? "bg-red-600 hover:bg-red-700" : ""}
            onClick={() => setCriticalOnly((value) => !value)}
          >
            90+ days only
          </Button>
          <div className="ml-auto text-xs text-gray-500">
            Aged as at {fmtDate(receivablesQuery.data?.asOf ?? asOf)}
          </div>
        </div>

        {receivablesQuery.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            {criticalOnly
              ? "No client has anything more than 90 days overdue."
              : "Nothing outstanding. Every issued invoice is settled."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[26%]">Client</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead>Oldest Due</TableHead>
                  {BUCKETS.map((bucket) => (
                    <TableHead key={String(bucket.key)} className="text-right">
                      {bucket.label}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Statement</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isOpen = expanded === row.client_id
                  return (
                    <Fragment key={row.client_id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(isOpen ? null : row.client_id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 text-gray-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-gray-400" />
                            )}
                            <div>
                              <p className="font-medium">{row.client_name}</p>
                              <p className="text-xs text-gray-500">{row.client_code || "-"}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {row.open_invoices}
                          {row.overdue_invoices > 0 && (
                            <span className="ml-1 text-xs text-red-600">({row.overdue_invoices} od)</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{fmtDate(row.oldest_due_date)}</div>
                          {row.days_oldest > 0 && (
                            <Badge className="mt-1 bg-red-100 text-xs text-red-800">
                              {row.days_oldest}d overdue
                            </Badge>
                          )}
                        </TableCell>
                        {BUCKETS.map((bucket) => (
                          <TableCell key={String(bucket.key)} className="text-right">
                            {bucketCell(Number(row[bucket.key]), bucket.key === "bucket_90_plus")}
                          </TableCell>
                        ))}
                        <TableCell className="text-right font-semibold text-orange-700">
                          {money(row.outstanding)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            title={`Statement of account for ${row.client_name}`}
                            aria-label={`Statement of account for ${row.client_name}`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Link href={`/documents/client-statement/${row.client_id}?back=/finance/receivables`}>
                              <Printer className="h-4 w-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="bg-gray-50/60 hover:bg-gray-50/60">
                          <TableCell colSpan={10} className="p-0">
                            <div className="px-6 py-4">
                              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                                Open items — {row.client_name}
                              </p>
                              {openItemsQuery.isLoading ? (
                                <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                                  <Loader2 className="h-4 w-4 animate-spin" /> Loading open items…
                                </div>
                              ) : (
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Invoice</TableHead>
                                      <TableHead>Period</TableHead>
                                      <TableHead>Invoice Date</TableHead>
                                      <TableHead>Due Date</TableHead>
                                      <TableHead className="text-right">Days Overdue</TableHead>
                                      <TableHead className="text-right">Total</TableHead>
                                      <TableHead className="text-right">Paid / Credited</TableHead>
                                      <TableHead className="text-right">Balance</TableHead>
                                      <TableHead className="text-right">Invoice</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {(openItemsQuery.data ?? []).map((item) => (
                                      <TableRow key={item.id}>
                                        <TableCell className="font-medium">{item.invoice_number}</TableCell>
                                        <TableCell>{item.billing_period || "-"}</TableCell>
                                        <TableCell>{fmtDate(item.invoice_date)}</TableCell>
                                        <TableCell>{fmtDate(item.due_date)}</TableCell>
                                        <TableCell className="text-right">
                                          {item.days_overdue > 0 ? (
                                            <span className="font-medium text-red-700">{item.days_overdue}</span>
                                          ) : (
                                            <span className="text-gray-400">-</span>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right">{money(item.grand_total)}</TableCell>
                                        <TableCell className="text-right text-green-700">
                                          {money(item.paid_amount + item.credit_note_total)}
                                        </TableCell>
                                        <TableCell className="text-right font-semibold text-orange-700">
                                          {money(item.balance)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          <Button asChild variant="ghost" size="sm" title="Print invoice">
                                            <Link
                                              href={`/documents/commercial-invoice/${item.id}?back=/finance/receivables`}
                                            >
                                              <Printer className="h-4 w-4" />
                                            </Link>
                                          </Button>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                              <p className="mt-3 text-xs text-gray-500">
                                Record payments from the{" "}
                                <Link className="underline" href="/finance/invoices">
                                  invoices screen
                                </Link>
                                .
                              </p>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
                <TableRow className="border-t-2 bg-gray-50 font-semibold hover:bg-gray-50">
                  <TableCell>Total — {totals.clients} clients</TableCell>
                  <TableCell className="text-right">{totals.open_invoices}</TableCell>
                  <TableCell />
                  {BUCKETS.map((bucket) => (
                    <TableCell key={`total-${String(bucket.key)}`} className="text-right">
                      {money(Number(totals[bucket.key as keyof typeof totals]))}
                    </TableCell>
                  ))}
                  <TableCell className="text-right text-orange-700">{money(totals.outstanding)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
