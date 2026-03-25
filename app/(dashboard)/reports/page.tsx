"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, BarChart3, Download, Loader2, Package, TrendingUp, Truck } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
import { Badge } from "@/components/ui/badge"

type StockSummaryRow = {
  client: string
  item: string
  in_stock: number
  reserved: number
  dispatched: number
  total: number
  value: number
}

type MovementRow = {
  date: string
  grn_count: number
  do_count: number
  gate_in: number
  gate_out: number
  items_received: number
  items_dispatched: number
  do_cases: number
  do_pallets: number
  do_weight_kg: number
}

type SlowMovingRow = {
  serial: string
  item: string
  client: string
  age_days: number
  status: string
  value: number
}

type AnalyticsRow = {
  name: string
  stock: number
  billing: number
  grns: number
  dos: number
}

type GateInReportRow = {
  id: number
  gate_in_number: string
  gate_in_datetime: string
  vehicle_number: string
  driver_name?: string
  driver_phone?: string
  transport_company?: string
  lr_number?: string
  lr_date?: string
  e_way_bill_number?: string
  e_way_bill_date?: string
  from_location?: string
  to_location?: string
  vehicle_type?: string
  vehicle_model?: string
  transported_by?: string
  vendor_name?: string
  transportation_remarks?: string
  client_name: string
  warehouse_name: string
}

const TODAY = new Date()
const TODAY_ISO = TODAY.toISOString().slice(0, 10)
const THIRTY_DAYS_AGO_ISO = new Date(TODAY.getTime() - 30 * 86400000).toISOString().slice(0, 10)

