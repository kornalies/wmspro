"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  BarChart3,
  Download,
  Edit,
  Gauge,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users2,
} from "lucide-react"

import { useAuth } from "@/hooks/use-auth"
import {
  useCreateLaborProductivity,
  useLaborAssignments,
  useLaborExceptions,
  useLaborMeta,
  useLaborProductivity,
  useLaborShifts,
  useLaborStandards,
  useUpsertLaborAssignment,
  useUpsertLaborShift,
  useUpsertLaborStandard,
} from "@/hooks/use-labor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type LaborStandard = {
  id: number
  operation_code: string
  operation_name: string
  unit_of_measure: string
  standard_units_per_hour: number
  warning_threshold_pct: number
  critical_threshold_pct: number
  is_active: boolean
  created_at?: string
  updated_at?: string
}

type LaborShift = {
  id: number
  shift_code: string
  shift_name: string
  warehouse_id?: number | null
  warehouse_name?: string | null
  start_time: string
  end_time: string
  planned_headcount: number
  assigned_headcount: number
  break_minutes?: number
  is_overnight?: boolean
}

type LaborAssignment = {
  id: number
  shift_id: number
  shift_name: string
  shift_date: string
  user_id: number
  user_name: string
  assignment_role: string
  assignment_status: string
  remarks?: string | null
}

type ProductivityRow = {
  id: number
  event_ts: string
  operation_code: string
  operation_name: string
  shift_id?: number | null
  shift_name?: string | null
  user_id?: number | null
  user_name?: string | null
  quantity: number
  duration_minutes: number
  actual_units_per_hour: number
  standard_units_per_hour: number
  performance_pct: number
  quality_score?: number | null
  notes?: string | null
}

type ExceptionRow = {
  id: number
  event_ts: string
  user_name?: string | null
  shift_name?: string | null
  operation_name: string
  performance_pct: number
  actual_units_per_hour: number
  standard_units_per_hour: number
  warning_threshold_pct: number
  critical_threshold_pct: number
  severity: "CRITICAL" | "WARNING" | "NORMAL"
}

type MetaPayload = {
  users?: Array<{ id: number; full_name: string }>
  warehouses?: Array<{ id: number; warehouse_name: string }>
  shifts?: Array<{ id: number; shift_name: string }>
  standards?: Array<{ id: number; operation_code: string; operation_name: string; unit_of_measure: string }>
}

const todayIso = new Date().toISOString().slice(0, 10)

function blankStandardForm() {
  return {
    operation_code: "",
    operation_name: "",
    unit_of_measure: "UNITS",
    standard_units_per_hour: "",
    warning_threshold_pct: "85",
    critical_threshold_pct: "65",
  }
}

function blankShiftForm() {
  return {
    shift_code: "",
    shift_name: "",
    warehouse_id: "none",
    start_time: "09:00",
    end_time: "18:00",
    planned_headcount: "6",
    break_minutes: "30",
  }
}

function toNumber(value: unknown) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

function performanceStatus(performance: number, warning = 85, critical = 65) {
  if (performance < critical) return "CRITICAL"
  if (performance < warning) return "WARNING"
  return "ON_TARGET"
}

function performanceBadge(status: string) {
  if (status === "CRITICAL") return "bg-red-100 text-red-800"
  if (status === "WARNING") return "bg-amber-100 text-amber-800"
  return "bg-emerald-100 text-emerald-800"
}

function shiftStatus(shift: LaborShift) {
  const assigned = toNumber(shift.assigned_headcount)
  const planned = toNumber(shift.planned_headcount)
  if (assigned <= 0) return "Open"
  if (assigned < planned) return "Partially Assigned"
  return "Fully Assigned"
}

