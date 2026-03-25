"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type BillingRow = {
  id: number
  invoice_number: string
  invoice_date: string | null
  due_date: string | null
  status: string
  client_action_status: string
  client_action_at: string | null
  open_disputes: number
  currency_code: string
  net_amount: number
  tax_amount: number
  total_amount: number
  paid_amount: number
  balance_amount: number
}

export default function PortalBillingPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [rows, setRows] = useState<BillingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [portalEnabled, setPortalEnabled] = useState(true)
  const [billingEnabled, setBillingEnabled] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError("")
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      const features = policyJson?.data?.features || {}
      const permissions = (policyJson?.data?.permissions || []) as string[]
      setPortalEnabled(features.portal !== false)
      setBillingEnabled(
        features.billing !== false &&
          (permissions.includes("billing.view") || permissions.includes("finance.view"))
      )

      const clientsRes = await fetch("/api/portal/clients", { cache: "no-store" })
      const clientsJson = await clientsRes.json()
      const loadedClients = (clientsJson?.data || []) as PortalClient[]
      setClients(loadedClients)
      const selected = loadedClients[0]?.id ?? null
      setClientId(selected)
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!clientId || !portalEnabled || !billingEnabled) return
    void (async () => {
      setLoading(true)
      setError("")
      const res = await fetch(`/api/portal/billing?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Failed to load billing")
        setRows([])
      } else {
        setRows((json?.data || []) as BillingRow[])
      }
      setLoading(false)
    })()
  }, [clientId, portalEnabled, billingEnabled])

  async function runInvoiceAction(invoiceId: number, action: "APPROVE" | "DISPUTE" | "PAY") {
    if (!clientId) return
    let payload: Record<string, unknown> = { client_id: clientId, action }

    if (action === "DISPUTE") {
      const reason = window.prompt("Dispute reason (min 10 chars):", "Invoice amount mismatch")
      if (!reason || reason.trim().length < 10) return
      const amountRaw = window.prompt("Dispute amount (optional):", "")
      const parsedAmount = amountRaw?.trim() ? Number(amountRaw) : undefined
      payload = {
        ...payload,
        dispute_reason: reason.trim(),
        dispute_amount: Number.isFinite(parsedAmount) ? parsedAmount : undefined,
      }
    }

    if (action === "PAY") {
      const invoice = rows.find((r) => r.id === invoiceId)
      const defaultAmount = String(Number(invoice?.balance_amount || 0))
      const amountRaw = window.prompt("Payment amount:", defaultAmount)
      if (!amountRaw) return
      const amount = Number(amountRaw)
      if (!Number.isFinite(amount) || amount <= 0) return
      const refNo = window.prompt("Payment reference number (optional):", "")
      payload = {
        ...payload,
        amount,
        payment_date: new Date().toISOString().slice(0, 10),
        payment_mode: "PORTAL",
        reference_no: refNo?.trim() || undefined,
        notes: "Client self-service payment",
      }
    }

    setBusyId(invoiceId)
    setError("")
    const res = await fetch(`/api/portal/billing/${invoiceId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json?.error?.message || `Failed to ${action.toLowerCase()} invoice`)
    } else {
      const refresh = await fetch(`/api/portal/billing?client_id=${clientId}`, { cache: "no-store" })
      const refreshJson = await refresh.json()
      if (refresh.ok) setRows((refreshJson?.data || []) as BillingRow[])
    }
    setBusyId(null)
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal Billing</h1>
        <a href="/portal" className="rounded-md border px-4 py-2 text-sm">
          Back to Portal
        </a>
      </div>

      <div className="mb-4 rounded-lg border p-4">
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

      <div className="mb-4 rounded-lg border bg-blue-50 p-3 text-xs text-blue-900">
        Self-service lifecycle: Approve invoice, raise dispute, and post payment updates directly from portal.
      </div>

      {!portalEnabled || !billingEnabled ? (
        <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Billing view is disabled by tenant policy.
        </p>
      ) : null}

      {loading ? <p className="text-sm text-neutral-600">Loading billing...</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!loading && !error ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Invoice Date</th>
                <th className="px-3 py-2 text-left">Due Date</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Net</th>
                <th className="px-3 py-2 text-right">Tax</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2 text-left">Client Action</th>
                <th className="px-3 py-2 text-right">Disputes</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2">{row.invoice_number}</td>
                  <td className="px-3 py-2">{row.invoice_date || "-"}</td>
                  <td className="px-3 py-2">{row.due_date || "-"}</td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2 text-right">
                    {row.currency_code} {Number(row.net_amount || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.currency_code} {Number(row.tax_amount || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {row.currency_code} {Number(row.total_amount || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.currency_code} {Number(row.paid_amount || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.currency_code} {Number(row.balance_amount || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded border px-2 py-0.5 text-xs">{row.client_action_status || "PENDING"}</span>
                  </td>
                  <td className="px-3 py-2 text-right">{row.open_disputes || 0}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        className="rounded border px-2 py-1 text-xs"
                        disabled={busyId === row.id}
                        onClick={() => runInvoiceAction(row.id, "APPROVE")}
                      >
                        Approve
                      </button>
                      <button
                        className="rounded border px-2 py-1 text-xs"
                        disabled={busyId === row.id}
                        onClick={() => runInvoiceAction(row.id, "DISPUTE")}
                      >
                        Dispute
                      </button>
                      <button
                        className="rounded border px-2 py-1 text-xs"
                        disabled={busyId === row.id || Number(row.balance_amount || 0) <= 0}
                        onClick={() => runInvoiceAction(row.id, "PAY")}
                      >
                        Pay
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td className="px-3 py-4 text-center text-neutral-500" colSpan={12}>
                    No billing records found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  )
}
