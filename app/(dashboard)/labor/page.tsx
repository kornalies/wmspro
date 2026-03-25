"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Clock3, Download, Gauge, Loader2, Plus, Users2 } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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

type LaborStandard = {
  id: number
  operation_code: string
  operation_name: string
  unit_of_measure: string
  standard_units_per_hour: number
  warning_threshold_pct: number
  critical_threshold_pct: number
  is_active: boolean
}

type LaborShift = {
  id: number
  shift_code: string
  shift_name: string
  warehouse_name?: string | null
  start_time: string
  end_time: string
  planned_headcount: number
  assigned_headcount: number
}

type LaborAssignment = {
  id: number
  shift_name: string
  shift_date: string
  user_name: string
  assignment_role: string
  assignment_status: string
}

type ProductivityRow = {
  id: number
  event_ts: string
  operation_name: string
  user_name?: string | null
  quantity: number
  duration_minutes: number
  actual_units_per_hour: number
  performance_pct: number
}

type ExceptionRow = {
  id: number
  event_ts: string
  user_name?: string | null
  shift_name?: string | null
  operation_name: string
  performance_pct: number
  warning_threshold_pct: number
  critical_threshold_pct: number
  severity: "CRITICAL" | "WARNING" | "NORMAL"
}

const todayIso = new Date().toISOString().slice(0, 10)

