"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useLogout } from "@/hooks/use-auth"
import { PORTAL_LOGIN_PATH } from "@/lib/sign-in-path"

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
    collected_amount?: number
    outstanding_amount?: number
    overdue_amount?: number
    open_items?: number
    aged_as_of?: string
    aging?: {
      current?: number
      bucket_1_30?: number
      bucket_31_60?: number
      bucket_61_90?: number
      bucket_90_plus?: number
    }
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
  const overdueAmount = Number(summary?.billing?.overdue_amount ?? 0)
  const openItems = Number(summary?.billing?.open_items ?? 0)
  const agedAsOf = String(summary?.billing?.aged_as_of ?? "")
  // Ageing runs from each invoice's due date. Labelled "Not yet due" rather than
  // "Current" because a client reading their own statement is not an accountant.
  const agingBands = [
    { label: "Not yet due", value: Number(summary?.billing?.aging?.current ?? 0), tone: "text-emerald-700" },
    { label: "1-30 days", value: Number(summary?.billing?.aging?.bucket_1_30 ?? 0), tone: "text-amber-700" },
    { label: "31-60 days", value: Number(summary?.billing?.aging?.bucket_31_60 ?? 0), tone: "text-orange-700" },
    { label: "61-90 days", value: Number(summary?.billing?.aging?.bucket_61_90 ?? 0), tone: "text-red-600" },
    { label: "90+ days", value: Number(summary?.billing?.aging?.bucket_90_plus ?? 0), tone: "text-red-700" },
  ]
  const totalDisputes = Number(summary?.disputes?.total_disputes ?? 0)
  const openDisputes = Number(summary?.disputes?.open_disputes ?? 0)
  const slaTargetHours = Number(summary?.sla?.dispatch_target_hours ?? 48)
  const slaOnTime = Number(summary?.sla?.on_time_orders_90d ?? 0)
  const slaTotal = Number(summary?.sla?.total_orders_90d ?? 0)
  const slaPct = Number(summary?.sla?.on_time_pct ?? 100)
  const fulfillmentPct = totalOrders > 0 ? Math.round((fulfilledOrders / totalOrders) * 100) : 100

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
    () =>
      [
        totalOrders > 0 ? { key: "DO", text: `${totalOrders} ${doLabel} record(s), ${fulfilledOrders} fulfilled` } : null,
        Number(summary?.grn?.total_grn ?? 0) > 0
          ? {
              key: "GRN",
              text: `${Number(summary?.grn?.total_grn ?? 0)} GRN record(s), ${Number(summary?.grn?.confirmed_grn ?? 0)} confirmed`,
            }
          : null,
        totalInvoices > 0 ? { key: "INV", text: `${totalInvoices} invoice(s) available, ${overdueInvoices} overdue` } : null,
      ].filter((entry): entry is { key: string; text: string } => entry !== null),
    [doLabel, fulfilledOrders, overdueInvoices, summary?.grn?.confirmed_grn, summary?.grn?.total_grn, totalInvoices, totalOrders]
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
      router.push(PORTAL_LOGIN_PATH)
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

        {/*
          Navigation and actions were one undifferentiated row of eight
          identical pills, in an order nothing explained -- Disputes, SLA,
          Reports, Download, ASN, Inventory, Orders, Billing -- with "Download"
          (which produces a file) and "+ Request ASN" (which creates a record)
          sitting among six links that merely change page. Split by what the
          control does, and the links reordered to follow the goods: what you
          hold, what is moving, what it costs, then the exception screens.
        */}
        <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="Portal sections" className="flex flex-wrap items-center gap-1">
            {[
              canInventory ? ["/portal/inventory", "Inventory"] : null,
              canOrders ? ["/portal/orders", `${doLabel} Orders`] : null,
              canBilling ? ["/portal/billing", "Billing"] : null,
              canDisputes ? ["/portal/disputes", "Disputes"] : null,
              canSla ? ["/portal/sla", "SLA"] : null,
              canReports ? ["/portal/reports", "Reports"] : null,
            ]
              .filter((entry): entry is [string, string] => entry !== null)
              .map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-950"
                >
                  {label}
                </a>
              ))}
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={downloadSnapshot}
              className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              Download snapshot
            </button>
            {canAsn ? (
              // The one thing a client comes here to create rather than read,
              // so it is the only filled control on the page.
              <a
                href="/portal/asn"
                className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800"
              >
                Request ASN
              </a>
            ) : null}
          </div>
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
              <span
                className={`mt-2 inline-block rounded-full px-3 py-0.5 text-xs font-medium ${
                  overdueInvoices > 0 ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"
                }`}
              >
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

          {openItems > 0 && (
            <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm uppercase tracking-wide text-neutral-600">Outstanding by Age</p>
                <p className="text-xs text-neutral-500">
                  {openItems} open {openItems === 1 ? "invoice" : "invoices"}
                  {agedAsOf ? ` - aged from due date as at ${agedAsOf}` : ""}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {agingBands.map((band) => (
                  <div key={band.label} className="rounded-xl border border-neutral-200 p-3">
                    <p className="text-xs text-neutral-500">{band.label}</p>
                    <p className={`mt-1 text-xl font-semibold ${band.value > 0 ? band.tone : "text-neutral-300"}`}>
                      {formatCurrencyINR(band.value)}
                    </p>
                  </div>
                ))}
              </div>
              {overdueAmount > 0 && (
                <p className="mt-3 text-sm text-red-700">
                  {formatCurrencyINR(overdueAmount)} of this is past its due date.
                </p>
              )}
            </section>
          )}

          {/*
            An "Inventory Trend - Last 6 Weeks" area chart, an "Order Flow"
            bar chart, and a warehouse distribution grid used to sit here. All
            three were driven by array literals that nothing ever wrote to, so
            every client saw three empty frames and two screens of scrolling to
            reach the alerts below. Removed rather than left dark: an empty panel
            promising six weeks of history reads as broken data, not as an
            absent feature.

            If trends come back, they need weekly aggregates from
            /api/portal/reports -- not client-side state.
          */}

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
                {recentActivity.length ? recentActivity.map((activity, index) => (
                  <div key={`${activity.key}-${index}`} className="flex items-start gap-3 border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-medium text-blue-700">
                      {activity.key}
                    </span>
                    <div>
                      <p className="text-sm text-neutral-800">{activity.text}</p>
                      <p className="text-xs text-neutral-500">Client Portal</p>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-500">
                    No recent portal activity available.
                  </div>
                )}
              </div>
            </article>
          </section>
        </>
      )}
    </main>
  )
}
