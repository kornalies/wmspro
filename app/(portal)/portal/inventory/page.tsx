"use client"

/**
 * What the client is holding with us right now.
 *
 * Scope, policy and feature grants all come from the shell -- this screen used to
 * refetch all three and render its own client dropdown, which is how a multi-client
 * user could end up reading a different client's stock than the one they picked.
 */

import { useCallback, useEffect, useState } from "react"

import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatQuantity, toNumber } from "@/lib/portal-format"

type InventoryRow = {
  item_id: number
  item_code: string
  item_name: string
  uom: string
  in_stock_units: number
  dispatched_units: number
}

const columns: Array<PortalColumn<InventoryRow>> = [
  {
    key: "item_code",
    label: "Item code",
    kind: "text",
    value: (row) => row.item_code,
    render: (row) => <span className="font-medium text-neutral-900">{row.item_code}</span>,
    card: "title",
  },
  { key: "item_name", label: "Description", kind: "text", value: (row) => row.item_name },
  { key: "uom", label: "Unit", kind: "text", value: (row) => row.uom },
  {
    key: "in_stock_units",
    label: "In stock",
    kind: "number",
    align: "right",
    value: (row) => row.in_stock_units,
    render: (row) => (
      <span className="font-semibold text-neutral-900">{formatQuantity(row.in_stock_units)}</span>
    ),
    searchable: false,
    card: "figure",
  },
  {
    key: "dispatched_units",
    label: "Dispatched",
    kind: "number",
    align: "right",
    value: (row) => row.dispatched_units,
    render: (row) => formatQuantity(row.dispatched_units),
    searchable: false,
  },
]

export default function PortalInventoryPage() {
  const { client, can, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null

  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/inventory?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setRows([])
      } else {
        setRows((json?.data || []) as InventoryRow[])
      }
    } catch {
      setError("Check your connection and try again.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!can.inventory) {
      setLoading(false)
      return
    }
    void load()
  }, [can.inventory, load])

  const heldUnits = rows.reduce((total, row) => total + toNumber(row.in_stock_units), 0)

  return (
    <PortalPage
      title="Inventory"
      description={
        rows.length && !loading
          ? `${formatQuantity(heldUnits)} units held across ${rows.length} ${rows.length === 1 ? "item" : "items"}.`
          : "Everything we are holding for you, by item."
      }
      denied={
        can.inventory
          ? null
          : { reason: "Ask your warehouse provider to enable inventory visibility on your portal account." }
      }
    >
      <PortalTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.item_id}
        loading={loading || scopeLoading}
        error={error}
        onRetry={load}
        noun={{ singular: "item", plural: "items" }}
        searchPlaceholder="Search by item code or name"
        initialSort={{ key: "in_stock_units", dir: "desc" }}
        empty={{
          title: "No stock on hand",
          body: "Items appear here once your first shipment has been received and booked in.",
        }}
      />
    </PortalPage>
  )
}
