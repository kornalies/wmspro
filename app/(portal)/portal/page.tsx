"use client"

/**
 * The overview: what needs the client's attention, then the account at a glance.
 *
 * The header, client switcher, navigation and logout used to live here and were the
 * reason this file ran to 500 lines; they are the shell's job now.
 *
 * The Alerts card that sat at the bottom is gone. It rendered four rows on every
 * visit, three of which normally said some version of "healthy" -- so the one row
 * that mattered was buried under three that never did, at the end of a long scroll.
 * Only the things a client can act on are surfaced now, at the top, each linking to
 * the screen where they can act.
 *
 * An "Inventory Trend - Last 6 Weeks" area chart, an "Order Flow" bar chart, and a
 * warehouse distribution grid used to sit mid-page. All three were driven by array
 * literals that nothing ever wrote to, so every client saw three empty frames.
 * Removed rather than left dark: an empty panel promising six weeks of history
 * reads as broken data, not as an absent feature. If trends come back they need
 * weekly aggregates from /api/portal/reports, not client-side state.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"

import { PortalUpdates } from "@/components/portal/PortalUpdates"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatMoney, formatMoneyCompact, formatQuantity, toNumber } from "@/lib/portal-format"

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
  disputes?: { total_disputes?: number; open_disputes?: number }
  sla?: {
    dispatch_target_hours?: number
    warning_threshold_pct?: number
    total_orders_90d?: number
    on_time_orders_90d?: number
    on_time_pct?: number
  }
}

function Tile({
  label,
  value,
  detail,
  chip,
  tone,
  href,
  loading,
}: {
  label: string
  value: string
  detail: string
  chip: string
  tone: "ok" | "warn" | "bad"
  href?: string
  loading: boolean
}) {
  const chipClass =
    tone === "bad"
      ? "bg-red-100 text-red-800"
      : tone === "warn"
        ? "bg-amber-100 text-amber-900"
        : "bg-emerald-100 text-emerald-800"

  const body = (
    <article className="h-full rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm transition group-hover:border-neutral-300">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      {loading ? (
        <>
          <div className="mt-3 h-8 w-24 animate-pulse rounded bg-neutral-200" />
          <div className="mt-2 h-3 w-32 animate-pulse rounded bg-neutral-100" />
        </>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-neutral-900">{value}</p>
          <p className="mt-0.5 text-sm text-neutral-600">{detail}</p>
          <span className={`mt-2 inline-block rounded-full px-3 py-0.5 text-xs font-medium ${chipClass}`}>
            {chip}
          </span>
        </>
      )}
    </article>
  )

  return href && !loading ? (
    <Link href={href} className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
      {body}
    </Link>
  ) : (
    body
  )
}

export default function ClientPortalPage() {
  const { client, can, canCreateAsn, doLabel, portalEnabled, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null
  const clientQuery = client ? `?client=${encodeURIComponent(client.client_code)}` : ""

  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [lastUpdatedAt, setLastUpdatedAt] = useState("")

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/reports?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setSummary(null)
      } else {
        setSummary((json?.data || null) as PortalSummary | null)
        setLastUpdatedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }))
      }
    } catch {
      setError("Check your connection and try again.")
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    void load()
  }, [load])

  const inStockUnits = toNumber(summary?.stock?.in_stock_units)
  const dispatchedUnits = toNumber(summary?.stock?.dispatched_units)
  const totalOrders = toNumber(summary?.orders?.total_do)
  const fulfilledOrders = toNumber(summary?.orders?.fulfilled_do)
  const pendingOrders = Math.max(totalOrders - fulfilledOrders, 0)
  const totalInvoices = toNumber(summary?.billing?.total_invoices)
  const overdueInvoices = toNumber(summary?.billing?.overdue_invoices)
  const outstandingAmount = toNumber(summary?.billing?.outstanding_amount)
  const overdueAmount = toNumber(summary?.billing?.overdue_amount)
  const openItems = toNumber(summary?.billing?.open_items)
  const agedAsOf = String(summary?.billing?.aged_as_of ?? "")
  const openDisputes = toNumber(summary?.disputes?.open_disputes)
  const slaTargetHours = toNumber(summary?.sla?.dispatch_target_hours ?? 48)
  const slaOnTime = toNumber(summary?.sla?.on_time_orders_90d)
  const slaTotal = toNumber(summary?.sla?.total_orders_90d)
  const slaPct = toNumber(summary?.sla?.on_time_pct ?? 100)
  const slaThreshold = toNumber(summary?.sla?.warning_threshold_pct ?? 90)
  const fulfillmentPct = totalOrders > 0 ? Math.round((fulfilledOrders / totalOrders) * 100) : 100

  // Ageing runs from each invoice's due date. Labelled "Not yet due" rather than
  // "Current" because a client reading their own statement is not an accountant.
  const agingBands = [
    { label: "Not yet due", value: toNumber(summary?.billing?.aging?.current), tone: "text-emerald-700" },
    { label: "1-30 days", value: toNumber(summary?.billing?.aging?.bucket_1_30), tone: "text-amber-700" },
    { label: "31-60 days", value: toNumber(summary?.billing?.aging?.bucket_31_60), tone: "text-orange-700" },
    { label: "61-90 days", value: toNumber(summary?.billing?.aging?.bucket_61_90), tone: "text-red-600" },
    { label: "90+ days", value: toNumber(summary?.billing?.aging?.bucket_90_plus), tone: "text-red-700" },
  ]

  /**
   * Only what the client can do something about. An empty list is the good case
   * and renders nothing at all -- "everything is fine" does not need a panel.
   */
  const attention = useMemo(() => {
    const items: Array<{ key: string; text: string; href: string; cta: string; tone: "bad" | "warn" }> = []

    if (overdueInvoices > 0 && can.billing) {
      items.push({
        key: "overdue",
        text: `${formatMoney(overdueAmount)} is past its due date across ${overdueInvoices} ${overdueInvoices === 1 ? "invoice" : "invoices"}.`,
        href: `/portal/billing${clientQuery}`,
        cta: "Review billing",
        tone: "bad",
      })
    }
    if (openDisputes > 0 && can.disputes) {
      items.push({
        key: "disputes",
        text: `${openDisputes} of your queries ${openDisputes === 1 ? "is" : "are"} still open with us.`,
        href: `/portal/disputes${clientQuery}`,
        cta: "See queries",
        tone: "warn",
      })
    }
    if (pendingOrders > 0 && can.orders) {
      items.push({
        key: "orders",
        text: `${pendingOrders} ${doLabel} ${pendingOrders === 1 ? "order has" : "orders have"} not been fully dispatched.`,
        href: `/portal/orders${clientQuery}`,
        cta: "Track orders",
        tone: "warn",
      })
    }
    if (slaTotal > 0 && slaPct < slaThreshold && can.performance) {
      items.push({
        key: "sla",
        text: `On-time dispatch is at ${slaPct.toFixed(0)}%, below your ${slaThreshold}% target.`,
        href: `/portal/sla${clientQuery}`,
        cta: "See performance",
        tone: "warn",
      })
    }
    return items
  }, [
    can.billing,
    can.disputes,
    can.orders,
    can.performance,
    clientQuery,
    doLabel,
    openDisputes,
    overdueAmount,
    overdueInvoices,
    pendingOrders,
    slaPct,
    slaThreshold,
    slaTotal,
  ])

  function downloadSnapshot() {
    // Still JSON, and still the wrong format for a finance team -- a statement of
    // account as PDF/CSV is what this should become once the document engine is
    // wired to the portal.
    const payload = { generated_at: new Date().toISOString(), client, summary }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `portal-summary-${client?.client_code || "client"}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const busy = loading || scopeLoading

  if (!portalEnabled) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        The client portal is not enabled for this account. Please contact your warehouse provider.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            {client?.client_name || "Overview"}
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            {lastUpdatedAt ? `Updated at ${lastUpdatedAt}` : "Your account at a glance"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={busy}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={downloadSnapshot}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            Download snapshot
          </button>
          {canCreateAsn ? (
            // The one thing a client comes here to create rather than read, so it
            // is the only filled control on the page.
            <Link
              href={`/portal/asn${clientQuery}`}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800"
            >
              Announce a shipment
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-800">We could not load your summary. {error}</p>
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : null}

      {!busy && attention.length > 0 ? (
        <section
          aria-label="Needs your attention"
          className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50"
        >
          <p className="border-b border-amber-200 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-amber-900">
            Needs your attention
          </p>
          <ul className="divide-y divide-amber-200">
            {attention.map((item) => (
              <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <p className="text-sm text-amber-950">
                  <span aria-hidden className={item.tone === "bad" ? "mr-2 text-red-700" : "mr-2 text-amber-700"}>
                    {item.tone === "bad" ? "▲" : "●"}
                  </span>
                  {item.text}
                </p>
                <Link
                  href={item.href}
                  className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 transition hover:bg-amber-100"
                >
                  {item.cta}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Inventory"
          value={formatQuantity(inStockUnits)}
          detail={`${formatQuantity(inStockUnits + dispatchedUnits)} units tracked`}
          chip={inStockUnits > 0 ? "In stock" : "Nothing on hand"}
          tone={inStockUnits > 0 ? "ok" : "warn"}
          href={can.inventory ? `/portal/inventory${clientQuery}` : undefined}
          loading={busy}
        />
        <Tile
          label={`${doLabel} orders`}
          value={formatQuantity(totalOrders)}
          detail={`${fulfilledOrders} fulfilled · ${pendingOrders} open`}
          chip={`${fulfillmentPct}% fulfilled`}
          tone={fulfillmentPct >= 85 ? "ok" : "warn"}
          href={can.orders ? `/portal/orders${clientQuery}` : undefined}
          loading={busy}
        />
        <Tile
          label="Billing"
          value={formatMoneyCompact(outstandingAmount)}
          detail={`${totalInvoices} invoices · ${overdueInvoices} overdue`}
          chip={overdueInvoices > 0 ? "Needs attention" : "Clear"}
          tone={overdueInvoices > 0 ? "bad" : "ok"}
          href={can.billing ? `/portal/billing${clientQuery}` : undefined}
          loading={busy}
        />
        <Tile
          label="Performance"
          value={`${slaPct.toFixed(0)}%`}
          detail={`${slaOnTime}/${slaTotal} within ${slaTargetHours} hrs`}
          chip={slaPct >= slaThreshold ? "On track" : "Below target"}
          tone={slaPct >= slaThreshold ? "ok" : "warn"}
          href={can.performance ? `/portal/sla${clientQuery}` : undefined}
          loading={busy}
        />
      </section>

      {openItems > 0 && can.billing ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm uppercase tracking-wide text-neutral-600">Outstanding by age</p>
            <p className="text-xs text-neutral-500">
              {openItems} open {openItems === 1 ? "invoice" : "invoices"}
              {agedAsOf ? ` · aged from due date as at ${agedAsOf}` : ""}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {agingBands.map((band) => (
              <div key={band.label} className="rounded-xl border border-neutral-200 p-3">
                <p className="text-xs text-neutral-500">{band.label}</p>
                <p className={`mt-1 text-xl font-semibold tabular-nums ${band.value > 0 ? band.tone : "text-neutral-300"}`}>
                  {formatMoneyCompact(band.value)}
                </p>
              </div>
            ))}
          </div>
          {overdueAmount > 0 ? (
            <p className="mt-3 text-sm text-red-700">
              {formatMoney(overdueAmount)} of this is past its due date.
            </p>
          ) : null}
        </section>
      ) : null}

      <PortalUpdates />
    </div>
  )
}
