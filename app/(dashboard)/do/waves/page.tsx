"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Loader2, PlayCircle, Plus, Send, ShieldCheck, UserPlus } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import {
  useAllocateDOWave,
  useAssignTask,
  useCompleteTask,
  useCreateDOWave,
  useDOWaves,
  useDOWaveTasks,
  useReleaseDOWave,
  useStartTask,
} from "@/hooks/use-do-waves"
import { Button } from "@/components/ui/button"
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

type WaveRow = {
  id: number
  wave_number: string
  warehouse_name: string
  client_name: string | null
  strategy: "BATCH" | "CLUSTER"
  status: "DRAFT" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"
  total_orders: number
  total_tasks: number
}

type TaskRow = {
  id: number
  wave_id: number
  wave_number: string
  do_number: string
  item_code: string
  item_name: string
  required_quantity: number
  picked_quantity: number
  status: "QUEUED" | "ASSIGNED" | "IN_PROGRESS" | "DONE" | "CANCELLED"
  assigned_to_name: string | null
}

type WarehouseOption = {
  id: number
  warehouse_code: string | null
  warehouse_name: string
  city?: string | null
}

type ClientOption = {
  id: number
  client_code: string | null
  client_name: string
}

type PickerOption = {
  id: number
  full_name: string
  username: string
  role: string
  warehouse_id: number | null
  warehouse_name: string | null
}