function downloadCsv(fileName: string, headers: string[], rows: Array<Array<unknown>>) {
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function MiniBar({ value, tone = "blue" }: { value: number; tone?: "blue" | "red" | "amber" | "emerald" }) {
  const color = {
    blue: "bg-blue-600",
    red: "bg-red-600",
    amber: "bg-amber-500",
    emerald: "bg-emerald-600",
  }[tone]
  return (
    <div className="h-2 rounded-full bg-slate-100">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export default function LaborPage() {
  const { user } = useAuth()
  const canManageLabor =
    user?.role === "SUPER_ADMIN" ||
    user?.permissions?.includes("labor.manage") ||
    user?.permissions?.includes("do.manage")

  const [activeTab, setActiveTab] = useState("overview")
  const [from, setFrom] = useState(todayIso)
  const [to, setTo] = useState(todayIso)
  const [selectedDate, setSelectedDate] = useState(todayIso)
  const [warehouseFilter, setWarehouseFilter] = useState("all")
  const [shiftFilter, setShiftFilter] = useState("all")
  const [userFilter, setUserFilter] = useState("all")
  const [applied, setApplied] = useState({
    from: todayIso,
    to: todayIso,
    warehouseId: "all",
    shiftId: "all",
    userId: "all",
  })

  const [standardDialogOpen, setStandardDialogOpen] = useState(false)
  const [standardForm, setStandardForm] = useState(blankStandardForm())
  const [shiftDialogOpen, setShiftDialogOpen] = useState(false)
  const [shiftForm, setShiftForm] = useState(blankShiftForm())
  const [assignmentShiftId, setAssignmentShiftId] = useState("none")
  const [assignmentUserId, setAssignmentUserId] = useState("none")
  const [assignmentRole, setAssignmentRole] = useState("OPERATOR")

  const [prodStandardId, setProdStandardId] = useState("none")
  const [prodShiftId, setProdShiftId] = useState("none")
  const [prodUserId, setProdUserId] = useState("none")
  const [prodQty, setProdQty] = useState("")
  const [prodDuration, setProdDuration] = useState("")
  const [prodSourceRef, setProdSourceRef] = useState("")
  const [prodNotes, setProdNotes] = useState("")

  const metaQuery = useLaborMeta()
  const standardsQuery = useLaborStandards(true)
  const shiftsQuery = useLaborShifts(selectedDate, applied.warehouseId)
  const assignmentsQuery = useLaborAssignments(selectedDate)
  const productivityQuery = useLaborProductivity(applied.from, applied.to, {
    userId: applied.userId,
    shiftId: applied.shiftId,
    warehouseId: applied.warehouseId,
  })
  const exceptionsQuery = useLaborExceptions(applied.from, applied.to, {
    userId: applied.userId,
    shiftId: applied.shiftId,
    warehouseId: applied.warehouseId,
  })

  const upsertStandard = useUpsertLaborStandard()
  const upsertShift = useUpsertLaborShift()
  const upsertAssignment = useUpsertLaborAssignment()
  const createProductivity = useCreateLaborProductivity()

  const meta = (metaQuery.data?.data as MetaPayload | undefined) ?? {}
  const users = meta.users ?? []
  const warehouses = meta.warehouses ?? []
  const metaShifts = meta.shifts ?? []
  const standards = useMemo(() => (standardsQuery.data?.data as LaborStandard[] | undefined) ?? [], [standardsQuery.data])
  const shifts = useMemo(() => (shiftsQuery.data?.data as LaborShift[] | undefined) ?? [], [shiftsQuery.data])
  const assignments = useMemo(
    () => (assignmentsQuery.data?.data as LaborAssignment[] | undefined) ?? [],
    [assignmentsQuery.data]
  )
  const productivityRows = useMemo(
    () => (productivityQuery.data?.data as ProductivityRow[] | undefined) ?? [],
    [productivityQuery.data]
  )
  const exceptionsPayload = (exceptionsQuery.data?.data as {
    summary?: {
      critical_count: number
      warning_count: number
      avg_performance_pct: number
      total_records: number
      top_exception_operations?: Array<{ operation_name: string; count: number }>
    }
    rows?: ExceptionRow[]
    shift_headcount_gaps?: Array<{
      shift_id: number
      shift_name: string
      planned_headcount: number
      assigned_headcount: number
      headcount_gap: number
    }>
  }) || { rows: [], shift_headcount_gaps: [] }

  const selectedStandard = standards.find((standard) => String(standard.id) === prodStandardId)
  const plannedUnitsPerHour = toNumber(selectedStandard?.standard_units_per_hour)
  const actualUnitsPerHour =
    toNumber(prodQty) > 0 && toNumber(prodDuration) > 0 ? (toNumber(prodQty) / toNumber(prodDuration)) * 60 : 0
  const projectedPerformance = plannedUnitsPerHour > 0 ? (actualUnitsPerHour / plannedUnitsPerHour) * 100 : 0
  const projectedStatus = performanceStatus(
    projectedPerformance,
    toNumber(selectedStandard?.warning_threshold_pct || 85),
    toNumber(selectedStandard?.critical_threshold_pct || 65)
  )

  const canApplyRange = from <= to
  const isBusy = metaQuery.isLoading || standardsQuery.isLoading || shiftsQuery.isLoading || assignmentsQuery.isLoading
  const totalAssigned = shifts.reduce((sum, shift) => sum + toNumber(shift.assigned_headcount), 0)
  const totalPlanned = shifts.reduce((sum, shift) => sum + toNumber(shift.planned_headcount), 0)
  const avgProductivity = productivityRows.length
    ? productivityRows.reduce((sum, row) => sum + toNumber(row.performance_pct), 0) / productivityRows.length
    : 0
  const coveragePct = totalPlanned > 0 ? (totalAssigned / totalPlanned) * 100 : 0

  const analytics = useMemo(() => {
    const byDate = new Map<string, { total: number; count: number }>()
    const byOperation = new Map<string, { total: number; count: number }>()
    const byUser = new Map<string, { total: number; count: number }>()
    for (const row of productivityRows) {
      const day = new Date(row.event_ts).toISOString().slice(0, 10)
      const date = byDate.get(day) || { total: 0, count: 0 }
      date.total += toNumber(row.performance_pct)
      date.count += 1
      byDate.set(day, date)

      const operation = byOperation.get(row.operation_name) || { total: 0, count: 0 }
      operation.total += toNumber(row.performance_pct)
      operation.count += 1
      byOperation.set(row.operation_name, operation)

      const userName = row.user_name || "Unassigned"
      const userRow = byUser.get(userName) || { total: 0, count: 0 }
      userRow.total += toNumber(row.performance_pct)
      userRow.count += 1
      byUser.set(userName, userRow)
    }
    return {
      trend: Array.from(byDate.entries()).map(([label, value]) => ({
        label,
        value: value.count ? value.total / value.count : 0,
      })),
      operations: Array.from(byOperation.entries())
        .map(([label, value]) => ({ label, value: value.count ? value.total / value.count : 0 }))
        .sort((a, b) => a.value - b.value)
        .slice(0, 5),
      users: Array.from(byUser.entries())
        .map(([label, value]) => ({ label, value: value.count ? value.total / value.count : 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5),
    }
  }, [productivityRows])

  const exportUrl = (mode: "exceptions" | "productivity") => {
    const params = new URLSearchParams({
      mode,
      from: applied.from,
      to: applied.to,
      warehouse_id: applied.warehouseId === "all" ? "0" : applied.warehouseId,
      shift_id: applied.shiftId === "all" ? "0" : applied.shiftId,
      user_id: applied.userId === "all" ? "0" : applied.userId,
    })
    return `/api/labor/export?${params.toString()}`
  }

  const submitStandard = () => {
    upsertStandard.mutate(
      {
        operation_code: standardForm.operation_code,
        operation_name: standardForm.operation_name,
        standard_units_per_hour: Number(standardForm.standard_units_per_hour),
        unit_of_measure: standardForm.unit_of_measure,
        warning_threshold_pct: Number(standardForm.warning_threshold_pct),
        critical_threshold_pct: Number(standardForm.critical_threshold_pct),
      },
      {
        onSuccess: () => {
          setStandardForm(blankStandardForm())
          setStandardDialogOpen(false)
        },
      }
    )
  }

  const submitShift = () => {
    upsertShift.mutate(
      {
        shift_code: shiftForm.shift_code,
        shift_name: shiftForm.shift_name,
        warehouse_id: shiftForm.warehouse_id === "none" ? undefined : Number(shiftForm.warehouse_id),
        start_time: shiftForm.start_time,
        end_time: shiftForm.end_time,
        planned_headcount: Number(shiftForm.planned_headcount || 1),
        break_minutes: Number(shiftForm.break_minutes || 0),
        is_overnight: shiftForm.end_time < shiftForm.start_time,
      },
      {
        onSuccess: () => {
          setShiftForm(blankShiftForm())
          setShiftDialogOpen(false)
        },
      }
    )
  }

  if (isBusy) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Labor Management</h1>
          <p className="mt-1 text-gray-500">Workforce control tower for standards, coverage, productivity, and exceptions.</p>
          <p className="mt-2 text-xs text-gray-500">
            Last updated {formatDateTime(new Date().toISOString())}. All labor actions are tenant scoped and audited.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="outline" onClick={() => window.open(exportUrl("exceptions"), "_blank")}>
            <Download className="mr-2 h-4 w-4" />
            Export Exceptions
          </Button>
          <Button variant="outline" onClick={() => window.open(exportUrl("productivity"), "_blank")}>
            <Download className="mr-2 h-4 w-4" />
            Export Productivity
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              standardsQuery.refetch()
              shiftsQuery.refetch()
              assignmentsQuery.refetch()
              productivityQuery.refetch()
              exceptionsQuery.refetch()
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-6">
          <div>
            <Label className="text-xs">Warehouse</Label>
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Shift</Label>
            <Select value={shiftFilter} onValueChange={setShiftFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shifts</SelectItem>
                {metaShifts.map((shift) => (
                  <SelectItem key={shift.id} value={String(shift.id)}>
                    {shift.shift_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">User</Label>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All users</SelectItem>
                {users.map((laborUser) => (
                  <SelectItem key={laborUser.id} value={String(laborUser.id)}>
                    {laborUser.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <Button
            disabled={!canApplyRange}
            onClick={() =>
              setApplied({
                from,
                to,
                warehouseId: warehouseFilter,
                shiftId: shiftFilter,
                userId: userFilter,
              })
            }
            className="self-end bg-blue-600 hover:bg-blue-700"
          >
            Apply Filters
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Standards", value: standards.length, detail: "active operations", icon: Gauge, tone: "blue" as const },
          { label: "Coverage", value: `${coveragePct.toFixed(0)}%`, detail: `${totalAssigned}/${totalPlanned} assigned`, icon: Users2, tone: "emerald" as const },
          { label: "Critical Exceptions", value: exceptionsPayload.summary?.critical_count || 0, detail: "open in range", icon: AlertTriangle, tone: "red" as const },
          { label: "Avg Productivity", value: `${avgProductivity.toFixed(1)}%`, detail: "vs target", icon: BarChart3, tone: "amber" as const },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">{stat.label}</p>
                <stat.icon className={`h-4 w-4 ${stat.tone === "red" ? "text-red-600" : stat.tone === "emerald" ? "text-emerald-600" : stat.tone === "amber" ? "text-amber-600" : "text-blue-600"}`} />
              </div>
              <p className="mt-2 text-2xl font-bold">{stat.value}</p>
              <p className="mt-1 text-xs text-gray-500">{stat.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {!canManageLabor && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>View-only access</AlertTitle>
          <AlertDescription>You can review labor metrics, but standards, shifts, assignments, and capture actions require labor management permission.</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="standards">Standards</TabsTrigger>
          <TabsTrigger value="shifts">Shifts</TabsTrigger>
          <TabsTrigger value="capture">Productivity</TabsTrigger>
          <TabsTrigger value="exceptions">Exceptions</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Shift Coverage</CardTitle>
                <CardDescription>Planned versus assigned capacity for the selected date.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <MiniBar value={coveragePct} tone={coveragePct >= 100 ? "emerald" : coveragePct >= 75 ? "amber" : "red"} />
                <div className="grid gap-2 md:grid-cols-2">
                  {shifts.slice(0, 6).map((shift) => (
                    <div key={shift.id} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{shift.shift_name}</p>
                        <Badge className={shiftStatus(shift) === "Fully Assigned" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>
                          {shiftStatus(shift)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">{shift.start_time} - {shift.end_time}</p>
                      <p className="mt-2 text-sm">{shift.assigned_headcount}/{shift.planned_headcount} assigned</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Exception Snapshot</CardTitle>
                <CardDescription>Severity and SLA-style operational attention.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(exceptionsPayload.rows || []).slice(0, 5).map((row) => (
                  <div key={row.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{row.operation_name}</p>
                      <p className="text-xs text-gray-500">{row.user_name || "Unassigned"} - {formatDateTime(row.event_ts)}</p>
                    </div>
                    <Badge className={performanceBadge(row.severity)}>{row.severity}</Badge>
                  </div>
                ))}
                {(exceptionsPayload.rows || []).length === 0 && (
                  <div className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">
                    No productivity exceptions in the selected range.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="standards" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle className="text-base">Labor Standards</CardTitle>
                  <CardDescription>Versioned target rates and thresholds for operational work types.</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        "labor_standards.csv",
                        ["operation_code", "operation_name", "uom", "standard_units_per_hour", "warning_pct", "critical_pct"],
                        standards.map((row) => [
                          row.operation_code,
                          row.operation_name,
                          row.unit_of_measure,
                          row.standard_units_per_hour,
                          row.warning_threshold_pct,
                          row.critical_threshold_pct,
                        ])
                      )
                    }
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Standards
                  </Button>
                  <Button disabled={!canManageLabor} onClick={() => setStandardDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="mr-2 h-4 w-4" />
                    New Standard
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>UOM</TableHead>
                    <TableHead className="text-right">Std/Hour</TableHead>
                    <TableHead className="text-right">Warn %</TableHead>
                    <TableHead className="text-right">Crit %</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {standards.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">{row.operation_code}</TableCell>
                      <TableCell>{row.operation_name}</TableCell>
                      <TableCell>{row.unit_of_measure}</TableCell>
                      <TableCell className="text-right">{row.standard_units_per_hour}</TableCell>
                      <TableCell className="text-right">{row.warning_threshold_pct}</TableCell>
                      <TableCell className="text-right">{row.critical_threshold_pct}</TableCell>
                      <TableCell>
                        <Badge className={row.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-800"}>
                          {row.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canManageLabor}
                          onClick={() => {
                            setStandardForm({
                              operation_code: row.operation_code,
                              operation_name: row.operation_name,
                              unit_of_measure: row.unit_of_measure,
                              standard_units_per_hour: String(row.standard_units_per_hour),
                              warning_threshold_pct: String(row.warning_threshold_pct),
                              critical_threshold_pct: String(row.critical_threshold_pct),
                            })
                            setStandardDialogOpen(true)
                          }}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="shifts" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <CardTitle className="text-base">Shifts & Capacity</CardTitle>
                    <CardDescription>Plan staffing, detect gaps, and prevent unmanaged coverage risk.</CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input className="w-[155px]" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
                    <Button disabled={!canManageLabor} onClick={() => setShiftDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700">
                      <Plus className="mr-2 h-4 w-4" />
                      New Shift
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Shift</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead>Window</TableHead>
                      <TableHead className="text-right">Planned</TableHead>
                      <TableHead className="text-right">Assigned</TableHead>
                      <TableHead className="text-right">Gap</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shifts.map((row) => {
                      const gap = toNumber(row.planned_headcount) - toNumber(row.assigned_headcount)
                      return (
                        <TableRow key={row.id}>
                          <TableCell>
                            <p className="font-medium">{row.shift_name}</p>
                            <p className="font-mono text-xs text-gray-500">{row.shift_code}</p>
                          </TableCell>
                          <TableCell>{row.warehouse_name || "All warehouses"}</TableCell>
                          <TableCell>{row.start_time} - {row.end_time}</TableCell>
                          <TableCell className="text-right">{row.planned_headcount}</TableCell>
                          <TableCell className="text-right">{row.assigned_headcount}</TableCell>
                          <TableCell className={`text-right font-medium ${gap > 0 ? "text-red-600" : "text-emerald-600"}`}>{gap}</TableCell>
                          <TableCell>
                            <Badge className={shiftStatus(row) === "Fully Assigned" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>
                              {shiftStatus(row)}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assignments</CardTitle>
                <CardDescription>Assign operators and leads to selected day shifts.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Select value={assignmentShiftId} onValueChange={setAssignmentShiftId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select shift" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Select shift</SelectItem>
                      {shifts.map((shift) => (
                        <SelectItem key={shift.id} value={String(shift.id)}>
                          {shift.shift_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={assignmentUserId} onValueChange={setAssignmentUserId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select user" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Select user</SelectItem>
                      {users.map((laborUser) => (
                        <SelectItem key={laborUser.id} value={String(laborUser.id)}>
                          {laborUser.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={assignmentRole} onValueChange={setAssignmentRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OPERATOR">Operator</SelectItem>
                      <SelectItem value="LEAD">Lead</SelectItem>
                      <SelectItem value="SUPERVISOR">Supervisor</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={!canManageLabor || upsertAssignment.isPending || assignmentShiftId === "none" || assignmentUserId === "none"}
                    onClick={() =>
                      upsertAssignment.mutate({
                        shift_id: Number(assignmentShiftId),
                        shift_date: selectedDate,
                        user_id: Number(assignmentUserId),
                        assignment_role: assignmentRole,
                        assignment_status: "ASSIGNED",
                      })
                    }
                  >
                    Assign User
                  </Button>
                  {(!canManageLabor || assignmentShiftId === "none" || assignmentUserId === "none") && (
                    <p className="text-xs text-gray-500">Select a shift and user. Labor management permission is required.</p>
                  )}
                </div>
                <div className="space-y-2">
                  {assignments.slice(0, 10).map((row) => (
                    <div key={row.id} className="flex items-center justify-between rounded border p-2 text-sm">
                      <span>{row.shift_name} - {row.user_name}</span>
                      <Badge className="bg-slate-100 text-slate-700">{row.assignment_role}</Badge>
                    </div>
                  ))}
                  {assignments.length === 0 && <p className="text-sm text-gray-500">No assignments for the selected date.</p>}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="capture" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Productivity Capture</CardTitle>
              <CardDescription>Quick entry with live performance calculation before saving.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-3">
                <Select value={prodStandardId} onValueChange={setProdStandardId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Standard" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select standard</SelectItem>
                    {standards.map((standard) => (
                      <SelectItem key={standard.id} value={String(standard.id)}>
                        {standard.operation_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={prodShiftId} onValueChange={setProdShiftId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Shift" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No shift</SelectItem>
                    {shifts.map((shift) => (
                      <SelectItem key={shift.id} value={String(shift.id)}>
                        {shift.shift_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={prodUserId} onValueChange={setProdUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="User" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No user</SelectItem>
                    {users.map((laborUser) => (
                      <SelectItem key={laborUser.id} value={String(laborUser.id)}>
                        {laborUser.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="number" min={0} placeholder="Quantity" value={prodQty} onChange={(event) => setProdQty(event.target.value)} />
                <Input type="number" min={0} placeholder="Minutes" value={prodDuration} onChange={(event) => setProdDuration(event.target.value)} />
                <Input placeholder="Source ref or scan ID" value={prodSourceRef} onChange={(event) => setProdSourceRef(event.target.value)} />
                <Input className="lg:col-span-2" placeholder="Notes" value={prodNotes} onChange={(event) => setProdNotes(event.target.value)} />
                <Button
                  disabled={!canManageLabor || createProductivity.isPending || prodStandardId === "none" || toNumber(prodQty) <= 0 || toNumber(prodDuration) <= 0}
                  onClick={() =>
                    createProductivity.mutate(
                      {
                        standard_id: Number(prodStandardId),
                        shift_id: prodShiftId === "none" ? undefined : Number(prodShiftId),
                        user_id: prodUserId === "none" ? undefined : Number(prodUserId),
                        source_type: prodSourceRef ? "SCAN" : "MANUAL",
                        source_ref: prodSourceRef || undefined,
                        quantity: Number(prodQty),
                        duration_minutes: Number(prodDuration),
                        notes: prodNotes || undefined,
                      },
                      {
                        onSuccess: () => {
                          setProdQty("")
                          setProdDuration("")
                          setProdSourceRef("")
                          setProdNotes("")
                        },
                      }
                    )
                  }
                >
                  Record
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-gray-500">Standard UPH</p>
                  <p className="text-lg font-semibold">{plannedUnitsPerHour.toFixed(2)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-gray-500">Actual UPH</p>
                  <p className="text-lg font-semibold">{actualUnitsPerHour.toFixed(2)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-gray-500">Performance</p>
                  <p className="text-lg font-semibold">{projectedPerformance.toFixed(1)}%</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-gray-500">Threshold</p>
                  <Badge className={performanceBadge(projectedStatus)}>{projectedStatus}</Badge>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Minutes</TableHead>
                    <TableHead className="text-right">Actual UPH</TableHead>
                    <TableHead className="text-right">Perf %</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productivityRows.slice(0, 15).map((row) => {
                    const status = performanceStatus(toNumber(row.performance_pct))
                    return (
                      <TableRow key={row.id}>
                        <TableCell>{formatDateTime(row.event_ts)}</TableCell>
                        <TableCell>{row.operation_name}</TableCell>
                        <TableCell>{row.user_name || "-"}</TableCell>
                        <TableCell className="text-right">{row.quantity}</TableCell>
                        <TableCell className="text-right">{row.duration_minutes}</TableCell>
                        <TableCell className="text-right">{row.actual_units_per_hour}</TableCell>
                        <TableCell className="text-right">{row.performance_pct}%</TableCell>
                        <TableCell>
                          <Badge className={performanceBadge(status)}>{status}</Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="exceptions" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Exception Dashboard</CardTitle>
                <CardDescription>Severity, owner, age, related shift, and resolution state.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Age</TableHead>
                      <TableHead>Operation</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Shift</TableHead>
                      <TableHead className="text-right">Perf %</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Resolution</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(exceptionsPayload.rows || []).slice(0, 25).map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{formatDateTime(row.event_ts)}</TableCell>
                        <TableCell>{row.operation_name}</TableCell>
                        <TableCell>{row.user_name || "Unassigned"}</TableCell>
                        <TableCell>{row.shift_name || "-"}</TableCell>
                        <TableCell className="text-right">{row.performance_pct}%</TableCell>
                        <TableCell>
                          <Badge className={performanceBadge(row.severity)}>{row.severity}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={row.severity === "NORMAL" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-800"}>
                            {row.severity === "NORMAL" ? "Resolved" : "Open"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Shift Gaps</CardTitle>
                <CardDescription>Capacity risks from planned versus assigned headcount.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(exceptionsPayload.shift_headcount_gaps || []).map((row) => (
                  <div key={row.shift_id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{row.shift_name}</p>
                      <Badge className={row.headcount_gap > 0 ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}>
                        Gap {row.headcount_gap}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">{row.assigned_headcount}/{row.planned_headcount} assigned</p>
                    <div className="mt-2">
                      <MiniBar value={row.planned_headcount ? (row.assigned_headcount / row.planned_headcount) * 100 : 0} tone={row.headcount_gap > 0 ? "amber" : "emerald"} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Productivity Trend</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {analytics.trend.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span>{row.label}</span>
                      <span>{row.value.toFixed(1)}%</span>
                    </div>
                    <MiniBar value={row.value} tone={row.value >= 85 ? "emerald" : row.value >= 65 ? "amber" : "red"} />
                  </div>
                ))}
                {!analytics.trend.length && <p className="text-sm text-gray-500">No productivity records in range.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Underperforming Operations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {analytics.operations.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span>{row.label}</span>
                      <span>{row.value.toFixed(1)}%</span>
                    </div>
                    <MiniBar value={row.value} tone={row.value >= 85 ? "emerald" : row.value >= 65 ? "amber" : "red"} />
                  </div>
                ))}
                {!analytics.operations.length && <p className="text-sm text-gray-500">No operation performance data yet.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">User Productivity Ranking</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {analytics.users.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span>{row.label}</span>
                      <span>{row.value.toFixed(1)}%</span>
                    </div>
                    <MiniBar value={row.value} tone={row.value >= 85 ? "emerald" : row.value >= 65 ? "amber" : "red"} />
                  </div>
                ))}
                {!analytics.users.length && <p className="text-sm text-gray-500">No user productivity records yet.</p>}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={standardDialogOpen} onOpenChange={setStandardDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Labor Standard</DialogTitle>
            <DialogDescription>Define operation targets, unit of measure, and exception thresholds.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Operation Code</Label>
              <Input value={standardForm.operation_code} onChange={(event) => setStandardForm({ ...standardForm, operation_code: event.target.value.toUpperCase() })} />
            </div>
            <div className="space-y-2">
              <Label>Operation Name</Label>
              <Input value={standardForm.operation_name} onChange={(event) => setStandardForm({ ...standardForm, operation_name: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>UOM</Label>
              <Input value={standardForm.unit_of_measure} onChange={(event) => setStandardForm({ ...standardForm, unit_of_measure: event.target.value.toUpperCase() })} />
            </div>
            <div className="space-y-2">
              <Label>Standard Units / Hour</Label>
              <Input type="number" min={0} value={standardForm.standard_units_per_hour} onChange={(event) => setStandardForm({ ...standardForm, standard_units_per_hour: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Warning %</Label>
              <Input type="number" min={1} value={standardForm.warning_threshold_pct} onChange={(event) => setStandardForm({ ...standardForm, warning_threshold_pct: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Critical %</Label>
              <Input type="number" min={1} value={standardForm.critical_threshold_pct} onChange={(event) => setStandardForm({ ...standardForm, critical_threshold_pct: event.target.value })} />
            </div>
          </div>
          {Number(standardForm.critical_threshold_pct) > Number(standardForm.warning_threshold_pct) && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Thresholds need review</AlertTitle>
              <AlertDescription>Critical threshold must be lower than or equal to warning threshold.</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStandardDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={
                upsertStandard.isPending ||
                !standardForm.operation_code ||
                !standardForm.operation_name ||
                toNumber(standardForm.standard_units_per_hour) <= 0 ||
                Number(standardForm.critical_threshold_pct) > Number(standardForm.warning_threshold_pct)
              }
              onClick={submitStandard}
            >
              Save Standard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shiftDialogOpen} onOpenChange={setShiftDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Shift Plan</DialogTitle>
            <DialogDescription>Create reusable shift windows with warehouse and planned capacity.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Shift Code</Label>
              <Input value={shiftForm.shift_code} onChange={(event) => setShiftForm({ ...shiftForm, shift_code: event.target.value.toUpperCase() })} />
            </div>
            <div className="space-y-2">
              <Label>Shift Name</Label>
              <Input value={shiftForm.shift_name} onChange={(event) => setShiftForm({ ...shiftForm, shift_name: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select value={shiftForm.warehouse_id} onValueChange={(value) => setShiftForm({ ...shiftForm, warehouse_id: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">All warehouses</SelectItem>
                  {warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                      {warehouse.warehouse_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Planned Headcount</Label>
              <Input type="number" min={1} value={shiftForm.planned_headcount} onChange={(event) => setShiftForm({ ...shiftForm, planned_headcount: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Start</Label>
              <Input type="time" value={shiftForm.start_time} onChange={(event) => setShiftForm({ ...shiftForm, start_time: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>End</Label>
              <Input type="time" value={shiftForm.end_time} onChange={(event) => setShiftForm({ ...shiftForm, end_time: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Break Minutes</Label>
              <Input type="number" min={0} value={shiftForm.break_minutes} onChange={(event) => setShiftForm({ ...shiftForm, break_minutes: event.target.value })} />
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-gray-500">Status</p>
              <Badge className="mt-2 bg-slate-100 text-slate-800">
                {shiftForm.end_time < shiftForm.start_time ? "Overnight" : "Same Day"}
              </Badge>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShiftDialogOpen(false)}>Cancel</Button>
            <Button disabled={upsertShift.isPending || !shiftForm.shift_code || !shiftForm.shift_name} onClick={submitShift}>
              Save Shift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
