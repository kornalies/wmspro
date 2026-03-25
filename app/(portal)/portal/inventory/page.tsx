"use client"

import { useEffect, useState } from "react"

type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type InventoryRow = {
  item_id: number
  item_code: string
  item_name: string
  uom: string
  in_stock_units: number
  dispatched_units: number
}

export default function PortalInventoryPage() {
  const [clients, setClients] = useState<PortalClient[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [portalEnabled, setPortalEnabled] = useState(true)
  const [inventoryEnabled, setInventoryEnabled] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError("")
      const policyRes = await fetch("/api/v1/policy", { cache: "no-store" })
      const policyJson = await policyRes.json()
      const features = policyJson?.data?.features || {}
      setPortalEnabled(features.portal !== false)
      setInventoryEnabled(features.stock !== false)

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
    if (!clientId || !portalEnabled || !inventoryEnabled) return
    void (async () => {
      setLoading(true)
      setError("")
      const res = await fetch(`/api/portal/inventory?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Failed to load inventory")
        setRows([])
      } else {
        setRows((json?.data || []) as InventoryRow[])
      }
      setLoading(false)
    })()
  }, [clientId, portalEnabled, inventoryEnabled])

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Portal Inventory</h1>
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

      {!portalEnabled || !inventoryEnabled ? (
        <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Inventory is disabled by tenant policy.
        </p>
      ) : null}

      {loading ? <p className="text-sm text-neutral-600">Loading inventory...</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!loading && !error ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-3 py-2 text-left">Item Code</th>
                <th className="px-3 py-2 text-left">Item Name</th>
                <th className="px-3 py-2 text-left">UOM</th>
                <th className="px-3 py-2 text-right">In Stock</th>
                <th className="px-3 py-2 text-right">Dispatched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.item_id} className="border-t">
                  <td className="px-3 py-2">{row.item_code}</td>
                  <td className="px-3 py-2">{row.item_name}</td>
                  <td className="px-3 py-2">{row.uom}</td>
                  <td className="px-3 py-2 text-right">{row.in_stock_units}</td>
                  <td className="px-3 py-2 text-right">{row.dispatched_units}</td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td className="px-3 py-4 text-center text-neutral-500" colSpan={5}>
                    No inventory records found.
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
