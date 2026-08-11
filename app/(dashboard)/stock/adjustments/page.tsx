"use client"

/**
 * Inventory adjustments — raising, deciding, and the register.
 *
 * The screen is organised around the two facts that matter about an adjustment
 * and used to be invisible here:
 *
 *   Raising one QUARANTINES the units. It writes nothing off, but the stock
 *   stops being shippable the moment somebody reports it, so a draft is not
 *   free — it is stock nobody can sell. That is why drafts lead the page with
 *   their age rather than sitting in a status column halfway down a table.
 *
 *   Approving one DESTROYS stock, and may break a delivery order that was
 *   holding it. So the approver sees the actual serials and the actual orders
 *   before the button does anything, and has to say out loud that they accept
 *   the second part.
 *
 * Everything the raise form offers comes from /stock/adjustments/availability —
 * the same query the approval re-checks — so the screen cannot propose a unit
 * the approval would refuse.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ClipboardCheck,
  Clock,
  Loader2,
  Printer,
  RefreshCw,
  Scale,
  ShieldAlert,
} from "lucide-react"

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
  created_at: string
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

type DetailSerial = {
  serial_number: string
  status: string | null
  batch_number: string | null
  expiry_date: string | null
  bin_location: string | null
  quarantined: boolean | null
}

type DetailLine = {
  id: number
  line_number: number
  item_code: string
  item_name: string
  direction: string
  quantity: number
  remarks: string | null
  serials: DetailSerial[]
}

type Claim = { serial_number: string; claimed_by: string }

type Detail = { adjustment: Adjustment; lines: DetailLine[]; claims: Claim[] }

type Warehouse = { id: number; warehouse_name: string }
type Client = { id: number; client_name: string }
type AvailableItem = {
  item_id: number
  item_code: string
  item_name: string
  uom: string | null
  adjustable: number
}
type AvailableSerial = {
  id: number
  serial_number: string
  status: string
  batch_number: string | null
  expiry_date: string | null
  bin_location: string
  received_date: string | null
  claimed_by: string | null
}
type Receipt = {
  grn_line_item_id: number
  grn_number: string
  grn_date: string | null
  line_number: number
  quantity: number
  batch_number: string | null
  expiry_date: string | null
}

const REASONS = ["DAMAGE", "LOSS", "FOUND", "EXPIRY", "COUNT_VARIANCE", "SYSTEM_CORRECTION", "OTHER"]

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
  CANCELLED: "bg-slate-100 text-slate-800",
}

function daysSince(value: string | null | undefined) {
  if (!value) return 0
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

export default function AdjustmentsPage() {
  const [rows, setRows] = useState<Adjustment[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [clients, setClients] = useState<Client[]>([])
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
    grn_line_item_id: "",
    found_serials: "",
  })

  const [items, setItems] = useState<AvailableItem[]>([])
  const [serials, setSerials] = useState<AvailableSerial[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [search, setSearch] = useState("")

  const [detail, setDetail] = useState<Detail | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, whs, cls] = await Promise.all([
        api.get("/stock/adjustments") as Promise<{ data: { totals: Totals; rows: Adjustment[] } }>,
        api.get("/warehouses") as Promise<{ data: Warehouse[] }>,
        api.get("/clients") as Promise<{ data: Client[] }>,
      ])
      setRows(list.data.rows)
      setTotals(list.data.totals)
      setWarehouses(Array.isArray(whs.data) ? whs.data : [])
      setClients(Array.isArray(cls.data) ? cls.data : [])
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

  /** The item list is what this warehouse actually holds, never the item master. */
  useEffect(() => {
    if (!form.client_id || !form.warehouse_id) {
      setItems([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = (await api.get(
          `/stock/adjustments/availability?client_id=${form.client_id}&warehouse_id=${form.warehouse_id}`
        )) as { data: { items: AvailableItem[] } }
        if (!cancelled) setItems(res.data.items ?? [])
      } catch {
        if (!cancelled) setItems([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form.client_id, form.warehouse_id])

  /**
   * Units and receipts for the chosen item. Searching goes back to the server:
   * filtering a truncated page in the browser is how stock that is genuinely
   * there ends up looking like stock that is not.
   */
  useEffect(() => {
    if (!form.client_id || !form.warehouse_id || !form.item_id) {
      setSerials([])
      setReceipts([])
      return
    }
    let cancelled = false
    const base = `/stock/adjustments/availability?client_id=${form.client_id}&warehouse_id=${form.warehouse_id}&item_id=${form.item_id}`
    void (async () => {
      try {
        if (form.direction === "DECREASE") {
          const res = (await api.get(
            `${base}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`
          )) as { data: { serials: AvailableSerial[] } }
          if (!cancelled) setSerials(res.data.serials ?? [])
        } else {
          const res = (await api.get(`${base}&mode=receipts`)) as { data: { receipts: Receipt[] } }
          if (!cancelled) setReceipts(res.data.receipts ?? [])
        }
      } catch {
        if (!cancelled) {
          setSerials([])
          setReceipts([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form.client_id, form.warehouse_id, form.item_id, form.direction, search])

  const pendingRows = useMemo(() => {
    return rows
      .filter((r) => r.status === "DRAFT")
      .sort((a, b) => daysSince(b.created_at) - daysSince(a.created_at))
  }, [rows])

  const claimedPicks = useMemo(
    () => serials.filter((s) => picked.includes(s.serial_number) && s.claimed_by),
    [serials, picked]
  )

  const create = useCallback(async () => {
    setBusy("create")
    setError("")
    setNotice("")
    try {
      const line =
        form.direction === "DECREASE"
          ? { item_id: Number(form.item_id), direction: "DECREASE", serials: picked }
          : {
              item_id: Number(form.item_id),
              direction: "INCREASE",
              grn_line_item_id: Number(form.grn_line_item_id),
              batch_number:
                receipts.find((r) => r.grn_line_item_id === Number(form.grn_line_item_id))
                  ?.batch_number ?? null,
              expiry_date:
                receipts.find((r) => r.grn_line_item_id === Number(form.grn_line_item_id))
                  ?.expiry_date ?? null,
              serials: form.found_serials
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            }
      const res = (await api.post("/stock/adjustments", {
        client_id: Number(form.client_id),
        warehouse_id: Number(form.warehouse_id),
        reason_code: form.reason_code,
        reason: form.reason,
        lines: [line],
      })) as { message?: string }
      setNotice(res.message || "Adjustment raised")
      setPicked([])
      setForm({ ...form, found_serials: "" })
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to raise adjustment")
    } finally {
      setBusy("")
    }
  }, [form, picked, receipts, load])

  const openDetail = useCallback(async (row: Adjustment) => {
    if (openId === row.id) {
      setOpenId(null)
      setDetail(null)
      return
    }
    setOpenId(row.id)
    setDetail(null)
    setAcknowledged(false)
    try {
      const res = (await api.get(`/stock/adjustments/${row.id}`)) as { data: Detail }
      setDetail(res.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load adjustment")
    }
  }, [openId])

  const act = useCallback(
    async (row: Adjustment, action: string, acknowledgeClaims = false) => {
      setBusy(`${row.id}-${action}`)
      setError("")
      setNotice("")
      try {
        const res = (await api.post(`/stock/adjustments/${row.id}`, {
          action,
          acknowledge_claims: acknowledgeClaims,
        })) as { message?: string }
        setNotice(res.message || "Done")
        setOpenId(null)
        setDetail(null)
        await load()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Action failed")
      } finally {
        setBusy("")
      }
    },
    [load]
  )

  const canRaise =
    busy === "" &&
    form.client_id !== "" &&
    form.warehouse_id !== "" &&
    form.item_id !== "" &&
    (form.direction === "DECREASE"
      ? picked.length > 0
      : form.grn_line_item_id !== "" && form.found_serials.trim() !== "")

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

      {pendingRows.length ? (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" /> Awaiting approval
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              These units are quarantined — nothing has been written off, but nothing can ship
              them either. Oldest first.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingRows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div>
                  <span className="font-medium">{row.adjustment_number}</span>{" "}
                  <span className="text-muted-foreground">
                    {row.warehouse_name} · {row.reason_code} · {row.units_decreased} off,{" "}
                    {row.units_increased} on
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={daysSince(row.created_at) >= 3 ? "bg-red-100 text-red-800" : ""}>
                    {daysSince(row.created_at)}d waiting
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => void openDetail(row)}>
                    Review
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

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
              onChange={(e) => {
                setForm({ ...form, client_id: e.target.value, item_id: "" })
                setPicked([])
              }}
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
              onChange={(e) => {
                setForm({ ...form, warehouse_id: e.target.value, item_id: "" })
                setPicked([])
              }}
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
            <Label htmlFor="direction">Direction</Label>
            <select
              id="direction"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.direction}
              onChange={(e) => {
                setForm({ ...form, direction: e.target.value, item_id: "", grn_line_item_id: "" })
                setPicked([])
              }}
            >
              <option value="DECREASE">Write off</option>
              <option value="INCREASE">Add found stock</option>
            </select>
          </div>
          <div>
            <Label htmlFor="item">Item</Label>
            <select
              id="item"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.item_id}
              onChange={(e) => {
                setForm({ ...form, item_id: e.target.value, grn_line_item_id: "" })
                setPicked([])
              }}
              disabled={!form.client_id || !form.warehouse_id}
            >
              <option value="">
                {!form.client_id || !form.warehouse_id
                  ? "Pick a client and warehouse first"
                  : items.length
                    ? "Select…"
                    : "This warehouse holds none of this client's stock"}
              </option>
              {items.map((i) => (
                <option key={i.item_id} value={i.item_id}>
                  {i.item_code} — {i.item_name} ({i.adjustable} on hand)
                </option>
              ))}
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

          {form.direction === "DECREASE" ? (
            <div className="sm:col-span-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Units to write off</Label>
                <Input
                  className="h-8 w-64"
                  placeholder="Search serial or batch…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={!form.item_id}
                />
              </div>
              {!form.item_id ? (
                <p className="text-xs text-muted-foreground">Pick an item to list its units.</p>
              ) : serials.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No adjustable units — everything here is already dispatched, written off, or
                  named on another open adjustment.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 border-b bg-background text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="p-2" />
                        <th className="p-2">Serial</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Batch / expiry</th>
                        <th className="p-2">Location</th>
                        <th className="p-2">Held by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {serials.map((s) => (
                        <tr key={s.id} className="border-b last:border-0">
                          <td className="p-2">
                            <input
                              type="checkbox"
                              checked={picked.includes(s.serial_number)}
                              onChange={(e) =>
                                setPicked((prev) =>
                                  e.target.checked
                                    ? [...prev, s.serial_number]
                                    : prev.filter((p) => p !== s.serial_number)
                                )
                              }
                            />
                          </td>
                          <td className="p-2 font-medium">{s.serial_number}</td>
                          <td className="p-2">{s.status}</td>
                          <td className="p-2">
                            {s.batch_number || "—"}
                            {s.expiry_date ? (
                              <span className="block text-xs text-muted-foreground">
                                exp {s.expiry_date}
                              </span>
                            ) : null}
                          </td>
                          <td className="p-2">{s.bin_location}</td>
                          <td className="p-2 text-xs">
                            {s.claimed_by ? (
                              <span className="text-red-700">{s.claimed_by}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {picked.length} selected. Raising this quarantines them immediately — they stop
                being pickable — but nothing is written off until it is approved.
              </p>
              {claimedPicks.length ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {claimedPicks.length} of these are promised to another order (
                    {[...new Set(claimedPicks.map((s) => s.claimed_by))].join(", ")}). You can
                    still report them — damage happens to sold stock too — but whoever approves
                    this will have to confirm those orders lose the stock.
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="sm:col-span-3 space-y-2">
              <div>
                <Label htmlFor="receipt">Receipt these units belong to</Label>
                <select
                  id="receipt"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.grn_line_item_id}
                  onChange={(e) => setForm({ ...form, grn_line_item_id: e.target.value })}
                  disabled={!form.item_id}
                >
                  <option value="">
                    {!form.item_id
                      ? "Pick an item first"
                      : receipts.length
                        ? "Select…"
                        : "No receipts of this item for this client here"}
                  </option>
                  {receipts.map((r) => (
                    <option key={r.grn_line_item_id} value={r.grn_line_item_id}>
                      {r.grn_number} · line {r.line_number} · {r.grn_date ?? "?"} · qty {r.quantity}
                      {r.batch_number ? ` · batch ${r.batch_number}` : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Found stock still has to say where it came from: every unit traces back to a
                  receipt line, and the lot genealogy walks that link. Batch and expiry are
                  inherited from the receipt.
                </p>
              </div>
              <div>
                <Label htmlFor="found">Serial numbers found</Label>
                <Input
                  id="found"
                  value={form.found_serials}
                  placeholder="SER-001, SER-002"
                  onChange={(e) => setForm({ ...form, found_serials: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The system will not invent a serial number it was not given. Separate with
                  commas or spaces.
                </p>
              </div>
            </div>
          )}

          <div className="sm:col-span-3">
            <Button onClick={() => void create()} disabled={!canRaise}>
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
                    <Fragment key={row.id}>
                      <tr className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium">
                          <button
                            className="underline underline-offset-2"
                            onClick={() => void openDetail(row)}
                          >
                            {row.adjustment_number}
                          </button>
                        </td>
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
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy !== ""}
                                onClick={() => void openDetail(row)}
                              >
                                Review
                              </Button>
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
                      {openId === row.id ? (
                        <tr className="border-b bg-muted/30">
                          <td colSpan={9} className="p-3">
                            {!detail ? (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {detail.lines.map((line) => (
                                  <div key={line.id}>
                                    <div className="text-sm font-medium">
                                      Line {line.line_number}: {line.item_code} — {line.item_name}{" "}
                                      <span className="text-muted-foreground">
                                        ({line.direction}, {line.quantity})
                                      </span>
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {line.serials.map((s) => (
                                        <span
                                          key={s.serial_number}
                                          className="rounded border bg-background px-2 py-0.5 text-xs"
                                          title={`${s.status ?? "not yet created"}${
                                            s.bin_location ? ` · ${s.bin_location}` : ""
                                          }${s.batch_number ? ` · batch ${s.batch_number}` : ""}`}
                                        >
                                          {s.serial_number}
                                          <span className="ml-1 text-muted-foreground">
                                            {s.status ?? "new"}
                                          </span>
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                ))}

                                {detail.claims.length ? (
                                  <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                                    <div className="mb-1 flex items-center gap-1 font-medium">
                                      <ShieldAlert className="h-3 w-3" /> Approving this releases
                                      stock promised elsewhere
                                    </div>
                                    <ul className="ml-4 list-disc">
                                      {detail.claims.map((c) => (
                                        <li key={c.serial_number}>
                                          {c.serial_number} — {c.claimed_by}
                                        </li>
                                      ))}
                                    </ul>
                                    <label className="mt-2 flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={acknowledged}
                                        onChange={(e) => setAcknowledged(e.target.checked)}
                                      />
                                      I accept that those orders lose this stock
                                    </label>
                                  </div>
                                ) : null}

                                {row.status === "DRAFT" ? (
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      disabled={
                                        busy !== "" || (detail.claims.length > 0 && !acknowledged)
                                      }
                                      onClick={() => void act(row, "approve", acknowledged)}
                                    >
                                      Approve — write off {row.units_decreased}, add{" "}
                                      {row.units_increased}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busy !== ""}
                                      onClick={() => void act(row, "reject")}
                                    >
                                      Reject
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busy !== ""}
                                      onClick={() => void act(row, "cancel")}
                                    >
                                      Withdraw
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
