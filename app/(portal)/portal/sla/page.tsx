"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

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

export default function PortalSlaPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [data, setData] = useState<SlaResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [canManage, setCanManage] = useState(false)

  const [dispatchTargetHours, setDispatchTargetHours] = useState("48")
  const [invoiceApprovalDueDays, setInvoiceApprovalDueDays] = useState("5")
  const [disputeResolutionHours, setDisputeResolutionHours] = useState("72")
  const [warningThresholdPct, setWarningThresholdPct] = useState("90")

  async function loadSla(targetClientId: number) {
    setLoading(true)
    setError("")
    const res = await fetch(`/api/portal/sla?client_id=${targetClientId}`, { cache: "no-store" })
    const json = await res.json()
    if (!res.ok) {
      setError(json?.error?.message || "Failed to load SLA")
      setData(null)
    } else {
      const payload = (json?.data || null) as SlaResponse | null
      setData(payload)
      setDispatchTargetHours(String(payload?.policy?.dispatch_target_hours ?? 48))
      setInvoiceApprovalDueDays(String(payload?.policy?.invoice_approval_due_days ?? 5))
      setDisputeResolutionHours(String(payload?.policy?.dispute_resolution_hours ?? 72))
      setWarningThresholdPct(String(payload?.policy?.warning_threshold_pct ?? 90))
    }
    setLoading(false)
  }

  useEffect(() => {
    void (async () => {
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      const permissions = (policyJson?.data?.permissions || []) as string[]
      setCanManage(permissions.includes("portal.sla.manage"))

      const clientsRes = await fetch("/api/portal/clients", { cache: "no-store" })
      const clientsJson = await clientsRes.json()
      const loadedClients = (clientsJson?.data || []) as PortalClient[]
      setClients(loadedClients)
      const selected = loadedClients[0]?.id ?? null
      setClientId(selected)
      if (selected) await loadSla(selected)
      else setLoading(false)
    })()
  }, [])


  async function saveSla() {
    if (!clientId) return
    setSaving(true)
    setError("")
    const res = await fetch("/api/portal/sla", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        dispatch_target_hours: Number(dispatchTargetHours || 48),
        invoice_approval_due_days: Number(invoiceApprovalDueDays || 5),
        dispute_resolution_hours: Number(disputeResolutionHours || 72),
        warning_threshold_pct: Number(warningThresholdPct || 90),
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json?.error?.message || "Failed to save SLA")
    } else {
      await loadSla(clientId)
    }
    setSaving(false)
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal SLA</h1>
        <a href="/portal" className="rounded-md border px-4 py-2 text-sm">
          Back to Portal
        </a>
      </div>

      <div className="mb-4 rounded-lg border p-4">
        <label className="mb-2 block text-sm font-medium">Client</label>
        <select
          className="w-full rounded-md border px-3 py-2"
          value={clientId ?? ""}
          onChange={(e) => {
            const nextClientId = Number(e.target.value)
            setClientId(nextClientId)
            if (nextClientId) void loadSla(nextClientId)
          }}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.client_name} ({client.client_code})
            </option>
          ))}
        </select>
      </div>

      {loading ? <p className="text-sm text-neutral-600">Loading SLA...</p> : null}
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {!loading && data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-lg font-medium">SLA Policy</h2>
            <div className="grid gap-2">
              <label className="text-sm">
                Dispatch Target (hours)
                <input
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={dispatchTargetHours}
                  onChange={(e) => setDispatchTargetHours(e.target.value)}
                  disabled={!canManage}
                />
              </label>
              <label className="text-sm">
                Invoice Approval Due (days)
                <input
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={invoiceApprovalDueDays}
                  onChange={(e) => setInvoiceApprovalDueDays(e.target.value)}
                  disabled={!canManage}
                />
              </label>
              <label className="text-sm">
                Dispute Resolution (hours)
                <input
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={disputeResolutionHours}
                  onChange={(e) => setDisputeResolutionHours(e.target.value)}
                  disabled={!canManage}
                />
              </label>
              <label className="text-sm">
                Warning Threshold (%)
                <input
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={warningThresholdPct}
                  onChange={(e) => setWarningThresholdPct(e.target.value)}
                  disabled={!canManage}
                />
              </label>
              {canManage ? (
                <button
                  className="mt-2 rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
                  disabled={saving}
                  onClick={saveSla}
                >
                  {saving ? "Saving..." : "Save SLA"}
                </button>
              ) : (
                <p className="mt-2 text-xs text-neutral-500">Read-only: SLA can be edited by authorized portal admins.</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-lg font-medium">SLA KPI (90 days)</h2>
            <p className="text-sm">Orders: {data.kpi.total_orders_90d ?? 0}</p>
            <p className="text-sm">On-time Orders: {data.kpi.on_time_orders_90d ?? 0}</p>
            <p className="text-sm">On-time %: {Number(data.kpi.order_on_time_pct ?? 0).toFixed(2)}%</p>
            <p className="mt-3 text-sm">Resolved Disputes: {data.kpi.resolved_disputes_90d ?? 0}</p>
            <p className="text-sm">Resolved within SLA: {data.kpi.in_sla_disputes_90d ?? 0}</p>
            <p className="text-sm">Dispute SLA %: {Number(data.kpi.dispute_sla_pct ?? 0).toFixed(2)}%</p>
          </section>
        </div>
      ) : null}
    </main>
  )
}
