"use client"

/**
 * The agreed service levels, and whether they are being met.
 *
 * Named "Performance" in the nav: SLA is the contract, but what a client opens this
 * screen to find out is how the last ninety days went. The targets stay editable
 * for portal admins who hold portal.sla.manage; everyone else reads them.
 */

import { useCallback, useEffect, useState } from "react"

import { PortalPage } from "@/components/portal/PortalPage"
import { usePortalScope } from "@/components/portal/portal-scope"
import { toNumber } from "@/lib/portal-format"

type SlaResponse = {
  policy: {
    client_id: number
    dispatch_target_hours: number
    invoice_approval_due_days: number
    dispute_resolution_hours: number
    warning_threshold_pct: number
    is_active: boolean
  }
  kpi: {
    total_orders_90d: number
    on_time_orders_90d: number
    order_on_time_pct: number
    resolved_disputes_90d: number
    in_sla_disputes_90d: number
    dispute_sla_pct: number
  }
}

type FormState = {
  dispatch_target_hours: string
  invoice_approval_due_days: string
  dispute_resolution_hours: string
  warning_threshold_pct: string
}

const FIELDS: Array<{ key: keyof FormState; label: string; hint: string }> = [
  { key: "dispatch_target_hours", label: "Dispatch target", hint: "Hours from order to dispatch" },
  { key: "invoice_approval_due_days", label: "Invoice approval window", hint: "Days to approve an invoice" },
  { key: "dispute_resolution_hours", label: "Dispute resolution target", hint: "Hours to resolve a dispute" },
  { key: "warning_threshold_pct", label: "Warning threshold", hint: "Flag below this compliance %" },
]

/**
 * A compliance figure needs a verdict attached, or the reader has to remember the
 * threshold to know whether 88% is fine. The threshold is the client's own.
 */
function meter(pct: number, threshold: number) {
  if (pct >= threshold) return { tone: "text-emerald-700", bar: "bg-emerald-500", verdict: "On track" }
  if (pct >= threshold - 10) return { tone: "text-amber-700", bar: "bg-amber-500", verdict: "Slipping" }
  return { tone: "text-red-700", bar: "bg-red-500", verdict: "Below target" }
}

function ComplianceCard({
  title,
  pct,
  detail,
  threshold,
  loading,
}: {
  title: string
  pct: number
  detail: string
  threshold: number
  loading: boolean
}) {
  const { tone, bar, verdict } = meter(pct, threshold)
  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {loading ? (
        <div className="mt-3 space-y-2">
          <div className="h-8 w-24 animate-pulse rounded bg-neutral-200" />
          <div className="h-2 w-full animate-pulse rounded bg-neutral-100" />
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <p className={`text-3xl font-semibold tabular-nums ${tone}`}>{pct.toFixed(1)}%</p>
            <p className={`text-sm font-medium ${tone}`}>{verdict}</p>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100">
            <div
              className={`h-full rounded-full ${bar}`}
              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
              role="img"
              aria-label={`${pct.toFixed(1)} percent, target ${threshold} percent`}
            />
          </div>
          <p className="mt-2 text-sm text-neutral-600">{detail}</p>
          <p className="mt-0.5 text-xs text-neutral-400">Your target is {threshold}%</p>
        </>
      )}
    </article>
  )
}

export default function PortalPerformancePage() {
  const { client, can, canManageSla, doLabel, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null

  const [data, setData] = useState<SlaResponse | null>(null)
  const [form, setForm] = useState<FormState>({
    dispatch_target_hours: "48",
    invoice_approval_due_days: "5",
    dispute_resolution_hours: "72",
    warning_threshold_pct: "90",
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState("")

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/sla?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setData(null)
      } else {
        const payload = (json?.data || null) as SlaResponse | null
        setData(payload)
        setForm({
          dispatch_target_hours: String(payload?.policy?.dispatch_target_hours ?? 48),
          invoice_approval_due_days: String(payload?.policy?.invoice_approval_due_days ?? 5),
          dispute_resolution_hours: String(payload?.policy?.dispute_resolution_hours ?? 72),
          warning_threshold_pct: String(payload?.policy?.warning_threshold_pct ?? 90),
        })
      }
    } catch {
      setError("Check your connection and try again.")
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!can.performance) {
      setLoading(false)
      return
    }
    void load()
  }, [can.performance, load])

  async function saveTargets() {
    if (!clientId) return
    setSaving(true)
    setError("")
    setSaved("")
    try {
      const res = await fetch("/api/portal/sla", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          dispatch_target_hours: Number(form.dispatch_target_hours || 48),
          invoice_approval_due_days: Number(form.invoice_approval_due_days || 5),
          dispute_resolution_hours: Number(form.dispute_resolution_hours || 72),
          warning_threshold_pct: Number(form.warning_threshold_pct || 90),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Your targets were not saved.")
      } else {
        setSaved("Targets saved.")
        await load()
      }
    } catch {
      setError("Your targets were not saved. Check your connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  const threshold = toNumber(data?.policy?.warning_threshold_pct ?? 90)
  const orderPct = toNumber(data?.kpi?.order_on_time_pct ?? 0)
  const disputePct = toNumber(data?.kpi?.dispute_sla_pct ?? 0)
  const busy = loading || scopeLoading

  return (
    <PortalPage
      title="Performance"
      description="How we have performed against your agreed service levels over the last 90 days."
      denied={
        can.performance
          ? null
          : { reason: "Ask your warehouse provider to enable service level reporting on your portal account." }
      }
    >
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2">
        <ComplianceCard
          title={`${doLabel} dispatch on time`}
          pct={orderPct}
          threshold={threshold}
          loading={busy}
          detail={`${toNumber(data?.kpi?.on_time_orders_90d)} of ${toNumber(data?.kpi?.total_orders_90d)} orders met the ${toNumber(data?.policy?.dispatch_target_hours ?? 48)} hour target.`}
        />
        <ComplianceCard
          title="Disputes resolved in time"
          pct={disputePct}
          threshold={threshold}
          loading={busy}
          detail={`${toNumber(data?.kpi?.in_sla_disputes_90d)} of ${toNumber(data?.kpi?.resolved_disputes_90d)} resolved disputes met the ${toNumber(data?.policy?.dispute_resolution_hours ?? 72)} hour target.`}
        />
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">Agreed targets</h2>
          {!canManageSla ? (
            <p className="text-xs text-neutral-500">
              Read only — targets are set by your account administrator.
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label htmlFor={`sla-${field.key}`} className="block text-sm font-medium text-neutral-800">
                {field.label}
              </label>
              <input
                id={`sla-${field.key}`}
                type="number"
                inputMode="numeric"
                min={0}
                value={form[field.key]}
                disabled={!canManageSla || busy}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm tabular-nums disabled:bg-neutral-50 disabled:text-neutral-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              <p className="mt-1 text-xs text-neutral-500">{field.hint}</p>
            </div>
          ))}
        </div>

        {canManageSla ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={saveTargets}
              disabled={saving || busy}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save targets"}
            </button>
            {saved ? <p className="text-sm text-emerald-700">{saved}</p> : null}
          </div>
        ) : null}
      </section>
    </PortalPage>
  )
}
