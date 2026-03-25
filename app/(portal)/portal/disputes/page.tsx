"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type DisputeRow = {
  id: number
  dispute_number: string
  invoice_id: number
  invoice_number: string
  category: string
  priority: string
  dispute_reason: string
  dispute_amount: number | null
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "REJECTED" | "CLOSED"
  raised_at: string
  resolved_at: string | null
  raised_by_name: string | null
}

export default function PortalDisputesPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [invoiceId, setInvoiceId] = useState("")
  const [reason, setReason] = useState("")
  const [rows, setRows] = useState<DisputeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function loadDisputes(targetClientId: number) {
    setLoading(true)
    setError("")
    const res = await fetch(`/api/portal/disputes?client_id=${targetClientId}`, { cache: "no-store" })
    const json = await res.json()
    if (!res.ok) {
      setError(json?.error?.message || "Failed to load disputes")
      setRows([])
    } else {
      setRows((json?.data || []) as DisputeRow[])
    }
    setLoading(false)
  }

  useEffect(() => {
    void (async () => {
      const clientsRes = await fetch("/api/portal/clients", { cache: "no-store" })
      const clientsJson = await clientsRes.json()
      const loadedClients = (clientsJson?.data || []) as PortalClient[]
      setClients(loadedClients)
      const selected = loadedClients[0]?.id ?? null
      setClientId(selected)
      if (selected) await loadDisputes(selected)
      else setLoading(false)
    })()
  }, [])


  async function raiseDispute() {
    if (!clientId) return
    if (!invoiceId || !reason || reason.trim().length < 10) {
      setError("Invoice ID and reason (minimum 10 chars) are required")
      return
    }
    setSaving(true)
    setError("")
    const res = await fetch("/api/portal/disputes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        invoice_id: Number(invoiceId),
        dispute_reason: reason.trim(),
        category: "BILLING_AMOUNT",
        priority: "MEDIUM",
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json?.error?.message || "Failed to create dispute")
    } else {
      setInvoiceId("")
      setReason("")
      await loadDisputes(clientId)
    }
    setSaving(false)
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal Disputes</h1>
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
            if (nextClientId) void loadDisputes(nextClientId)
          }}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.client_name} ({client.client_code})
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 grid gap-2 rounded-lg border p-4 md:grid-cols-4">
        <input
          className="rounded border px-3 py-2 text-sm"
          placeholder="Invoice ID"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
        />
        <input
          className="rounded border px-3 py-2 text-sm md:col-span-2"
          placeholder="Dispute reason (min 10 chars)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
          onClick={raiseDispute}
          disabled={saving}
        >
          {saving ? "Submitting..." : "Raise Dispute"}
        </button>
      </div>

      {loading ? <p className="text-sm text-neutral-600">Loading disputes...</p> : null}
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {!loading ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-3 py-2 text-left">Dispute #</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">Priority</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-left">Raised</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{row.dispute_number}</td>
                  <td className="px-3 py-2">{row.invoice_number}</td>
                  <td className="px-3 py-2">{row.category}</td>
                  <td className="px-3 py-2">{row.priority}</td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2">{row.dispute_reason}</td>
                  <td className="px-3 py-2">{new Date(row.raised_at).toLocaleString("en-IN")}</td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td className="px-3 py-4 text-center text-neutral-500" colSpan={7}>
                    No disputes found.
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
