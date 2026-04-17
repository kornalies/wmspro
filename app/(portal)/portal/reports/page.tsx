"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type PortalSummary = {
  stock?: { in_stock_units?: number; dispatched_units?: number }
  grn?: { total_grn?: number; confirmed_grn?: number }
  orders?: { total_do?: number; fulfilled_do?: number }
  billing?: {
    total_invoices?: number
    overdue_invoices?: number
    total_billed?: number
    outstanding_amount?: number
  }
  disputes?: {
    total_disputes?: number
    open_disputes?: number
  }
  sla?: {
    dispatch_target_hours?: number
    warning_threshold_pct?: number
    total_orders_90d?: number
    on_time_orders_90d?: number
    on_time_pct?: number
  }
}

export default function PortalReportsPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const clientsRes = await fetch("/api/portal/clients", { cache: "no-store" })
      const clientsJson = await clientsRes.json()
      const loaded = (clientsJson?.data || []) as PortalClient[]
      setClients(loaded)
      const selected = loaded[0]?.id ?? null
      setClientId(selected)
      if (selected) {
        const reportRes = await fetch(`/api/portal/reports?client_id=${selected}`, { cache: "no-store" })
        const reportJson = await reportRes.json()
        setSummary((reportJson?.data || null) as PortalSummary | null)
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!clientId) return
    void (async () => {
      const reportRes = await fetch(`/api/portal/reports?client_id=${clientId}`, { cache: "no-store" })
      const reportJson = await reportRes.json()
      setSummary((reportJson?.data || null) as PortalSummary | null)
    })()
  }, [clientId])

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal Reports</h1>
        <a href="/portal" className="rounded-md border px-4 py-2 text-sm">
          Back to Portal
        </a>
      </div>

      <div className="rounded-lg border p-4">
        <label className="mb-2 block text-sm font-medium">Client</label>
        <select
          className="w-full rounded-md border px-3 py-2"
          value={clientId ?? ""}
          onChange={(e) => setClientId(Number(e.target.value))}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.client_name} ({client.client_code})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-600">Loading reports...</p>
      ) : (
        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">Inventory</p>
            <p className="mt-2 text-sm">In Stock: {summary?.stock?.in_stock_units ?? 0}</p>
            <p className="text-sm">Dispatched: {summary?.stock?.dispatched_units ?? 0}</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">Orders</p>
            <p className="mt-2 text-sm">Total: {summary?.orders?.total_do ?? 0}</p>
            <p className="text-sm">Fulfilled: {summary?.orders?.fulfilled_do ?? 0}</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">Billing</p>
            <p className="mt-2 text-sm">Invoices: {summary?.billing?.total_invoices ?? 0}</p>
            <p className="text-sm">Overdue: {summary?.billing?.overdue_invoices ?? 0}</p>
            <p className="text-sm">Outstanding: INR {Number(summary?.billing?.outstanding_amount ?? 0).toFixed(2)}</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">Disputes</p>
            <p className="mt-2 text-sm">Total: {summary?.disputes?.total_disputes ?? 0}</p>
            <p className="text-sm">Open: {summary?.disputes?.open_disputes ?? 0}</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">SLA</p>
            <p className="mt-2 text-sm">Target: {summary?.sla?.dispatch_target_hours ?? 48} hrs</p>
            <p className="text-sm">
              On-Time: {summary?.sla?.on_time_orders_90d ?? 0}/{summary?.sla?.total_orders_90d ?? 0}
            </p>
            <p className="text-sm">Compliance: {Number(summary?.sla?.on_time_pct ?? 100).toFixed(2)}%</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">GRN</p>
            <p className="mt-2 text-sm">Total: {summary?.grn?.total_grn ?? 0}</p>
            <p className="text-sm">Confirmed: {summary?.grn?.confirmed_grn ?? 0}</p>
          </article>
        </section>
      )}
    </main>
  )
}

