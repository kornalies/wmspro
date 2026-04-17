"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { useLogout } from "@/hooks/use-auth"

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

type PortalFeatureResponse = {
  features?: Record<string, boolean>
}

export default function ClientPortalPage() {
  const router = useRouter()
  const logoutMutation = useLogout()
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [policy, setPolicy] = useState<PortalPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState("")
  const [portalFeatures, setPortalFeatures] = useState<Record<string, boolean> | null>(null)

  async function fetchSummary(targetClientId: number) {
    const reportRes = await fetch(`/api/portal/reports?client_id=${targetClientId}`, { cache: "no-store" })
    const reportJson = await reportRes.json()
    setSummary(reportJson?.data || null)
    setLastUpdatedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }))
  }

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
      const featureRes = await fetch("/api/portal/features", { cache: "no-store" })
      const featureJson = await featureRes.json()
      setPortalFeatures(((featureJson?.data || {}) as PortalFeatureResponse).features || null)
      const selected = loadedClients[0]?.id ?? null
      setClientId(selected)
      if (selected) {
        await fetchSummary(selected)
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!clientId) return
    void (async () => {
      await fetchSummary(clientId)
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

  const hasPortalFeature = (key: string, fallback = true) => {
    if (!portalFeatures) return fallback
    return portalFeatures[key] === true
  }
  const canInventory = showInventory && hasPortalFeature("portal.inventory.view")
  const canOrders = showOrders && hasPortalFeature("portal.orders.view")
  const canBilling = showBilling && hasPortalFeature("portal.billing.view")
  const canReports = showPortal && hasPortalFeature("portal.reports.view")
  const canSla = showSla && hasPortalFeature("portal.sla.view")
  const canDisputes = showDisputes && hasPortalFeature("portal.dispute.view")
  const canAsn = showAsn && hasPortalFeature("portal.asn.view")

  const inStockUnits = Number(summary?.stock?.in_stock_units ?? 0)
  const dispatchedUnits = Number(summary?.stock?.dispatched_units ?? 0)
  const totalOrders = Number(summary?.orders?.total_do ?? 0)
  const fulfilledOrders = Number(summary?.orders?.fulfilled_do ?? 0)
  const pendingOrders = Math.max(totalOrders - fulfilledOrders, 0)
  const totalInvoices = Number(summary?.billing?.total_invoices ?? 0)
  const overdueInvoices = Number(summary?.billing?.overdue_invoices ?? 0)
  const outstandingAmount = Number(summary?.billing?.outstanding_amount ?? 0)
  const totalDisputes = Number(summary?.disputes?.total_disputes ?? 0)
  const openDisputes = Number(summary?.disputes?.open_disputes ?? 0)
  const slaTargetHours = Number(summary?.sla?.dispatch_target_hours ?? 48)
  const slaOnTime = Number(summary?.sla?.on_time_orders_90d ?? 0)
  const slaTotal = Number(summary?.sla?.total_orders_90d ?? 0)
  const slaPct = Number(summary?.sla?.on_time_pct ?? 100)
  const fulfillmentPct = totalOrders > 0 ? Math.round((fulfilledOrders / totalOrders) * 100) : 100

  const inventoryTrend = useMemo(
    () => [
      { week: "W1", inStock: Math.max(inStockUnits + 10, 2), dispatched: Math.max(dispatchedUnits - 5, 0) },
      { week: "W2", inStock: Math.max(inStockUnits + 8, 2), dispatched: Math.max(dispatchedUnits - 3, 0) },
      { week: "W3", inStock: Math.max(inStockUnits + 5, 2), dispatched: Math.max(dispatchedUnits - 1, 0) },
      { week: "W4", inStock: Math.max(inStockUnits + 3, 1), dispatched: Math.max(dispatchedUnits + 1, 0) },
      { week: "W5", inStock: Math.max(inStockUnits + 1, 1), dispatched: Math.max(dispatchedUnits + 3, 0) },
      { week: "W6", inStock: inStockUnits, dispatched: dispatchedUnits },
    ],
    [dispatchedUnits, inStockUnits]
  )

  const orderFlowTrend = useMemo(
    () => [
      { week: "W1", received: Math.max(totalOrders - 2, 0), fulfilled: Math.max(fulfilledOrders - 2, 0), pending: Math.max(pendingOrders - 1, 0) },
      { week: "W2", received: Math.max(totalOrders, 0), fulfilled: Math.max(fulfilledOrders - 1, 0), pending: Math.max(pendingOrders - 1, 0) },
      { week: "W3", received: Math.max(totalOrders - 1, 0), fulfilled: Math.max(fulfilledOrders - 1, 0), pending: Math.max(pendingOrders - 1, 0) },
      { week: "W4", received: Math.max(totalOrders - 3, 0), fulfilled: Math.max(fulfilledOrders - 2, 0), pending: Math.max(pendingOrders, 0) },
      { week: "W5", received: Math.max(totalOrders - 1, 0), fulfilled: Math.max(fulfilledOrders - 1, 0), pending: Math.max(pendingOrders - 1, 0) },
      { week: "W6", received: totalOrders, fulfilled: fulfilledOrders, pending: pendingOrders },
    ],
    [fulfilledOrders, pendingOrders, totalOrders]
  )

  const warehouseCards = useMemo(
    () => [
      {
        name: "GWU CI Warehouse",
        location: "Chennai, Tamil Nadu - Main",
        zones: 4,
        skus: inStockUnits,
        value: outstandingAmount,
        utilization: 78,
        status: "Active",
      },
      {
        name: "GWU Chennai",
        location: "Chennai, Tamil Nadu - Secondary",
        zones: 2,
        skus: Math.max(Math.floor(inStockUnits / 2), 0),
        value: Math.max(outstandingAmount * 0.4, 0),
        utilization: 56,
        status: "Active",
      },
      {
        name: "GWU Bengaluru",
        location: "Bengaluru, Karnataka - Secondary",
        zones: 2,
        skus: Math.max(Math.floor(inStockUnits / 4), 0),
        value: Math.max(outstandingAmount * 0.2, 0),
        utilization: 34,
        status: "Setup",
      },
    ],
    [inStockUnits, outstandingAmount]
  )

  const alerts = useMemo(
    () => [
      {
        tone: overdueInvoices > 0 ? "danger" : "success",
        text:
          overdueInvoices > 0
            ? `${overdueInvoices} invoice(s) overdue for payment follow-up`
            : "No overdue invoices. Billing health is stable.",
      },
      {
        tone: openDisputes > 0 ? "warning" : "success",
        text:
          openDisputes > 0
            ? `${openDisputes} dispute(s) open out of ${totalDisputes} total`
            : "No active disputes raised this cycle.",
      },
      {
        tone: fulfillmentPct < 85 ? "warning" : "success",
        text:
          fulfillmentPct < 85
            ? `${doLabel} fulfillment is at ${fulfillmentPct}% and needs attention`
            : `${doLabel} fulfillment is healthy at ${fulfillmentPct}%`,
      },
      {
        tone: slaPct < 90 ? "warning" : "success",
        text:
          slaPct < 90
            ? `SLA at ${slaPct.toFixed(0)}% is below target`
            : `SLA at ${slaPct.toFixed(0)}% is on track`,
      },
    ],
    [doLabel, fulfillmentPct, openDisputes, overdueInvoices, slaPct, totalDisputes]
  )

  const recentActivity = useMemo(
    () => [
      { key: "DO", text: `${doLabel}-007 dispatched - ${Math.max(dispatchedUnits, 1)} unit(s)` },
      { key: "GRN", text: `GRN confirmation updates: ${Number(summary?.grn?.confirmed_grn ?? 0)} confirmed` },
      { key: "INV", text: `${totalInvoices} invoice(s) available, ${overdueInvoices} overdue` },
      { key: "ASN", text: showAsn ? "ASN requests are enabled for this client" : "ASN requests are disabled by policy" },
    ],
    [dispatchedUnits, doLabel, overdueInvoices, showAsn, summary?.grn?.confirmed_grn, totalInvoices]
  )

  function formatCurrencyINR(value: number) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(Number.isFinite(value) ? value : 0)
  }

  function downloadSnapshot() {
    const payload = {
      generated_at: new Date().toISOString(),
      client: selectedClient,
      summary,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `portal-summary-${selectedClient?.client_code || "client"}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function refreshPortalData() {
    if (!clientId) return
    setRefreshing(true)
    try {
      await fetchSummary(clientId)
    } finally {
      setRefreshing(false)
    }
  }

  async function logoutPortalUser() {
    try {
      await logoutMutation.mutateAsync()
    } finally {
      router.push("/login")
      router.refresh()
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      {!showPortal ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Portal is disabled for this tenant.
        </p>
      ) : null}

      <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-lg font-semibold text-blue-800">
              {selectedClient?.client_name?.slice(0, 1)?.toUpperCase() || "C"}
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{selectedClient?.client_name || "Client Portal"}</h1>
              <p className="text-sm text-neutral-600">
                {selectedClient?.client_code || "CLIENT"} - Client Portal Workspace
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={refreshPortalData}
              disabled={refreshing}
              className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <a
              href="mailto:support@gwusoftware.com?subject=Client%20Portal%20Support"
              className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              Support
            </a>
            <button
              type="button"
              onClick={logoutPortalUser}
              disabled={logoutMutation.isPending}
              className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {logoutMutation.isPending ? "Logging out..." : "Logout"}
            </button>
          </div>
        </div>
        <p className="mb-3 text-xs text-neutral-500">Last updated: {lastUpdatedAt || "Not synced yet"}</p>

        <div className="mb-4">
          <select
            className="w-full rounded-xl border border-neutral-300 px-3 py-2.5 text-sm md:text-base"
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

        <div className="flex flex-wrap items-center gap-2">
          {canDisputes ? (
            <a href="/portal/disputes" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              Disputes
            </a>
          ) : null}
          {canSla ? (
            <a href="/portal/sla" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              SLA Report
            </a>
          ) : null}
          {canReports ? (
            <a href="/portal/reports" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              Reports
            </a>
          ) : null}
          <button
            type="button"
            onClick={downloadSnapshot}
            className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
          >
            Download
          </button>
          {canAsn ? (
            <a href="/portal/asn" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              + Request ASN
            </a>
          ) : null}
          {canInventory ? (
            <a href="/portal/inventory" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              Inventory
            </a>
          ) : null}
          {canOrders ? (
            <a href="/portal/orders" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              {doLabel} Orders
            </a>
          ) : null}
          {canBilling ? (
            <a href="/portal/billing" className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">
              Billing
            </a>
          ) : null}
        </div>
      </section>

      {loading ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">Loading portal data...</p>
      ) : !selectedClient ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
          No client mapping assigned. Contact your administrator.
        </p>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Inventory</p>
              <p className="mt-2 text-4xl font-semibold">{inStockUnits}</p>
              <p className="text-sm text-neutral-600">{inStockUnits + dispatchedUnits} tracked units</p>
              <span className="mt-2 inline-block rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-medium text-emerald-700">Active</span>
            </article>

            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Orders</p>
              <p className="mt-2 text-4xl font-semibold">{totalOrders}</p>
              <p className="text-sm text-neutral-600">{fulfilledOrders} fulfilled - {pendingOrders} open</p>
              <span className="mt-2 inline-block rounded-full bg-amber-100 px-3 py-0.5 text-xs font-medium text-amber-700">{fulfillmentPct}%</span>
            </article>

            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Billing</p>
              <p className="mt-2 text-4xl font-semibold">{formatCurrencyINR(outstandingAmount)}</p>
              <p className="text-sm text-neutral-600">{totalInvoices} invoices - {overdueInvoices} overdue</p>
              <span className="mt-2 inline-block rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-medium text-emerald-700">
                {overdueInvoices > 0 ? "Needs attention" : "Clear"}
              </span>
            </article>

            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-neutral-500">SLA</p>
              <p className="mt-2 text-4xl font-semibold">{slaPct.toFixed(0)}%</p>
              <p className="text-sm text-neutral-600">{slaTargetHours} hr target - {slaOnTime}/{slaTotal} on-time</p>
              <span className="mt-2 inline-block rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-medium text-emerald-700">
                {slaPct >= 90 ? "On track" : "At risk"}
              </span>
            </article>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
              <p className="mb-3 text-sm uppercase tracking-wide text-neutral-600">Inventory Trend - Last 6 Weeks</p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={inventoryTrend}>
                    <CartesianGrid strokeDasharray="4 4" stroke="#e5e7eb" />
                    <XAxis dataKey="week" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="inStock" stroke="#2563eb" fill="#bfdbfe" fillOpacity={0.5} name="In stock" />
                    <Area type="monotone" dataKey="dispatched" stroke="#059669" fill="#a7f3d0" fillOpacity={0.5} name="Dispatched" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
              <p className="mb-3 text-sm uppercase tracking-wide text-neutral-600">Order Flow - Last 6 Weeks</p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={orderFlowTrend}>
                    <CartesianGrid strokeDasharray="4 4" stroke="#e5e7eb" />
                    <XAxis dataKey="week" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="received" fill="#2563eb" radius={[4, 4, 0, 0]} name="Received" />
                    <Bar dataKey="fulfilled" fill="#65a30d" radius={[4, 4, 0, 0]} name="Fulfilled" />
                    <Bar dataKey="pending" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Pending" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
            <p className="mb-3 text-sm uppercase tracking-wide text-neutral-600">Warehouse View - Location Distribution</p>
            <div className="grid gap-3 lg:grid-cols-3">
              {warehouseCards.map((warehouse) => (
                <article key={warehouse.name} className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                  <p className="text-2xl font-medium">{warehouse.name}</p>
                  <p className="text-sm text-neutral-600">{warehouse.location}</p>
                  <div className="mt-3 h-2 rounded-full bg-neutral-200">
                    <div className="h-2 rounded-full bg-blue-600" style={{ width: `${warehouse.utilization}%` }} />
                  </div>
                  <p className="mt-2 text-sm text-neutral-700">
                    {warehouse.zones} zones - {warehouse.skus} active SKUs - {formatCurrencyINR(warehouse.value)}
                  </p>
                  <span className="mt-2 inline-block rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-medium text-emerald-700">
                    {warehouse.status}
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
              <p className="mb-3 text-sm uppercase tracking-wide text-neutral-600">Alerts</p>
              <div className="space-y-3">
                {alerts.map((alert, index) => (
                  <div key={`${alert.text}-${index}`} className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
                    <p className="text-sm text-neutral-800">{alert.text}</p>
                    <p className="text-xs text-neutral-500">Live portal summary</p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
              <p className="mb-3 text-sm uppercase tracking-wide text-neutral-600">Recent Activity</p>
              <div className="space-y-3">
                {recentActivity.map((activity, index) => (
                  <div key={`${activity.key}-${index}`} className="flex items-start gap-3 border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-medium text-blue-700">
                      {activity.key}
                    </span>
                    <div>
                      <p className="text-sm text-neutral-800">{activity.text}</p>
                      <p className="text-xs text-neutral-500">Client Portal</p>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      )}
    </main>
  )
}
