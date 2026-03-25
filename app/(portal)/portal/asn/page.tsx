"use client"

import { FormEvent, useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_name: string
  client_code: string
}

export default function PortalAsnPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [expectedDate, setExpectedDate] = useState("")
  const [remarks, setRemarks] = useState("")
  const [message, setMessage] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [asnEnabled, setAsnEnabled] = useState(true)

  useEffect(() => {
    void (async () => {
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      const features = policyJson?.data?.features || {}
      setAsnEnabled(features.portal !== false && (features.grn !== false || features.do !== false))

      const res = await fetch("/api/portal/clients", { cache: "no-store" })
      const json = await res.json()
      const rows = (json?.data || []) as PortalClient[]
      setClients(rows)
      if (rows.length) setClientId(rows[0].id)
    })()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!clientId || !asnEnabled) return
    setSubmitting(true)
    setMessage("")
    const res = await fetch("/api/portal/asn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        expected_date: expectedDate || undefined,
        remarks: remarks || undefined,
      }),
    })
    const json = await res.json()
    if (res.ok) {
      setMessage(`ASN request submitted: ${json?.data?.request_number || "created"}`)
      setExpectedDate("")
      setRemarks("")
    } else {
      setMessage(json?.error?.message || "Failed to submit ASN request")
    }
    setSubmitting(false)
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Request ASN</h1>
      <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
        {!asnEnabled ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            ASN request is disabled by tenant policy.
          </p>
        ) : null}
        <div>
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

        <div>
          <label className="mb-2 block text-sm font-medium">Expected Date</label>
          <input
            type="date"
            className="w-full rounded-md border px-3 py-2"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Remarks</label>
          <textarea
            className="w-full rounded-md border px-3 py-2"
            rows={4}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Shipment details..."
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !clientId || !asnEnabled}
          className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-60"
        >
          {submitting ? "Submitting..." : "Submit Request"}
        </button>
      </form>
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
    </main>
  )
}
