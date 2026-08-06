"use client"

/**
 * Inventory adjustments — the register and the approval queue.
 *
 * The screen leads with the fact that a draft changes nothing. Every adjustment
 * is a request until someone approves it, and making that obvious is what stops
 * the approval step being treated as a formality: the numbers on the left are
 * proposed, the numbers on the right have already moved stock.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, ClipboardCheck, Loader2, Printer, RefreshCw, Scale } from "lucide-react"

import api from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Adjustment = {
  id: number
  adjustment_number: string
  status: string
  reason_code: string
  reason: string | null
  client_name: string | null
  warehouse_name: string
  adjustment_date: string
  source_module: string
  units_decreased: number
  units_increased: number
  line_count: number
}

type Totals = {
  adjustments: number
  pending: number
  units_written_off: number
  units_added: number
}

type Warehouse = { id: number; warehouse_name: string }
type Client = { id: number; client_name: string }
type Item = { id: number; item_code: string; item_name: string }

const REASONS = ["DAMAGE", "LOSS", "FOUND", "EXPIRY", "COUNT_VARIANCE", "SYSTEM_CORRECTION", "OTHER"]

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
  CANCELLED: "bg-slate-100 text-slate-800",
}

export default function AdjustmentsPage() {
  const [rows, setRows] = useState<Adjustment[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [form, setForm] = useState({
    client_id: "",
    warehouse_id: "",
    reason_code: "DAMAGE",
    reason: "",
    item_id: "",
    direction: "DECREASE",
    serials: "",
  })

  const load = useCallback(async () => {
    try {
      const [list, whs, cls, its] = await Promise.all([
        api.get("/stock/adjustments") as Promise<{ data: { totals: Totals; rows: Adjustment[] } }>,
        api.get("/warehouses") as Promise<{ data: Warehouse[] }>,
        api.get("/clients") as Promise<{ data: Client[] }>,
        api.get("/items") as Promise<{ data: Item[] }>,
      ])
      setRows(list.data.rows)
      setTotals(list.data.totals)
      setWarehouses(Array.isArray(whs.data) ? whs.data : [])
      setClients(Array.isArray(cls.data) ? cls.data : [])
      setItems(Array.isArray(its.data) ? its.data : [])
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load adjustments")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = useCallback(async () => {
    setBusy("create")
    setError("")
    setNotice("")
    try {
      const serials = form.serials
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const res = (await api.post("/stock/adjustments", {
        client_id: Number(form.client_id),
        warehouse_id: Number(form.warehouse_id),
        reason_code: form.reason_code,
        reason: form.reason,
        lines: [{ item_id: Number(form.item_id), direction: form.direction, serials }],
      })) as { message?: string }
      setNotice(res.message || "Adjustment raised")
      setForm({ ...form, serials: "" })
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to raise adjustment")
    } finally {
      setBusy("")
    }
  }, [form, load])

  const act = useCallback(
    async (row: Adjustment, action: string) => {
      setBusy(`${row.id}-${action}`)
      setError("")
      setNotice("")
      try {
        const res = (await api.post(`/stock/adjustments/${row.id}`, { action })) as { message?: string }
        setNotice(res.message || "Done")
        await load()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Action failed")
      } finally {
        setBusy("")
      }
    },
    [load]
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory Adjustments</h1>
          <p className="text-sm text-muted-foreground">
            Stock that changed without being received or shipped — and who approved it.
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

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Adjustments</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals?.adjustments ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Awaiting approval</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals?.pending ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Units written off</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals?.units_written_off ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Units added</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals?.units_added ?? 0}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" /> Raise an adjustment
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
            <Label htmlFor="warehouse">Warehouse</Label>
            <select
              id="warehouse"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.warehouse_id}
              onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}
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
            <Label htmlFor="reason_code">Reason</Label>
            <select
              id="reason_code"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.reason_code}
              onChange={(e) => setForm({ ...form, reason_code: e.target.value })}
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
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
            <Label htmlFor="direction">Direction</Label>
            <select
              id="direction"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value })}
            >
              <option value="DECREASE">Write off</option>
              <option value="INCREASE">Add found stock</option>
            </select>
          </div>
          <div>
            <Label htmlFor="note">Note</Label>
            <Input
              id="note"
              value={form.reason}
              placeholder="Forklift damage, bay 3"
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="serials">Serial numbers</Label>
            <Input
              id="serials"
              value={form.serials}
              placeholder="SER-001, SER-002"
              onChange={(e) => setForm({ ...form, serials: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Every adjustment names the units it moves — the system will not invent a serial
              number it was not given. Separate with commas or spaces.
            </p>
          </div>
          <div className="sm:col-span-3">
            <Button
              onClick={() => void create()}
              disabled={
                busy !== "" ||
                !form.client_id ||
                !form.warehouse_id ||
                !form.item_id ||
                !form.serials.trim()
              }
            >
              {busy === "create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Raise adjustment
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" /> Register
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No adjustments recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Number</th>
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Warehouse</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 pr-3">Origin</th>
                    <th className="py-2 pr-3 text-right">Off</th>
                    <th className="py-2 pr-3 text-right">On</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{row.adjustment_number}</td>
                      <td className="py-2 pr-3">{String(row.adjustment_date).slice(0, 10)}</td>
                      <td className="py-2 pr-3">{row.warehouse_name}</td>
                      <td className="py-2 pr-3">
                        {row.reason_code}
                        {row.reason ? (
                          <span className="block text-xs text-muted-foreground">{row.reason}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{row.source_module}</td>
                      <td className="py-2 pr-3 text-right">{row.units_decreased}</td>
                      <td className="py-2 pr-3 text-right">{row.units_increased}</td>
                      <td className="py-2 pr-3">
                        <Badge className={STATUS_TONE[row.status] || ""}>{row.status}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          {row.status === "DRAFT" ? (
                            <>
                              <Button
                                size="sm"
                                disabled={busy !== ""}
                                onClick={() => void act(row, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy !== ""}
                                onClick={() => void act(row, "reject")}
                              >
                                Reject
                              </Button>
                            </>
                          ) : null}
                          <a
                            className="inline-flex h-8 items-center rounded-md border px-2 text-xs"
                            href={`/documents/inventory-adjustment-report/${row.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Printer className="mr-1 h-3 w-3" /> Report
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
    </div>
  )
}