export default function ReportsPage() {
  const pageSize = 50
  const [reportType, setReportType] = useState("stock_summary")
  const [page, setPage] = useState(1)
  const [dateFrom, setDateFrom] = useState(THIRTY_DAYS_AGO_ISO)
  const [dateTo, setDateTo] = useState(TODAY_ISO)
  const [clientId, setClientId] = useState("all")
  const [applied, setApplied] = useState({ dateFrom, dateTo, clientId: "all" })

  const clientsQuery = useQuery({
    queryKey: ["clients", "active"],
    queryFn: async () => {
      const res = await apiClient.get<{ id: number; client_name: string }[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const stockSummaryQuery = useQuery({
    queryKey: ["reports", "stock-summary", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ mode: "summary", client_id: applied.clientId })
      const res = await apiClient.get<StockSummaryRow[]>(`/reports/stock?${q.toString()}`)
      return res.data ?? []
    },
  })

  const movementQuery = useQuery({
    queryKey: ["reports", "movement", applied],
    queryFn: async () => {
      const q = new URLSearchParams({
        date_from: applied.dateFrom,
        date_to: applied.dateTo,
      })
      const res = await apiClient.get<MovementRow[]>(`/reports/movements?${q.toString()}`)
      return res.data ?? []
    },
  })

  const slowQuery = useQuery({
    queryKey: ["reports", "slow", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ mode: "slow", client_id: applied.clientId })
      const res = await apiClient.get<SlowMovingRow[]>(`/reports/stock?${q.toString()}`)
      return res.data ?? []
    },
  })

  const analyticsQuery = useQuery({
    queryKey: ["reports", "analytics", applied.clientId],
    queryFn: async () => {
      const q = new URLSearchParams({ client_id: applied.clientId })
      const res = await apiClient.get<AnalyticsRow[]>(`/reports/analytics?${q.toString()}`)
      return res.data ?? []
    },
  })

  const gateInQuery = useQuery({
    queryKey: ["reports", "gate-in"],
    queryFn: async () => {
      const res = await apiClient.get<GateInReportRow[]>("/gate/in")
      return res.data ?? []
    },
  })

  const reportCards = [
    { id: "stock_summary", title: "Stock Summary", icon: Package, desc: "Current stock by client and item" },
    { id: "movement", title: "Daily Movement", icon: TrendingUp, desc: "GRN, DO, Gate movements" },
    { id: "gate_in", title: "Gate In Detail", icon: Truck, desc: "Transporter and route wise gate-in logs" },
    { id: "slow_moving", title: "Slow Moving", icon: AlertCircle, desc: "Items > 60 days in stock" },
    { id: "client_wise", title: "Client Analysis", icon: BarChart3, desc: "Client-wise stock and billing" },
  ]

  const isLoading =
    stockSummaryQuery.isLoading ||
    movementQuery.isLoading ||
    gateInQuery.isLoading ||
    slowQuery.isLoading ||
    analyticsQuery.isLoading

  const stockSummary = stockSummaryQuery.data ?? []
  const movementReport = movementQuery.data ?? []
  const slowMoving = slowQuery.data ?? []
  const analytics = analyticsQuery.data ?? []
  const gateInReport = gateInQuery.data ?? []

  const activeRowsCount = useMemo(() => {
    if (reportType === "stock_summary") return stockSummary.length
    if (reportType === "movement") return movementReport.length
    if (reportType === "gate_in") return gateInReport.length
    if (reportType === "slow_moving") return slowMoving.length
    if (reportType === "client_wise") return analytics.length
    return 0
  }, [reportType, stockSummary.length, movementReport.length, gateInReport.length, slowMoving.length, analytics.length])

  const totalPages = Math.max(1, Math.ceil(activeRowsCount / pageSize))
  const boundedPage = Math.min(page, totalPages)
  const rowStart = (boundedPage - 1) * pageSize
  const rowEnd = rowStart + pageSize

  const pagedStockSummary = stockSummary.slice(rowStart, rowEnd)
  const pagedMovement = movementReport.slice(rowStart, rowEnd)
  const pagedGateIn = gateInReport.slice(rowStart, rowEnd)
  const pagedSlowMoving = slowMoving.slice(rowStart, rowEnd)
  const pagedAnalytics = analytics.slice(rowStart, rowEnd)

  const ReportPagination = activeRowsCount > pageSize ? (
    <div className="mb-3 flex items-center justify-between text-sm text-gray-600">
      <p>
        Showing {activeRowsCount ? rowStart + 1 : 0}-{Math.min(rowEnd, activeRowsCount)} of {activeRowsCount}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={boundedPage <= 1}>
          Previous
        </Button>
        <span className="text-xs">
          Page {boundedPage} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={boundedPage >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  ) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Reports & Analytics</h1>
          <p className="mt-1 text-gray-500">Warehouse performance reports</p>
        </div>
        <Button variant="outline">
          <Download className="mr-2 h-4 w-4" />
          Export Current Report
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {reportCards.map((report) => (
          <Card
            key={report.id}
            className={`cursor-pointer transition-all hover:shadow-md ${
              reportType === report.id ? "border-2 border-blue-500 bg-blue-50" : "hover:border-gray-300"
            }`}
            onClick={() => {
              setReportType(report.id)
              setPage(1)
            }}
          >
            <CardContent className="pt-6">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                <report.icon className="h-5 w-5 text-blue-600" />
              </div>
              <p className="text-sm font-semibold">{report.title}</p>
              <p className="mt-1 text-xs text-gray-500">{report.desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <label className="mb-1 block text-sm text-gray-600">From Date</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm text-gray-600">To Date</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm text-gray-600">Client</label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger>
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
            </div>
            <Button
              className="bg-blue-600"
              onClick={() => {
                setApplied({ dateFrom, dateTo, clientId })
                setPage(1)
              }}
            >
              Generate Report
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {reportType === "stock_summary" && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Stock Summary Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ReportPagination}
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Client</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">In Stock</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Dispatched</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedStockSummary.map((row, i) => (
                  <TableRow key={`${row.client}-${row.item}-${i}`}>
                    <TableCell className="font-medium">{row.client}</TableCell>
                    <TableCell>{row.item}</TableCell>
                    <TableCell className="text-right text-green-600">{row.in_stock}</TableCell>
                    <TableCell className="text-right text-yellow-600">{row.reserved}</TableCell>
                    <TableCell className="text-right text-blue-600">{row.dispatched}</TableCell>
                    <TableCell className="text-right font-bold">{row.total}</TableCell>
                    <TableCell className="text-right font-bold text-blue-700">{`Rs ${Number(row.value).toLocaleString()}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {reportType === "movement" && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Daily Movement Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ReportPagination}
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">GRNs</TableHead>
                  <TableHead className="text-right">DOs</TableHead>
                  <TableHead className="text-right">Gate In</TableHead>
                  <TableHead className="text-right">Gate Out</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Dispatched</TableHead>
                  <TableHead className="text-right">DO Cases</TableHead>
                  <TableHead className="text-right">DO Pallets</TableHead>
                  <TableHead className="text-right">DO Weight (kg)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedMovement.map((row) => (
                  <TableRow key={row.date}>
                    <TableCell className="font-medium">{row.date}</TableCell>
                    <TableCell className="text-right">{row.grn_count}</TableCell>
                    <TableCell className="text-right">{row.do_count}</TableCell>
                    <TableCell className="text-right text-green-600">{row.gate_in}</TableCell>
                    <TableCell className="text-right text-blue-600">{row.gate_out}</TableCell>
                    <TableCell className="text-right font-medium text-green-700">{row.items_received}</TableCell>
                    <TableCell className="text-right font-medium text-blue-700">{row.items_dispatched}</TableCell>
                    <TableCell className="text-right">{row.do_cases}</TableCell>
                    <TableCell className="text-right">{row.do_pallets}</TableCell>
                    <TableCell className="text-right">{Number(row.do_weight_kg || 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {reportType === "gate_in" && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              Gate In Detailed Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ReportPagination}
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Gate In No</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Transporter</TableHead>
                  <TableHead>LR No/Date</TableHead>
                  <TableHead>E-Way Bill</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Vehicle Type/Model</TableHead>
                  <TableHead>Transported By</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Remarks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedGateIn.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.gate_in_number}</TableCell>
                    <TableCell>{row.vehicle_number}</TableCell>
                    <TableCell>{row.transport_company || row.driver_name || "-"}</TableCell>
                    <TableCell>{`${row.lr_number || "-"} / ${row.lr_date || "-"}`}</TableCell>
                    <TableCell>{`${row.e_way_bill_number || "-"} / ${row.e_way_bill_date || "-"}`}</TableCell>
                    <TableCell>{`${row.from_location || "-"} -> ${row.to_location || "-"}`}</TableCell>
                    <TableCell>{`${row.vehicle_type || "-"} / ${row.vehicle_model || "-"}`}</TableCell>
                    <TableCell>{row.transported_by || "-"}</TableCell>
                    <TableCell>{row.vendor_name || "-"}</TableCell>
                    <TableCell>{row.transportation_remarks || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {reportType === "slow_moving" && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              Slow Moving Items (60+ Days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ReportPagination}
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead>Serial Number</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Age (Days)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedSlowMoving.map((row) => (
                  <TableRow key={row.serial}>
                    <TableCell className="font-mono text-sm">{row.serial}</TableCell>
                    <TableCell>{row.item}</TableCell>
                    <TableCell>{row.client}</TableCell>
                    <TableCell className="text-right">
                      <span className="font-bold text-red-600">{row.age_days}</span>
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-green-100 text-green-800">{row.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{`Rs ${Number(row.value).toLocaleString()}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {reportType === "client_wise" && !isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Client-wise Analysis
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ReportPagination}
            <div className="grid gap-4">
              {pagedAnalytics.map((client) => (
                <div key={client.name} className="rounded-lg border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-semibold">{client.name}</h3>
                    <Badge className="bg-blue-100 text-blue-800">Active</Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-4 text-center">
                    <div className="rounded bg-blue-50 p-3">
                      <p className="text-xs text-gray-500">Stock Units</p>
                      <p className="text-xl font-bold text-blue-600">{client.stock}</p>
                    </div>
                    <div className="rounded bg-green-50 p-3">
                      <p className="text-xs text-gray-500">Billing</p>
                      <p className="text-xl font-bold text-green-600">{`Rs ${(Number(client.billing) / 1000).toFixed(1)}K`}</p>
                    </div>
                    <div className="rounded bg-purple-50 p-3">
                      <p className="text-xs text-gray-500">GRNs</p>
                      <p className="text-xl font-bold text-purple-600">{client.grns}</p>
                    </div>
                    <div className="rounded bg-orange-50 p-3">
                      <p className="text-xs text-gray-500">DOs</p>
                      <p className="text-xl font-bold text-orange-600">{client.dos}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
