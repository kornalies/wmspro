"use client"

/**
 * Inter-warehouse stock transfers.
 *
 * The screen is organised around the state machine rather than around a form,
 * because the states are what an operator is actually tracking: what is waiting
 * for approval, what is on a truck right now, and what arrived short. A transfer
 * sitting in IN_TRANSIT is stock nobody can sell at either end, so it is the row
 * that most needs to be visible.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, ArrowLeftRight, Loader2, Printer, RefreshCw, Truck } from "lucide-react"

import api from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Transfer = {
  id: number
  transfer_number: string
  status: string
  client_name: string | null
  from_warehouse_name: string
  to_warehouse_name: string
  transfer_date: string
  reason: string | null
  qty_requested: number
  qty_picked: number
  qty_sent: number
  qty_received: number
  short_units: number
  uncovered_units: number
}

type TransferLine = {
  id: number
  line_number: number
  item_code: string
  item_name: string
  quantity_requested: number
  quantity_picked: number
  quantity_sent: number
  quantity_received: number
  uom: string
}

type TransferSerial = {
  serial_id: number
  serial_number: string
  received: boolean
  status: string
  item_code: string
  batch_number: string | null
}

/** A transfer on the road, seen from the warehouse waiting for it. */
type InboundTransfer = {
  id: number
  transfer_number: string
  client_name: string | null
  from_warehouse_name: string
  to_warehouse_name: string
  expected_date: string | null
  units_on_truck: number
  days_in_transit: number
  overdue: boolean
  vehicle_number: string | null
  driver_name: string | null
}

/** A unit that left a warehouse and never turned up. */
type TransferException = {
  serial_id: number
  serial_number: string
  item_code: string
  transfer_id: number
  transfer_number: string
  client_name: string | null
  from_warehouse_name: string | null
  to_warehouse_name: string | null
  days_stranded: number
  bucket: "SHORT_RECEIPT" | "OVERDUE"
}

type Warehouse = { id: number; warehouse_name: string }
type Client = { id: number; client_name: string }
/**
 * The item list is now driven by what the source warehouse actually holds for
 * the chosen client, not by the item master. An item that cannot be transferred
 * is not offered.
 */
type Availability = {
  item_id: number
  item_code: string
  item_name: string
  uom: string | null
  available: number
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-800",
  APPROVED: "bg-blue-100 text-blue-800",
  PICKED: "bg-indigo-100 text-indigo-900",
  IN_TRANSIT: "bg-amber-100 text-amber-900",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-100 text-red-800",
}

