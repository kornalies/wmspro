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
  qty_sent: number
  qty_received: number
  short_units: number
}

type TransferLine = {
  id: number
  line_number: number
  item_code: string
  item_name: string
  quantity_requested: number
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

type Warehouse = { id: number; warehouse_name: string }
type Client = { id: number; client_name: string }
type Item = { id: number; item_code: string; item_name: string }

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-800",
  APPROVED: "bg-blue-100 text-blue-800",
  IN_TRANSIT: "bg-amber-100 text-amber-900",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-100 text-red-800",
}

export default function StockTransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [open, setOpen] = useState<{ lines: TransferLine[]; serials: TransferSerial[]; transfer: Transfer } | null>(
    null
  )
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
      const [list, whs, cls, its] = await Promise.all([
        api.get("/stock/transfers") as Promise<{ data: { rows: Transfer[] } }>,
        api.get("/warehouses") as Promise<{ data: Warehouse[] }>,
        api.get("/clients") as Promise<{ data: Client[] }>,
        api.get("/items") as Promise<{ data: Item[] }>,
      ])
      setTransfers(list.data.rows)
      setWarehouses(Array.isArray(whs.data) ? whs.data : [])
      setClients(Array.isArray(cls.data) ? cls.data : [])
      setItems(Array.isArray(its.data) ? its.data : [])
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
              onChange={(e) => setForm({ ...form, item_id: e.target.value })}
            >
              <option value="">Select…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.item_code} — {i.item_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="qty">Quantity</Label>
            <Input
              id="qty"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            />
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
                      <td className="py-2 pr-3 text-right">{t.qty_sent}</td>
                      <td className="py-2 pr-3 text-right">
                        {t.qty_received}
                        {t.short_units > 0 ? (
                          <span className="ml-1 text-xs text-red-700">(-{t.short_units})</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge className={STATUS_TONE[t.status] || ""}>{t.status}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => void openTransfer(t)}>
                            Open
                          </Button>
                          {t.status === "DRAFT" ? (
                            <Button
                              size="sm"
                              disabled={busy !== ""}
                              onClick={() => void act(t, "approve")}
                            >
                              Approve
                            </Button>
                          ) : null}
                          {t.status === "APPROVED" ? (
                            <Button
                              size="sm"
                              disabled={busy !== ""}
                              onClick={() => void act(t, "dispatch")}
                            >
                              Dispatch
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