export default function DOWavesPage() {
  const [warehouseId, setWarehouseId] = useState("")
  const [clientId, setClientId] = useState("all")
  const [selectedPickerIds, setSelectedPickerIds] = useState<number[]>([])
  const [selectedWaveId, setSelectedWaveId] = useState<number | undefined>(undefined)

  const warehousesQuery = useQuery({
    queryKey: ["do-waves", "warehouse-options"],
    queryFn: async () => {
      const response = await apiClient.get<WarehouseOption[]>("/warehouses?is_active=true")
      return response.data ?? []
    },
  })
  const clientsQuery = useQuery({
    queryKey: ["do-waves", "client-options"],
    queryFn: async () => {
      const response = await apiClient.get<ClientOption[]>("/clients?is_active=true")
      return response.data ?? []
    },
  })
  const pickersQuery = useQuery({
    queryKey: ["do-waves", "picker-options", warehouseId],
    enabled: Boolean(warehouseId),
    queryFn: async () => {
      const qp = new URLSearchParams({ warehouse_id: warehouseId })
      const response = await apiClient.get<PickerOption[]>(`/do/waves/pickers?${qp.toString()}`)
      return response.data ?? []
    },
  })
  const waveQuery = useDOWaves()
  const taskQuery = useDOWaveTasks(selectedWaveId)
  const createWave = useCreateDOWave()
  const releaseWave = useReleaseDOWave()
  const allocateWave = useAllocateDOWave()
  const assignTask = useAssignTask()
  const startTask = useStartTask()
  const completeTask = useCompleteTask()

  const waves = useMemo(() => (waveQuery.data?.data as WaveRow[] | undefined) ?? [], [waveQuery.data?.data])
  const warehouses = useMemo(() => warehousesQuery.data ?? [], [warehousesQuery.data])
  const clients = useMemo(() => clientsQuery.data ?? [], [clientsQuery.data])
  const pickers = useMemo(() => pickersQuery.data ?? [], [pickersQuery.data])
  const tasks = (taskQuery.data?.data as TaskRow[] | undefined) ?? []

  const selectedWave = useMemo(
    () => waves.find((w) => w.id === selectedWaveId) || null,
    [waves, selectedWaveId]
  )
  const selectedPickerNames = useMemo(
    () =>
      pickers
        .filter((picker) => selectedPickerIds.includes(picker.id))
        .map((picker) => picker.full_name || picker.username),
    [pickers, selectedPickerIds]
  )

  const create = async () => {
    if (!warehouseId) return
    await createWave.mutateAsync({
      warehouse_id: Number(warehouseId),
      client_id: clientId !== "all" ? Number(clientId) : undefined,
      strategy: "BATCH",
      max_orders: 20,
    })
  }

  const togglePicker = (pickerId: number) => {
    setSelectedPickerIds((current) =>
      current.includes(pickerId)
        ? current.filter((id) => id !== pickerId)
        : [...current, pickerId]
    )
  }

  const handleWarehouseChange = (value: string) => {
    setWarehouseId(value)
    setSelectedPickerIds([])
  }

  const getStatusBadge = (status: string) => {
    const colorMap = {
      DRAFT: "bg-slate-100 text-slate-800",
      RELEASED: "bg-blue-100 text-blue-800",
      IN_PROGRESS: "bg-amber-100 text-amber-800",
      COMPLETED: "bg-green-100 text-green-800",
      CANCELLED: "bg-red-100 text-red-800",
      QUEUED: "bg-slate-100 text-slate-800",
      ASSIGNED: "bg-blue-100 text-blue-800",
      DONE: "bg-green-100 text-green-800",
    } as Record<string, string>
    return <Badge className={colorMap[status] || "bg-gray-100 text-gray-800"}>{status}</Badge>
  }

  if (waveQuery.isLoading) {
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
          <h1 className="text-3xl font-bold">Wave Orchestration</h1>
          <p className="mt-1 text-gray-500">Create waves, assign pick tasks, and execute queue</p>
        </div>
        <Link href="/do">
          <Button variant="outline">Back to DO</Button>
        </Link>
      </div>

      <div className="rounded-lg border bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4 text-blue-600" />
          <p className="text-sm font-medium">Create Wave</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_auto]">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Warehouse</p>
            <Select value={warehouseId} onValueChange={handleWarehouseChange}>
              <SelectTrigger>
                <SelectValue placeholder={warehousesQuery.isLoading ? "Loading warehouses..." : "Choose warehouse"} />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name}
                    {warehouse.warehouse_code ? ` (${warehouse.warehouse_code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Client</p>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {clients.map((client) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.client_name}
                    {client.client_code ? ` (${client.client_code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={create}
            disabled={createWave.isPending || !warehouseId}
            className="self-end bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="mr-2 h-4 w-4" />
            Create
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-indigo-600" />
          <p className="text-sm font-medium">Bulk Allocate Queued Tasks</p>
        </div>
        <div className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-muted-foreground">
              {selectedWave
                ? `Allocate open tasks for ${selectedWave.wave_number}`
                : "Select a wave from the table before allocating tasks"}
            </p>
            <p className="text-sm font-medium text-slate-700">
              {selectedPickerIds.length
                ? `${selectedPickerIds.length} picker${selectedPickerIds.length === 1 ? "" : "s"} selected`
                : "No pickers selected"}
            </p>
          </div>
          {!warehouseId ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Choose a warehouse above to show available pickers.
            </div>
          ) : pickersQuery.isLoading ? (
            <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading available pickers
            </div>
          ) : pickers.length ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {pickers.map((picker) => {
                const checked = selectedPickerIds.includes(picker.id)
                return (
                  <label
                    key={picker.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition ${
                      checked ? "border-indigo-300 bg-indigo-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300"
                      checked={checked}
                      onChange={() => togglePicker(picker.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-900">
                        {picker.full_name || picker.username}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {picker.role.replaceAll("_", " ")}
                        {picker.warehouse_name ? ` - ${picker.warehouse_name}` : " - Floating"}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No active warehouse pickers found for this location.
            </div>
          )}
          {selectedPickerNames.length ? (
            <div className="flex flex-wrap gap-2">
              {selectedPickerNames.map((name) => (
                <Badge key={name} variant="secondary">
                  {name}
                </Badge>
              ))}
            </div>
          ) : null}
          <Button
            variant="outline"
            disabled={!selectedWaveId || selectedPickerIds.length === 0 || allocateWave.isPending}
            onClick={() =>
              selectedWaveId
                ? allocateWave.mutate({
                    waveId: selectedWaveId,
                    userIds: selectedPickerIds,
                  })
                : null
            }
          >
            Allocate
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white shadow">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wave</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Tasks</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {waves.map((wave) => (
              <TableRow
                key={wave.id}
                className={selectedWaveId === wave.id ? "bg-blue-50" : ""}
                onClick={() => setSelectedWaveId(wave.id)}
              >
                <TableCell className="font-medium">{wave.wave_number}</TableCell>
                <TableCell>{wave.warehouse_name}</TableCell>
                <TableCell>{wave.client_name || "-"}</TableCell>
                <TableCell>{wave.strategy}</TableCell>
                <TableCell className="text-right">{wave.total_orders}</TableCell>
                <TableCell className="text-right">{wave.total_tasks}</TableCell>
                <TableCell>{getStatusBadge(wave.status)}</TableCell>
                <TableCell className="text-right">
                  {wave.status === "DRAFT" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={releaseWave.isPending}
                      onClick={(e) => {
                        e.stopPropagation()
                        releaseWave.mutate(wave.id)
                      }}
                    >
                      <Send className="mr-1 h-4 w-4" />
                      Release
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg border bg-white shadow">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">
            Task Queue {selectedWave ? `- ${selectedWave.wave_number}` : "(select wave)"}
          </p>
          <Select
            value={selectedWaveId ? String(selectedWaveId) : "all"}
            onValueChange={(v) => setSelectedWaveId(v === "all" ? undefined : Number(v))}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Waves</SelectItem>
              {waves.map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>
                  {w.wave_number}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task Ref</TableHead>
              <TableHead>Wave</TableHead>
              <TableHead>DO</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Required</TableHead>
              <TableHead className="text-right">Picked</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id}>
                <TableCell>{`PICK-${String(task.id).padStart(5, "0")}`}</TableCell>
                <TableCell>{task.wave_number}</TableCell>
                <TableCell>{task.do_number}</TableCell>
                <TableCell>
                  {task.item_code} - {task.item_name}
                </TableCell>
                <TableCell className="text-right">{task.required_quantity}</TableCell>
                <TableCell className="text-right">{task.picked_quantity}</TableCell>
                <TableCell>{task.assigned_to_name || "-"}</TableCell>
                <TableCell>{getStatusBadge(task.status)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {task.status === "QUEUED" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Assign ${task.do_number} pick task to me`}
                        onClick={() => assignTask.mutate({ taskId: task.id })}
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {(task.status === "ASSIGNED" || task.status === "IN_PROGRESS") ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Start ${task.do_number} pick task`}
                        onClick={() => startTask.mutate(task.id)}
                      >
                        <PlayCircle className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {(task.status === "ASSIGNED" || task.status === "IN_PROGRESS") ? (
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700"
                        aria-label={`Complete ${task.do_number} pick task`}
                        onClick={() => completeTask.mutate({ taskId: task.id })}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-gray-500">
                  No tasks found
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
