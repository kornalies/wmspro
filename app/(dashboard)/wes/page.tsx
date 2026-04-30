"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Bot, Loader2, PlayCircle, ShieldAlert, Zap } from "lucide-react"

import {
  useProcessWesQueue,
  useQueueWesCommand,
  useResolveWesIncident,
  useUpsertWesEquipment,
  useWesCommands,
  useWesEquipment,
  useWesMonitor,
} from "@/hooks/use-wes"
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

type EquipmentRow = {
  id: number
  equipment_code: string
  equipment_name: string
  equipment_type: string
  adapter_type: string
  status: string
  safety_mode: boolean
  last_error?: string | null
}

type CommandRow = {
  id: number
  equipment_id: number
  equipment_code: string
  command_type: string
  status: string
  attempt_count: number
  max_attempts: number
  last_error?: string | null
}

type IncidentRow = {
  id: number
  equipment_id: number | null
  equipment_code?: string | null
  command_id: number | null
  incident_type: string
  severity: string
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "CLOSED"
  reason: string
  opened_at: string
}

export default function WESPage() {
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<number | undefined>(undefined)
  const [equipmentCode, setEquipmentCode] = useState("")
  const [equipmentName, setEquipmentName] = useState("")
  const [equipmentType, setEquipmentType] = useState("AMR")
  const [adapterType, setAdapterType] = useState("MOCK")

  const [commandType, setCommandType] = useState("MOVE")
  const [commandPayload, setCommandPayload] = useState("{}")

  const equipmentQuery = useWesEquipment()
  const commandsQuery = useWesCommands(selectedEquipmentId)
  const monitorQuery = useWesMonitor(selectedEquipmentId)
  const upsertEquipment = useUpsertWesEquipment()
  const queueCommand = useQueueWesCommand()
  const processQueue = useProcessWesQueue()
  const resolveIncident = useResolveWesIncident()

  const equipment = (equipmentQuery.data?.data as EquipmentRow[] | undefined) ?? []
  const commands = (commandsQuery.data?.data as CommandRow[] | undefined) ?? []
  const monitorPayload = (monitorQuery.data?.data as {
    summary?: {
      total_commands: number
      queued: number
      retry: number
      done: number
      dead_letter: number
    }
    incidents?: IncidentRow[]
  }) || { incidents: [] }
  const incidents = monitorPayload.incidents || []

  const selectedEquipment = useMemo(
    () => equipment.find((e) => e.id === selectedEquipmentId),
    [equipment, selectedEquipmentId]
  )

  if (equipmentQuery.isLoading || commandsQuery.isLoading || monitorQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">WES Orchestration</h1>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            Event bus + command channel + adapter abstraction + guarded state/failover
          </p>
        </div>
        <Button onClick={() => processQueue.mutate()} disabled={processQueue.isPending}>
          <PlayCircle className="mr-2 h-4 w-4" />
          Run Queue Processor
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Card><CardContent className="pt-4"><p className="text-xs text-slate-500 dark:text-slate-400">Total Cmd</p><p className="text-2xl font-bold">{monitorPayload.summary?.total_commands || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-slate-500 dark:text-slate-400">Queued</p><p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{monitorPayload.summary?.queued || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-slate-500 dark:text-slate-400">Retry</p><p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{monitorPayload.summary?.retry || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-slate-500 dark:text-slate-400">Done</p><p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{monitorPayload.summary?.done || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-slate-500 dark:text-slate-400">Dead Letter</p><p className="text-2xl font-bold text-red-700 dark:text-red-300">{monitorPayload.summary?.dead_letter || 0}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base"><Bot className="mr-2 inline h-4 w-4" />Equipment Adapter Layer</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-5">
            <Input placeholder="Equipment code" value={equipmentCode} onChange={(e) => setEquipmentCode(e.target.value)} />
            <Input placeholder="Equipment name" value={equipmentName} onChange={(e) => setEquipmentName(e.target.value)} />
            <Select value={equipmentType} onValueChange={setEquipmentType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="AMR">AMR</SelectItem>
                <SelectItem value="CONVEYOR">CONVEYOR</SelectItem>
                <SelectItem value="SORTER">SORTER</SelectItem>
                <SelectItem value="ASRS">ASRS</SelectItem>
                <SelectItem value="SHUTTLE">SHUTTLE</SelectItem>
                <SelectItem value="PICK_ARM">PICK_ARM</SelectItem>
                <SelectItem value="OTHER">OTHER</SelectItem>
              </SelectContent>
            </Select>
            <Select value={adapterType} onValueChange={setAdapterType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MOCK">MOCK</SelectItem>
                <SelectItem value="REST">REST</SelectItem>
                <SelectItem value="MQTT">MQTT</SelectItem>
                <SelectItem value="PLC">PLC</SelectItem>
                <SelectItem value="OPCUA">OPCUA</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={!equipmentCode || !equipmentName || upsertEquipment.isPending}
              onClick={() =>
                upsertEquipment.mutate({
                  equipment_code: equipmentCode,
                  equipment_name: equipmentName,
                  equipment_type: equipmentType,
                  adapter_type: adapterType,
                  status: "IDLE",
                  heartbeat_timeout_seconds: 60,
                })
              }
            >
              Save
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Adapter</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Safety</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {equipment.map((row) => (
                <TableRow
                  key={row.id}
                  className={selectedEquipmentId === row.id ? "bg-blue-50 dark:bg-blue-950/30" : ""}
                  onClick={() => setSelectedEquipmentId(row.id)}
                >
                  <TableCell className="font-mono text-xs">{row.equipment_code}</TableCell>
                  <TableCell>{row.equipment_name}</TableCell>
                  <TableCell>{row.equipment_type}</TableCell>
                  <TableCell>{row.adapter_type}</TableCell>
                  <TableCell>
                    <Badge className={row.status === "FAULT" || row.status === "ESTOP" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"}>{row.status}</Badge>
                  </TableCell>
                  <TableCell>{row.safety_mode ? "ON" : "OFF"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base"><Zap className="mr-2 inline h-4 w-4" />Command Channel</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-4">
            <Select value={commandType} onValueChange={setCommandType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MOVE">MOVE</SelectItem>
                <SelectItem value="PICK">PICK</SelectItem>
                <SelectItem value="DROP">DROP</SelectItem>
                <SelectItem value="CHARGE">CHARGE</SelectItem>
                <SelectItem value="PAUSE">PAUSE</SelectItem>
                <SelectItem value="RESUME">RESUME</SelectItem>
                <SelectItem value="RESET">RESET</SelectItem>
                <SelectItem value="ESTOP">ESTOP</SelectItem>
                <SelectItem value="CUSTOM">CUSTOM</SelectItem>
              </SelectContent>
            </Select>
            <textarea
              className="rounded border border-slate-300 bg-white p-2 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 md:col-span-2"
              value={commandPayload}
              onChange={(e) => setCommandPayload(e.target.value)}
            />
            <Button
              disabled={!selectedEquipmentId || queueCommand.isPending}
              onClick={() =>
                queueCommand.mutate({
                  equipment_id: selectedEquipmentId,
                  command_type: commandType,
                  command_payload: JSON.parse(commandPayload),
                  priority: 50,
                  max_attempts: 3,
                })
              }
            >
              Queue Command
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Equipment</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commands.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.id}</TableCell>
                  <TableCell>{row.equipment_code}</TableCell>
                  <TableCell>{row.command_type}</TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell className="text-right">{row.attempt_count}/{row.max_attempts}</TableCell>
                  <TableCell className="text-xs text-red-600 dark:text-red-300">{row.last_error || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base"><ShieldAlert className="mr-2 inline h-4 w-4" />Safety Failover</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Incident</TableHead>
                <TableHead>Equipment</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.incident_type}</TableCell>
                  <TableCell>{row.equipment_code || row.equipment_id || "-"}</TableCell>
                  <TableCell>{row.severity}</TableCell>
                  <TableCell>
                    <Badge className={row.status === "OPEN" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[380px] truncate text-xs">{row.reason}</TableCell>
                  <TableCell className="text-right">
                    {row.status === "OPEN" || row.status === "ACKNOWLEDGED" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          resolveIncident.mutate({
                            incidentId: row.id,
                            resolutionNotes: "Resolved from WES console",
                            closeSafetyMode: true,
                          })
                        }
                      >
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        Resolve
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {!incidents.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-slate-500 dark:text-slate-400">No failover incidents</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedEquipment ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Selected equipment: {selectedEquipment.equipment_code} ({selectedEquipment.status})
        </p>
      ) : null}
    </div>
  )
}