export default function LaborPage() {
  const [operationCode, setOperationCode] = useState("")
  const [operationName, setOperationName] = useState("")
  const [standardUPH, setStandardUPH] = useState("")

  const [shiftCode, setShiftCode] = useState("")
  const [shiftName, setShiftName] = useState("")
  const [shiftStart, setShiftStart] = useState("09:00")
  const [shiftEnd, setShiftEnd] = useState("18:00")
  const [plannedHeadcount, setPlannedHeadcount] = useState("6")

  const [assignmentShiftId, setAssignmentShiftId] = useState("")
  const [assignmentUserId, setAssignmentUserId] = useState("")

  const [prodStandardId, setProdStandardId] = useState("")
  const [prodShiftId, setProdShiftId] = useState("none")
  const [prodUserId, setProdUserId] = useState("none")
  const [prodQty, setProdQty] = useState("")
  const [prodDuration, setProdDuration] = useState("")

  const [from, setFrom] = useState(todayIso)
  const [to, setTo] = useState(todayIso)
  const [appliedRange, setAppliedRange] = useState({ from: todayIso, to: todayIso })

  const metaQuery = useLaborMeta()
  const standardsQuery = useLaborStandards(true)
  const shiftsQuery = useLaborShifts(todayIso)
  const assignmentsQuery = useLaborAssignments(todayIso)
  const productivityQuery = useLaborProductivity(appliedRange.from, appliedRange.to)
  const exceptionsQuery = useLaborExceptions(appliedRange.from, appliedRange.to)

  const upsertStandard = useUpsertLaborStandard()
  const upsertShift = useUpsertLaborShift()
  const upsertAssignment = useUpsertLaborAssignment()
  const createProductivity = useCreateLaborProductivity()

  const standards = (standardsQuery.data?.data as LaborStandard[] | undefined) ?? []
  const shifts = (shiftsQuery.data?.data as LaborShift[] | undefined) ?? []
  const assignments = (assignmentsQuery.data?.data as LaborAssignment[] | undefined) ?? []
  const productivityRows = (productivityQuery.data?.data as ProductivityRow[] | undefined) ?? []
  const exceptionsPayload = (exceptionsQuery.data?.data as {
    summary?: {
      critical_count: number
      warning_count: number
      avg_performance_pct: number
      total_records: number
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

  const isBusy =
    metaQuery.isLoading ||
    standardsQuery.isLoading ||
    shiftsQuery.isLoading ||
    assignmentsQuery.isLoading

  const canApplyRange = from <= to
  const users = (metaQuery.data?.data as { users?: Array<{ id: number; full_name: string }> } | undefined)?.users ?? []
  const metaShifts = (metaQuery.data?.data as { shifts?: Array<{ id: number; shift_name: string }> } | undefined)?.shifts ?? []
  const metaStandards =
    (metaQuery.data?.data as { standards?: Array<{ id: number; operation_name: string }> } | undefined)?.standards ?? []

  const avgProductivity = useMemo(() => {
    if (!productivityRows.length) return 0
    return (
      productivityRows.reduce((sum, row) => sum + Number(row.performance_pct || 0), 0) /
      productivityRows.length
    )
  }, [productivityRows])

  if (isBusy) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Labor Management</h1>
          <p className="mt-1 text-gray-500">
            Standards, shifts, productivity metrics, and operational exceptions
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              window.open(
                `/api/labor/export?mode=exceptions&from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}`,
                "_blank"
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Export Exceptions
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              window.open(
                `/api/labor/export?mode=productivity&from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}`,
                "_blank"
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Export Productivity
          </Button>
          <div>
            <p className="mb-1 text-xs text-gray-500">From</p>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500">To</p>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button
            disabled={!canApplyRange}
            onClick={() => setAppliedRange({ from, to })}
            className="bg-blue-600 hover:bg-blue-700"
          >
            Apply
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Total Standards</p>
              <Gauge className="h-4 w-4 text-blue-600" />
            </div>
            <p className="mt-2 text-2xl font-bold">{standards.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Shifts Today</p>
              <Clock3 className="h-4 w-4 text-indigo-600" />
            </div>
            <p className="mt-2 text-2xl font-bold">{shifts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Critical Exceptions</p>
              <AlertTriangle className="h-4 w-4 text-red-600" />
            </div>
            <p className="mt-2 text-2xl font-bold">{exceptionsPayload.summary?.critical_count || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Avg Productivity</p>
              <Users2 className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-2 text-2xl font-bold">{avgProductivity.toFixed(1)}%</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Labor Standards</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              <Input
                placeholder="Operation code"
                value={operationCode}
                onChange={(e) => setOperationCode(e.target.value)}
              />
              <Input
                placeholder="Operation name"
                value={operationName}
                onChange={(e) => setOperationName(e.target.value)}
              />
              <Input
                placeholder="Std units/hr"
                type="number"
                min={0}
                value={standardUPH}
                onChange={(e) => setStandardUPH(e.target.value)}
              />
              <Button
                disabled={upsertStandard.isPending || !operationCode || !operationName || !standardUPH}
                onClick={() =>
                  upsertStandard.mutate({
                    operation_code: operationCode,
                    operation_name: operationName,
                    standard_units_per_hour: Number(standardUPH),
                    unit_of_measure: "UNITS",
                    warning_threshold_pct: 85,
                    critical_threshold_pct: 65,
                  })
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                Save
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead className="text-right">Std/Hour</TableHead>
                  <TableHead className="text-right">Warn %</TableHead>
                  <TableHead className="text-right">Crit %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {standards.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{row.operation_code}</TableCell>
                    <TableCell>{row.operation_name}</TableCell>
                    <TableCell className="text-right">{row.standard_units_per_hour}</TableCell>
                    <TableCell className="text-right">{row.warning_threshold_pct}</TableCell>
                    <TableCell className="text-right">{row.critical_threshold_pct}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shifts & Assignments (Today)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
              <Input placeholder="Shift code" value={shiftCode} onChange={(e) => setShiftCode(e.target.value)} />
              <Input placeholder="Shift name" value={shiftName} onChange={(e) => setShiftName(e.target.value)} />
              <Input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} />
              <Input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} />
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  value={plannedHeadcount}
                  onChange={(e) => setPlannedHeadcount(e.target.value)}
                />
                <Button
                  disabled={upsertShift.isPending || !shiftCode || !shiftName}
                  onClick={() =>
                    upsertShift.mutate({
                      shift_code: shiftCode,
                      shift_name: shiftName,
                      start_time: shiftStart,
                      end_time: shiftEnd,
                      planned_headcount: Number(plannedHeadcount || 1),
                      break_minutes: 30,
                      is_overnight: false,
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <Select value={assignmentShiftId || "none"} onValueChange={(v) => setAssignmentShiftId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select shift" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select shift</SelectItem>
                  {metaShifts.map((shift) => (
                    <SelectItem key={shift.id} value={String(shift.id)}>
                      {shift.shift_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={assignmentUserId || "none"} onValueChange={(v) => setAssignmentUserId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select user</SelectItem>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)}>
                      {user.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={upsertAssignment.isPending || !assignmentShiftId || !assignmentUserId}
                onClick={() =>
                  upsertAssignment.mutate({
                    shift_id: Number(assignmentShiftId),
                    shift_date: todayIso,
                    user_id: Number(assignmentUserId),
                    assignment_role: "OPERATOR",
                    assignment_status: "ASSIGNED",
                  })
                }
              >
                Assign User
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shift</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Assigned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.shift_name}</TableCell>
                    <TableCell>{row.start_time} - {row.end_time}</TableCell>
                    <TableCell className="text-right">{row.planned_headcount}</TableCell>
                    <TableCell className="text-right">{row.assigned_headcount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Productivity Capture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
            <Select value={prodStandardId || "none"} onValueChange={(v) => setProdStandardId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Standard" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Standard</SelectItem>
                {metaStandards.map((standard) => (
                  <SelectItem key={standard.id} value={String(standard.id)}>
                    {standard.operation_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={prodShiftId} onValueChange={setProdShiftId}>
              <SelectTrigger>
                <SelectValue placeholder="Shift (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No shift</SelectItem>
                {metaShifts.map((shift) => (
                  <SelectItem key={shift.id} value={String(shift.id)}>
                    {shift.shift_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={prodUserId} onValueChange={setProdUserId}>
              <SelectTrigger>
                <SelectValue placeholder="User (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No user</SelectItem>
                {users.map((user) => (
                  <SelectItem key={user.id} value={String(user.id)}>
                    {user.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              placeholder="Qty"
              value={prodQty}
              onChange={(e) => setProdQty(e.target.value)}
            />
            <Input
              type="number"
              min={0}
              placeholder="Minutes"
              value={prodDuration}
              onChange={(e) => setProdDuration(e.target.value)}
            />
            <Button
              disabled={
                createProductivity.isPending ||
                !prodStandardId ||
                !prodQty ||
                !prodDuration
              }
              onClick={() =>
                createProductivity.mutate({
                  standard_id: Number(prodStandardId),
                  shift_id: prodShiftId === "none" ? undefined : Number(prodShiftId),
                  user_id: prodUserId === "none" ? undefined : Number(prodUserId),
                  source_type: "MANUAL",
                  quantity: Number(prodQty),
                  duration_minutes: Number(prodDuration),
                })
              }
            >
              Record
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Minutes</TableHead>
                <TableHead className="text-right">Perf %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {productivityRows.slice(0, 12).map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.event_ts).toLocaleString("en-IN")}</TableCell>
                  <TableCell>{row.operation_name}</TableCell>
                  <TableCell>{row.user_name || "-"}</TableCell>
                  <TableCell className="text-right">{row.quantity}</TableCell>
                  <TableCell className="text-right">{row.duration_minutes}</TableCell>
                  <TableCell className="text-right">{row.performance_pct}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Exception Dashboard</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="rounded border bg-red-50 p-3">
                <p className="text-xs text-red-700">Critical</p>
                <p className="text-xl font-bold text-red-700">{exceptionsPayload.summary?.critical_count || 0}</p>
              </div>
              <div className="rounded border bg-amber-50 p-3">
                <p className="text-xs text-amber-700">Warning</p>
                <p className="text-xl font-bold text-amber-700">{exceptionsPayload.summary?.warning_count || 0}</p>
              </div>
              <div className="rounded border bg-blue-50 p-3">
                <p className="text-xs text-blue-700">Records</p>
                <p className="text-xl font-bold text-blue-700">{exceptionsPayload.summary?.total_records || 0}</p>
              </div>
              <div className="rounded border bg-emerald-50 p-3">
                <p className="text-xs text-emerald-700">Avg Perf</p>
                <p className="text-xl font-bold text-emerald-700">{exceptionsPayload.summary?.avg_performance_pct || 0}%</p>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Perf %</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exceptionsPayload.rows || []).slice(0, 15).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{new Date(row.event_ts).toLocaleString("en-IN")}</TableCell>
                    <TableCell>{row.operation_name}</TableCell>
                    <TableCell>{row.user_name || "-"}</TableCell>
                    <TableCell className="text-right">{row.performance_pct}%</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          row.severity === "CRITICAL"
                            ? "bg-red-100 text-red-800"
                            : row.severity === "WARNING"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-green-100 text-green-800"
                        }
                      >
                        {row.severity}
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
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shift</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Assigned</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exceptionsPayload.shift_headcount_gaps || []).map((row) => (
                  <TableRow key={row.shift_id}>
                    <TableCell>{row.shift_name}</TableCell>
                    <TableCell className="text-right">{row.planned_headcount}</TableCell>
                    <TableCell className="text-right">{row.assigned_headcount}</TableCell>
                    <TableCell className="text-right">
                      <span className={row.headcount_gap > 0 ? "text-red-600 font-semibold" : "text-emerald-600"}>
                        {row.headcount_gap}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-gray-700">Today assignments</p>
              <div className="space-y-2">
                {assignments.slice(0, 8).map((row) => (
                  <div key={row.id} className="flex items-center justify-between rounded border p-2 text-sm">
                    <span>{row.shift_name} - {row.user_name}</span>
                    <Badge className="bg-slate-100 text-slate-700">{row.assignment_status}</Badge>
                  </div>
                ))}
                {assignments.length === 0 ? (
                  <p className="text-sm text-gray-500">No assignments for today.</p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
