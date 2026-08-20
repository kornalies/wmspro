"use client"

/**
 * The account at a glance, in one printable place.
 *
 * Deliberately the same figures as the overview screen rather than a second set:
 * two screens disagreeing about how many invoices are open is worse than one
 * screen repeating itself. The overview is for acting on; this is for reading and
 * exporting.
 */

import { useCallback, useEffect, useState } from "react"

import { PortalPage } from "@/components/portal/PortalPage"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatMoney, formatQuantity, toNumber } from "@/lib/portal-format"

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
  disputes?: { total_disputes?: number; open_disputes?: number }
  sla?: {
    dispatch_target_hours?: number
    total_orders_90d?: number
    on_time_orders_90d?: number
    on_time_pct?: number
  }
}

type Panel = { title: string; lines: Array<{ label: string; value: string }> }

export default function PortalReportsPage() {
  const { client, can, doLabel, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null

  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

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
      }
    } catch {
      setError("Check your connection and try again.")
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!can.reports) {
      setLoading(false)
      return
    }
    void load()
  }, [can.reports, load])

  const panels: Panel[] = [
    {
      title: "Inventory",
      lines: [
        { label: "In stock", value: formatQuantity(summary?.stock?.in_stock_units) },
        { label: "Dispatched to date", value: formatQuantity(summary?.stock?.dispatched_units) },
      ],
    },
    {
      title: `${doLabel} orders`,
      lines: [
        { label: "Total raised", value: formatQuantity(summary?.orders?.total_do) },
        { label: "Fulfilled", value: formatQuantity(summary?.orders?.fulfilled_do) },
      ],
    },
    {
      title: "Inbound receipts",
      lines: [
        { label: "Receipts booked", value: formatQuantity(summary?.grn?.total_grn) },
        { label: "Confirmed", value: formatQuantity(summary?.grn?.confirmed_grn) },
      ],
    },
    {
      title: "Billing",
      lines: [
        { label: "Invoices issued", value: formatQuantity(summary?.billing?.total_invoices) },
        { label: "Overdue", value: formatQuantity(summary?.billing?.overdue_invoices) },
        { label: "Outstanding", value: formatMoney(summary?.billing?.outstanding_amount) },
      ],
    },
    {
      title: "Disputes",
      lines: [
        { label: "Raised", value: formatQuantity(summary?.disputes?.total_disputes) },
        { label: "Still open", value: formatQuantity(summary?.disputes?.open_disputes) },
      ],
    },
    {
      title: "Service level (90 days)",
      lines: [
        { label: "Dispatch target", value: `${formatQuantity(summary?.sla?.dispatch_target_hours ?? 48)} hrs` },
        {
          label: "On time",
          value: `${formatQuantity(summary?.sla?.on_time_orders_90d)} of ${formatQuantity(summary?.sla?.total_orders_90d)}`,
        },
        { label: "Compliance", value: `${toNumber(summary?.sla?.on_time_pct ?? 100).toFixed(1)}%` },
      ],
    },
  ]

  const busy = loading || scopeLoading

  return (
    <PortalPage
      title="Reports"
      description={client ? `Account summary for ${client.client_name}.` : "Account summary."}
      denied={
        can.reports
          ? null
          : { reason: "Ask your warehouse provider to enable reporting on your portal account." }
      }
    >
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-medium text-red-900">We could not load your summary.</p>
          <p className="mt-1 text-sm text-red-800">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {panels.map((panel) => (
            <article key={panel.title} className="rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{panel.title}</h2>
              <dl className="mt-3 space-y-2">
                {panel.lines.map((line) => (
                  <div key={line.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-neutral-600">{line.label}</dt>
                    <dd className="text-sm font-semibold tabular-nums text-neutral-900">
                      {busy ? (
                        <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-neutral-200" />
                      ) : (
                        line.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </section>
      )}
    </PortalPage>
  )
}
