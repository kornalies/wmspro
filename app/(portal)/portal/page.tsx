"use client"

import { useEffect, useMemo, useState } from "react"

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

type PortalPolicy = {
  features?: Record<string, boolean>
  permissions?: string[]
  branding?: {
    logoUrl?: string
    labels?: Record<string, string>
  }
}

export default function ClientPortalPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [policy, setPolicy] = useState<PortalPolicy | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      setPolicy((policyJson?.data || null) as PortalPolicy | null)

      const clientsRes = await fetch("/api/portal/clients", { cache: "no-store" })
      const clientsJson = await clientsRes.json()
      const loadedClients = (clientsJson?.data || []) as PortalClient[]
      setClients(loadedClients)
      const selected = loadedClients[0]?.id ?? null
      setClientId(selected)
      if (selected) {
        const reportRes = await fetch(`/api/portal/reports?client_id=${selected}`, { cache: "no-store" })
        const reportJson = await reportRes.json()
        setSummary(reportJson?.data || null)
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!clientId) return
    void (async () => {
      const reportRes = await fetch(`/api/portal/reports?client_id=${clientId}`, { cache: "no-store" })
      const reportJson = await reportRes.json()
      setSummary(reportJson?.data || null)
    })()
  }, [clientId])

  const selectedClient = useMemo(() => clients.find((c) => c.id === clientId), [clients, clientId])
  const showPortal = policy?.features?.portal !== false
  const showInventory = policy?.features?.stock !== false
  const showOrders = policy?.features?.do !== false
  const showBilling =
    policy?.features?.billing !== false &&
    (policy?.permissions?.includes("billing.view") || policy?.permissions?.includes("finance.view"))
  const showAsn = policy?.features?.grn !== false || policy?.features?.do !== false
  const showDisputes = showBilling
  const showSla = showPortal
  const doLabel = policy?.branding?.labels?.do || "DO"

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {policy?.branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={policy.branding.logoUrl} alt="Tenant logo" className="h-8 w-8 rounded object-contain" />
          ) : null}
          <h1 className="text-2xl font-semibold">Client Portal</h1>
        </div>
        <div className="flex items-center gap-2">
          {showInventory ? (
            <a href="/portal/inventory" className="rounded-md border px-4 py-2 text-sm">
              Inventory
            </a>
          ) : null}
          {showOrders ? (
            <a href="/portal/orders" className="rounded-md border px-4 py-2 text-sm">
              {doLabel} Orders
            </a>
          ) : null}
          {showBilling ? (
            <a href="/portal/billing" className="rounded-md border px-4 py-2 text-sm">
              Billing
            </a>
          ) : null}
          {showDisputes ? (
            <a href="/portal/disputes" className="rounded-md border px-4 py-2 text-sm">
              Disputes
            </a>
          ) : null}
          {showSla ? (
            <a href="/portal/sla" className="rounded-md border px-4 py-2 text-sm">
              SLA
            </a>
          ) : null}
          {showAsn ? (
            <a href="/portal/asn" className="rounded-md bg-black px-4 py-2 text-sm text-white">
              Request ASN
            </a>
          ) : null}
        </div>
      </div>

      {!showPortal ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Portal is disabled for this tenant.
        </p>
      ) : null}

      <div className="mb-6 rounded-lg border p-4">
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
        <p className="text-sm text-neutral-600">Loading portal data...</p>
      ) : !selectedClient ? (
        <p className="text-sm text-neutral-600">No client mapping assigned. Contact your administrator.</p>
      ) : (
        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">Inventory</p>
            <p className="mt-2 text-sm">In Stock: {summary?.stock?.in_stock_units ?? 0}</p>
            <p className="text-sm">Dispatched: {summary?.stock?.dispatched_units ?? 0}</p>
          </article>
          <article className="rounded-lg border p-4">
            <p className="text-xs uppercase text-neutral-500">GRN</p>
            <p className="mt-2 text-sm">Total: {summary?.grn?.total_grn ?? 0}</p>
            <p className="text-sm">Confirmed: {summary?.grn?.confirmed_grn ?? 0}</p>
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
            <p className="text-xs uppercase text-neutral-500">SLA (Last 90 Days)</p>
            <p className="mt-2 text-sm">Dispatch SLA Target: {summary?.sla?.dispatch_target_hours ?? 48} hrs</p>
            <p className="text-sm">On-Time: {summary?.sla?.on_time_orders_90d ?? 0}/{summary?.sla?.total_orders_90d ?? 0}</p>
            <p className="text-sm">Compliance: {Number(summary?.sla?.on_time_pct ?? 100).toFixed(2)}%</p>
          </article>
        </section>
      )}
    </main>
  )
}