export default function StockTransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [inbound, setInbound] = useState<InboundTransfer[]>([])
  const [exceptions, setExceptions] = useState<TransferException[]>([])
  const [availability, setAvailability] = useState<Availability[]>([])
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [open, setOpen] = useState<{ lines: TransferLine[]; serials: TransferSerial[]; transfer: Transfer } | null>(
    null
  )
  // Gate-out is the only action that needs input, so it is the only one that
  // interrupts the register instead of firing on click.
  const [gateOut, setGateOut] = useState<{
    transfer: Transfer
    vehicle: string
    driver: string
  } | null>(null)
  const [form, setForm] = useState({
    client_id: "",
    from_warehouse_id: "",
    to_warehouse_id: "",
    reason: "",
    item_id: "",
    quantity: "1",
  })

  const load = useCallback(async () => {
    try {
      const [list, whs, cls, inb, exc] = await Promise.all([
        api.get("/stock/transfers") as Promise<{ data: { rows: Transfer[] } }>,
        api.get("/warehouses") as Promise<{ data: Warehouse[] }>,
        api.get("/clients") as Promise<{ data: Client[] }>,
        api.get("/stock/transfers/inbound") as Promise<{ data: { rows: InboundTransfer[] } }>,
        api.get("/stock/transfers/exceptions") as Promise<{
          data: { rows: TransferException[] }
        }>,
      ])
      setTransfers(list.data.rows)
      setInbound(inb.data.rows)
      setExceptions(exc.data.rows)
      setWarehouses(Array.isArray(whs.data) ? whs.data : [])
      setClients(Array.isArray(cls.data) ? cls.data : [])
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load transfers")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Availability depends on the client and the source warehouse, so it is
  // fetched when both are known and cleared whenever either changes — a stale
  // list would be worse than none, because it looks authoritative.
  useEffect(() => {
    const clientId = form.client_id
    const warehouseId = form.from_warehouse_id
    if (!clientId || !warehouseId) {
      setAvailability([])
      return
    }
    let cancelled = false
    setAvailabilityLoading(true)
    void (async () => {
      try {
        const res = (await api.get(
          `/stock/transfers/availability?client_id=${clientId}&warehouse_id=${warehouseId}`
        )) as { data: { rows: Availability[] } }
        if (!cancelled) setAvailability(res.data.rows)
      } catch {
        if (!cancelled) setAvailability([])
      } finally {
        if (!cancelled) setAvailabilityLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form.client_id, form.from_warehouse_id])

  // Selecting a client or source that no longer offers the chosen item must drop
  // the selection, or the form would post an item that is not on the list.
  useEffect(() => {
    if (!form.item_id) return
    if (!availability.some((a) => String(a.item_id) === form.item_id)) {
      setForm((prev) => ({ ...prev, item_id: "" }))
    }
  }, [availability, form.item_id])

  const selectedAvailability = useMemo(
    () => availability.find((a) => String(a.item_id) === form.item_id) || null,
    [availability, form.item_id]
  )
  const overRequested =
    selectedAvailability !== null && Number(form.quantity) > selectedAvailability.available

  const openTransfer = useCallback(async (transfer: Transfer) => {
    try {
      const res = (await api.get(`/stock/transfers/${transfer.id}`)) as {
        data: { transfer: Transfer; lines: TransferLine[]; serials: TransferSerial[] }
      }
      setOpen({ transfer: res.data.transfer, lines: res.data.lines, serials: res.data.serials })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load transfer")
    }
  }, [])

  const act = useCallback(
    async (transfer: Transfer, action: string, body: Record<string, unknown> = {}) => {
      setBusy(`${transfer.id}-${action}`)
      setError("")
      setNotice("")
      try {
        const res = (await api.post(`/stock/transfers/${transfer.id}`, { action, ...body })) as {
          message?: string
        }
        setNotice(res.message || "Done")
        await load()
        await openTransfer(transfer)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Action failed")
      } finally {
        setBusy("")
      }
    },
    [load, openTransfer]
  )

  const writeOff = useCallback(
    async (transferId: number) => {
      setBusy(`writeoff-${transferId}`)
      setError("")
      setNotice("")
      try {
        const res = (await api.post("/stock/transfers/exceptions", {
          transfer_id: transferId,
        })) as { message?: string }
        setNotice(res.message || "Draft write-off raised")
        await load()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to raise write-off")
      } finally {
        setBusy("")
      }
    },
    [load]
  )

  const create = useCallback(async () => {
    setBusy("create")
    setError("")
    setNotice("")
    try {
      const res = (await api.post("/stock/transfers", {
        client_id: Number(form.client_id),
        from_warehouse_id: Number(form.from_warehouse_id),
        to_warehouse_id: Number(form.to_warehouse_id),
        reason: form.reason,
        lines: [{ item_id: Number(form.item_id), quantity: Number(form.quantity) }],
      })) as { message?: string }
      setNotice(res.message || "Transfer raised")
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to raise transfer")
    } finally {
      setBusy("")
    }
  }, [form, load])

  const inTransit = useMemo(() => transfers.filter((t) => t.status === "IN_TRANSIT").length, [transfers])
  const overdueInbound = useMemo(() => inbound.filter((r) => r.overdue).length, [inbound])
  const shortReceipts = useMemo(() => transfers.filter((t) => t.short_units > 0).length, [transfers])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock Transfers</h1>
          <p className="text-sm text-muted-foreground">
            Move stock between warehouses, with the note that travels with it.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Transfers</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{transfers.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">In transit</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{inTransit}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Received short</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{shortReceipts}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className="h-4 w-4" /> Raise a transfer
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="client">Client</Label>
            <select
              id="client"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })}
            >
              <option value="">Select…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.client_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="from">From warehouse</Label>
            <select
              id="from"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.from_warehouse_id}
              onChange={(e) => setForm({ ...form, from_warehouse_id: e.target.value })}
            >
              <option value="">Select…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.warehouse_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="to">To warehouse</Label>
            <select
              id="to"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.to_warehouse_id}
              onChange={(e) => setForm({ ...form, to_warehouse_id: e.target.value })}
            >
              <option value="">Select…</option>
              {warehouses
                .filter((w) => String(w.id) !== form.from_warehouse_id)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.warehouse_name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="item">Item</Label>
            <select
              id="item"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.item_id}
              disabled={!form.client_id || !form.from_warehouse_id || availabilityLoading}
              onChange={(e) => setForm({ ...form, item_id: e.target.value })}
            >
              <option value="">
                {!form.client_id || !form.from_warehouse_id
                  ? "Choose a client and source first…"
                  : availabilityLoading
                    ? "Checking stock…"
                    : "Select…"}
              </option>
              {availability.map((a) => (
                <option key={a.item_id} value={a.item_id}>
                  {a.item_code} — {a.item_name} ({a.available} available)
                </option>
              ))}
            </select>
            {form.client_id && form.from_warehouse_id && !availabilityLoading && !availability.length ? (
              <p className="mt-1 text-xs text-red-700">
                This client has no transferable stock in the selected warehouse.
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="qty">Quantity</Label>
            <Input
              id="qty"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            />
            {selectedAvailability ? (
              <p className={`mt-1 text-xs ${overRequested ? "text-amber-700" : "text-muted-foreground"}`}>
                {overRequested
                  ? `Only ${selectedAvailability.available} available — this draft cannot be approved until the rest arrives.`
                  : `${selectedAvailability.available} available at the source.`}
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Input
              id="reason"
              value={form.reason}
              placeholder="Rebalancing stock"
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="sm:col-span-3">
            <Button
              onClick={() => void create()}
              disabled={
                busy !== "" ||
                !form.client_id ||
                !form.from_warehouse_id ||
                !form.to_warehouse_id ||
                !form.item_id
              }
            >
              {busy === "create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Raise transfer
            </Button>
          </div>
        </CardContent>
      </Card>

      {gateOut ? (
        <Card className="border-indigo-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" /> Gate out {gateOut.transfer.transfer_number}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="vehicle">Vehicle number</Label>
              <Input
                id="vehicle"
                value={gateOut.vehicle}
                placeholder="KA-01-AB-1234"
                onChange={(e) => setGateOut({ ...gateOut, vehicle: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="driver">Driver name</Label>
              <Input
                id="driver"
                value={gateOut.driver}
                onChange={(e) => setGateOut({ ...gateOut, driver: e.target.value })}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                disabled={busy !== "" || !gateOut.vehicle.trim()}
                onClick={() => {
                  const target = gateOut
                  setGateOut(null)
                  void act(target.transfer, "dispatch", {
                    vehicle_number: target.vehicle,
                    driver_name: target.driver,
                  })
                }}
              >
                Send it
              </Button>
              <Button variant="outline" onClick={() => setGateOut(null)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              The units staged by the pick are what travels. Nothing is re-chosen here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {exceptions.length ? (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-red-700" /> In-transit exceptions
              <Badge className="bg-red-100 text-red-800">{exceptions.length} unit(s)</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              These units left a warehouse and never turned up. They still count as stock on hand,
              so nothing else will raise them.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Serial</th>
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3">Transfer</th>
                    <th className="py-2 pr-3">Route</th>
                    <th className="py-2 pr-3 text-right">Days</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((e) => (
                    <tr key={e.serial_id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">{e.serial_number}</td>
                      <td className="py-2 pr-3">{e.item_code}</td>
                      <td className="py-2 pr-3">{e.transfer_number}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {e.from_warehouse_name} → {e.to_warehouse_name}
                      </td>
                      <td className="py-2 pr-3 text-right">{e.days_stranded}</td>
                      <td className="py-2 pr-3">
                        <Badge
                          className={
                            e.bucket === "SHORT_RECEIPT"
                              ? "bg-red-100 text-red-800"
                              : "bg-amber-100 text-amber-900"
                          }
                        >
                          {e.bucket === "SHORT_RECEIPT" ? "Never arrived" : "Overdue"}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {e.bucket === "SHORT_RECEIPT" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== ""}
                            title="Raises a draft inventory adjustment. Nothing is written off until it is approved."
                            onClick={() => void writeOff(e.transfer_id)}
                          >
                            Draft write-off
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Chase the carrier</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {inbound.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" /> Expected inbound
              {overdueInbound ? (
                <Badge className="bg-red-100 text-red-800">{overdueInbound} overdue</Badge>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              On the road now. These units are stock neither warehouse can sell.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Transfer</th>
                    <th className="py-2 pr-3">Arriving at</th>
                    <th className="py-2 pr-3">From</th>
                    <th className="py-2 pr-3">Vehicle</th>
                    <th className="py-2 pr-3 text-right">Units</th>
                    <th className="py-2 pr-3 text-right">Days out</th>
                    <th className="py-2 pr-3">Expected</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {inbound.map((r) => (
                    <tr key={r.id} className={`border-b last:border-0 ${r.overdue ? "bg-red-50" : ""}`}>
                      <td className="py-2 pr-3 font-medium">{r.transfer_number}</td>
                      <td className="py-2 pr-3">{r.to_warehouse_name}</td>
                      <td className="py-2 pr-3">{r.from_warehouse_name}</td>
                      <td className="py-2 pr-3">
                        {r.vehicle_number || "—"}
                        {r.driver_name ? (
                          <span className="block text-xs text-muted-foreground">{r.driver_name}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right">{r.units_on_truck}</td>
                      <td className="py-2 pr-3 text-right">{r.days_in_transit}</td>
                      <td className={`py-2 pr-3 ${r.overdue ? "font-medium text-red-700" : ""}`}>
                        {r.expected_date ? r.expected_date.slice(0, 10) : "—"}
                        {r.overdue ? " (overdue)" : ""}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <Button
                          size="sm"
                          disabled={busy !== ""}
                          onClick={() => {
                            const match = transfers.find((t) => t.id === r.id)
                            if (match) void act(match, "receive")
                          }}
                        >
                          Receive
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="h-4 w-4" /> Register
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transfers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Transfer</th>
                    <th className="py-2 pr-3">Route</th>
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3 text-right">Req</th>
                    <th className="py-2 pr-3 text-right">Picked</th>
                    <th className="py-2 pr-3 text-right">Sent</th>
                    <th className="py-2 pr-3 text-right">Recd</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{t.transfer_number}</td>
                      <td className="py-2 pr-3">
                        {t.from_warehouse_name} → {t.to_warehouse_name}
                      </td>
                      <td className="py-2 pr-3">{t.client_name || "—"}</td>
                      <td className="py-2 pr-3 text-right">{t.qty_requested}</td>
                      <td className="py-2 pr-3 text-right">{t.qty_picked}</td>
                      <td className="py-2 pr-3 text-right">{t.qty_sent}</td>
                      <td className="py-2 pr-3 text-right">
                        {t.qty_received}
                        {t.short_units > 0 ? (
                          <span className="ml-1 text-xs text-red-700">(-{t.short_units})</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge className={STATUS_TONE[t.status] || ""}>{t.status}</Badge>
                        {t.uncovered_units > 0 ? (
                          <span
                            className="mt-1 block text-xs text-amber-700"
                            title="The source warehouse does not currently hold enough stock for this transfer."
                          >
                            {t.uncovered_units} not covered
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => void openTransfer(t)}>
                            Open
                          </Button>
                          {t.status === "DRAFT" ? (
                            <Button
                              size="sm"
                              disabled={busy !== "" || t.uncovered_units > 0}
                              title={
                                t.uncovered_units > 0
                                  ? "Cannot approve — the source warehouse does not hold this stock"
                                  : undefined
                              }
                              onClick={() => void act(t, "approve")}
                            >
                              Approve
                            </Button>
                          ) : null}
                          {t.status === "APPROVED" ? (
                            <Button
                              size="sm"
                              disabled={busy !== ""}
                              onClick={() => void act(t, "pick")}
                            >
                              Pick
                            </Button>
                          ) : null}
                          {t.status === "PICKED" ? (
                            <Button
                              size="sm"
                              disabled={busy !== ""}
                              onClick={() => setGateOut({ transfer: t, vehicle: "", driver: "" })}
                            >
                              Gate out
                            </Button>
                          ) : null}
                          {t.status === "APPROVED" || t.status === "PICKED" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== ""}
                              onClick={() => void act(t, "cancel")}
                            >
                              Cancel
                            </Button>
                          ) : null}
                          {t.status === "IN_TRANSIT" ? (
                            <Button
                              size="sm"
                              disabled={busy !== ""}
                              onClick={() => void act(t, "receive")}
                            >
                              Receive all
                            </Button>
                          ) : null}
                          <a
                            className="inline-flex h-8 items-center rounded-md border px-2 text-xs"
                            href={`/documents/stock-transfer-note/${t.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Printer className="mr-1 h-3 w-3" /> Note
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {open ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {open.transfer.transfer_number} — {open.transfer.status}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3 text-right">Requested</th>
                    <th className="py-2 pr-3 text-right">Picked</th>
                    <th className="py-2 pr-3 text-right">Sent</th>
                    <th className="py-2 pr-3 text-right">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {open.lines.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">{l.line_number}</td>
                      <td className="py-2 pr-3">
                        {l.item_code}
                        <span className="block text-xs text-muted-foreground">{l.item_name}</span>
                      </td>
                      <td className="py-2 pr-3 text-right">{l.quantity_requested}</td>
                      <td className="py-2 pr-3 text-right">{l.quantity_picked}</td>
                      <td className="py-2 pr-3 text-right">{l.quantity_sent}</td>
                      <td className="py-2 pr-3 text-right">{l.quantity_received}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {open.serials.length ? (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Units on this transfer</h3>
                <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  {open.serials.map((s) => (
                    <li
                      key={s.serial_id}
                      className={`rounded border p-2 ${s.received ? "bg-emerald-50" : ""}`}
                    >
                      <span className="font-mono">{s.serial_number}</span>
                      <span className="block text-muted-foreground">
                        {s.item_code}
                        {s.batch_number ? ` · ${s.batch_number}` : ""} · {s.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
