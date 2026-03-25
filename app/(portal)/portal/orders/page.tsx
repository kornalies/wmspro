"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type OrderRow = {
  id: number
  do_number: string
  request_date: string | null
  dispatch_date: string | null
  status: string
  total_items: number
  total_quantity_requested: number
  total_quantity_dispatched: number
}

export default function PortalOrdersPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [portalEnabled, setPortalEnabled] = useState(true)
  const [ordersEnabled, setOrdersEnabled] = useState(true)
  const [doLabel, setDoLabel] = useState("DO")

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError("")
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      const features = policyJson?.data?.features || {}
      setPortalEnabled(features.portal !== false)
      setOrdersEnabled(features.do !== false)
      setDoLabel(policyJson?.data?.branding?.labels?.do || "DO")

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
    if (!clientId || !portalEnabled || !ordersEnabled) return
    void (async () => {
      setLoading(true)
      setError("")
      const res = await fetch(`/api/portal/orders?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Failed to load orders")
        setRows([])
      } else {
        setRows((json?.data || []) as OrderRow[])
      }
      setLoading(false)
    })()
  }, [clientId, portalEnabled, ordersEnabled])

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal {doLabel} Orders</h1>
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

      {!portalEnabled || !ordersEnabled ? (
        <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Order view is disabled by tenant policy.
        </p>
      ) : null}

      {loading ? <p className="text-sm text-neutral-600">Loading orders...</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!loading && !error ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-3 py-2 text-left">DO Number</th>
                <th className="px-3 py-2 text-left">Request Date</th>
                <th className="px-3 py-2 text-left">Dispatch Date</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Qty Requested</th>
                <th className="px-3 py-2 text-right">Qty Dispatched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2">{row.do_number}</td>
                  <td className="px-3 py-2">{row.request_date || "-"}</td>
                  <td className="px-3 py-2">{row.dispatch_date || "-"}</td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2 text-right">{row.total_items}</td>
                  <td className="px-3 py-2 text-right">{row.total_quantity_requested}</td>
                  <td className="px-3 py-2 text-right">{row.total_quantity_dispatched}</td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td className="px-3 py-4 text-center text-neutral-500" colSpan={7}>
                    No order records found.
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
