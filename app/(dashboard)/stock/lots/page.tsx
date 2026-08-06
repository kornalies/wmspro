"use client"

/**
 * Lot master, genealogy and recall, on one screen.
 *
 * They are one screen because a recall is a single sequence of actions under
 * time pressure: find the lot, see what it touched, stop what can still be
 * stopped, and walk away with the list of deliveries that need a phone call.
 * Splitting that across three pages would mean the operator holds the batch
 * number in their head while navigating -- which is where mistakes happen.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, History, Loader2, PackageSearch, RefreshCw, ShieldAlert } from "lucide-react"

import api from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Lot = {
  client_id: number
  client_name: string | null
  item_id: number
  item_code: string
  item_name: string
  batch_number: string
  manufacturing_date: string | null
  expiry_date: string | null
  first_received: string | null
  total_units: number
  on_hand_units: number
  dispatched_units: number
  warehouse_count: number
  batch_status: string
  batch_status_reason: string | null
  batch_status_reference: string | null
  days_to_expiry: number | null
  disposition: string
}

type TraceRow = Record<string, unknown>

type Recall = {
  batch_status: string
  totals: {
    total_units?: number
    on_hand_units?: number
    dispatched_units?: number
    cancelled_units?: number
    expiry_date?: string | null
  }
  on_hand: TraceRow[]
  shipped: TraceRow[]
  received_on: TraceRow[]
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  ON_HOLD: "bg-amber-100 text-amber-900",
  RECALLED: "bg-red-100 text-red-800",
}

function fmtDate(value: unknown) {
  if (!value) return "—"
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10)
}

export default function LotsPage() {
  const [lots, setLots] = useState<Lot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [filters, setFilters] = useState({ batch: "", status: "", expiring_in_days: "" })

  const [selected, setSelected] = useState<Lot | null>(null)
  const [recall, setRecall] = useState<Recall | null>(null)
  const [holdForm, setHoldForm] = useState({ reason: "", reference_no: "" })

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (filters.batch.trim()) params.set("batch", filters.batch.trim())
      if (filters.status) params.set("status", filters.status)
      if (filters.expiring_in_days) params.set("expiring_in_days", filters.expiring_in_days)
      const res = (await api.get(`/stock/lots?${params.toString()}`)) as {
        data: { totals: { lots: number; on_hand_units: number; held_lots: number }; rows: Lot[] }
      }
      setLots(res.data.rows)
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load lots")
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    void load()
  }, [load])

  const openLot = useCallback(async (lot: Lot) => {
    setSelected(lot)
    setRecall(null)
    setHoldForm({ reason: "", reference_no: "" })
    try {
      const params = new URLSearchParams({
        client_id: String(lot.client_id),
        item_id: String(lot.item_id),
        batch: lot.batch_number,
      })
      const res = (await api.get(`/stock/lots/recall?${params.toString()}`)) as { data: Recall }
      setRecall(res.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load recall impact")
    }
  }, [])

  const setStatus = useCallback(
    async (status: string) => {
      if (!selected) return
      setBusy(status)
      setError("")
      setNotice("")
      try {
        const res = (await api.post("/stock/lots/recall", {
          client_id: selected.client_id,
          item_id: selected.item_id,
          batch: selected.batch_number,
          status,
          reason: holdForm.reason,
          reference_no: holdForm.reference_no || undefined,
        })) as { message?: string; data?: { blocked_units?: number; already_shipped_units?: number } }
        setNotice(
          `${res.message || "Updated"} — ${res.data?.blocked_units ?? 0} unit(s) blocked, ` +
            `${res.data?.already_shipped_units ?? 0} already shipped`
        )
        await load()
        await openLot(selected)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to update batch status")
      } finally {
        setBusy("")
      }
    },
    [selected, holdForm, load, openLot]
  )

  const totals = useMemo(
    () => ({
      lots: lots.length,
      onHand: lots.reduce((sum, lot) => sum + Number(lot.on_hand_units ?? 0), 0),
      held: lots.filter((lot) => lot.batch_status !== "ACTIVE").length,
    }),
    [lots]
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Lot Master</h1>
          <p className="text-sm text-muted-foreground">
            Batch traceability: where a lot came from, where it went, and what to stop.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
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
            <CardTitle className="text-sm font-medium text-muted-foreground">Lots</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals.lots}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Units on hand</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals.onHand}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Held / recalled</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals.held}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PackageSearch className="h-4 w-4" /> Lots
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="batch">Batch</Label>
              <Input
                id="batch"
                value={filters.batch}
                placeholder="LOT-…"
                onChange={(e) => setFilters({ ...filters, batch: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="ON_HOLD">On hold</option>
                <option value="RECALLED">Recalled</option>
              </select>
            </div>
            <div>
              <Label htmlFor="expiring">Expiring within (days)</Label>
              <Input
                id="expiring"
                value={filters.expiring_in_days}
                placeholder="30"
                onChange={(e) => setFilters({ ...filters, expiring_in_days: e.target.value })}
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : lots.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No batch-tracked stock matches these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Batch</th>
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3">Expiry</th>
                    <th className="py-2 pr-3 text-right">On hand</th>
                    <th className="py-2 pr-3 text-right">Dispatched</th>
                    <th className="py-2 pr-3">Disposition</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot) => (
                    <tr
                      key={`${lot.client_id}-${lot.item_id}-${lot.batch_number}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 pr-3 font-medium">{lot.batch_number}</td>
                      <td className="py-2 pr-3">
                        {lot.item_code}
                        <span className="block text-xs text-muted-foreground">{lot.item_name}</span>
                      </td>
                      <td className="py-2 pr-3">{lot.client_name || "—"}</td>
                      <td className="py-2 pr-3">
                        {fmtDate(lot.expiry_date)}
                        {lot.days_to_expiry !== null ? (
                          <span className="block text-xs text-muted-foreground">
                            {Number(lot.days_to_expiry) < 0
                              ? `${Math.abs(Number(lot.days_to_expiry))}d ago`
                              : `in ${lot.days_to_expiry}d`}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right">{lot.on_hand_units}</td>
                      <td className="py-2 pr-3 text-right">{lot.dispatched_units}</td>
                      <td className="py-2 pr-3">
                        <Badge className={STATUS_TONE[lot.batch_status] || ""}>
                          {lot.batch_status}
                        </Badge>
                        <span className="block text-xs text-muted-foreground">{lot.disposition}</span>
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <Button size="sm" variant="outline" onClick={() => void openLot(lot)}>
                          Trace
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" /> {selected.batch_number} — {selected.item_code}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {!recall ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading impact…
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase text-muted-foreground">Still here</p>
                    <p className="text-xl font-semibold">{recall.totals.on_hand_units ?? 0}</p>
                    <p className="text-xs text-muted-foreground">A hold stops these moving.</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase text-muted-foreground">Already shipped</p>
                    <p className="text-xl font-semibold">{recall.totals.dispatched_units ?? 0}</p>
                    <p className="text-xs text-muted-foreground">
                      Out of our hands — these need contacting.
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase text-muted-foreground">Written off</p>
                    <p className="text-xl font-semibold">{recall.totals.cancelled_units ?? 0}</p>
                    <p className="text-xs text-muted-foreground">Already out of stock.</p>
                  </div>
                </div>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Received on</h3>
                  {recall.received_on.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No inbound record.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {recall.received_on.map((row, i) => (
                        <li key={i} className="rounded border p-2">
                          <span className="font-medium">{String(row.grn_number)}</span>{" "}
                          <span className="text-muted-foreground">
                            {fmtDate(row.grn_date)} · {String(row.supplier_name ?? "supplier unknown")} ·{" "}
                            {String(row.units)} unit(s)
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Shipped to</h3>
                  {recall.shipped.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing from this lot has left the building.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {recall.shipped.map((row, i) => (
                        <li key={i} className="rounded border border-amber-200 bg-amber-50 p-2">
                          <span className="font-medium">{String(row.do_number)}</span>{" "}
                          <span className="text-muted-foreground">
                            {fmtDate(row.dispatch_date)} · {String(row.dispatched_units)} unit(s)
                            {row.requested_by ? ` · ${String(row.requested_by)}` : ""}
                            {row.invoice_no ? ` · inv ${String(row.invoice_no)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Where it is now</h3>
                  {recall.on_hand.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No stock on hand.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {recall.on_hand.map((row, i) => (
                        <li key={i} className="rounded border p-2">
                          {String(row.warehouse_name ?? "—")} ·{" "}
                          {String(row.bin_location ?? row.physical_location ?? "unlocated")} ·{" "}
                          {String(row.status)} · {String(row.units)} unit(s)
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-3 rounded-md border p-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldAlert className="h-4 w-4" /> Hold this lot
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    A hold blocks the lot from being allocated to any delivery order. It does not
                    recall what has already shipped.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="reason">Reason</Label>
                      <Input
                        id="reason"
                        value={holdForm.reason}
                        placeholder="Supplier quality notification"
                        onChange={(e) => setHoldForm({ ...holdForm, reason: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="reference">Reference</Label>
                      <Input
                        id="reference"
                        value={holdForm.reference_no}
                        placeholder="RECALL-2026-011"
                        onChange={(e) => setHoldForm({ ...holdForm, reference_no: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy !== "" || !holdForm.reason.trim()}
                      onClick={() => void setStatus("ON_HOLD")}
                    >
                      {busy === "ON_HOLD" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Place on hold
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy !== "" || !holdForm.reason.trim()}
                      onClick={() => void setStatus("RECALLED")}
                    >
                      {busy === "RECALLED" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Mark recalled
                    </Button>
                    {recall.batch_status !== "ACTIVE" ? (
                      <Button
                        variant="secondary"
                        disabled={busy !== ""}
                        onClick={() => void setStatus("ACTIVE")}
                      >
                        {busy === "ACTIVE" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Release
                      </Button>
                    ) : null}
                  </div>
                </section>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
