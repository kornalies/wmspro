"use client"

/**
 * What the client is holding with us right now.
 *
 * Five columns was a stock summary, not stock visibility. The database has
 * tracked batch, expiry and hold state all along; the portal simply never asked
 * for it, so a client could not tell that a quarter of their paracetamol had
 * expired on the shelf, or that a batch was on hold and could not ship.
 *
 * The distinction that matters most here is on-hand vs available. A client who
 * sees 997 units and is then told 250 cannot go out will assume the warehouse
 * lost them. Held stock is present and unshippable, and the screen says so.
 */

import { useCallback, useEffect, useState } from "react"

import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatDay, formatQuantity, toNumber } from "@/lib/portal-format"

type InventoryRow = {
  item_id: number
  item_code: string
  item_name: string
  uom: string
  in_stock_units: number
  dispatched_units: number
  available_units: number
  held_units: number
  expired_units: number
  expiring_30d_units: number
  batch_count: number
  earliest_expiry: string | null
  oldest_received: string | null
}

/**
 * Expiry as a chip, in the words a client would use. Expired stock outranks
 * expiring stock: it is already a write-off conversation, not a warning.
 */
function ExpiryCell({ row }: { row: InventoryRow }) {
  const expired = toNumber(row.expired_units)
  const soon = toNumber(row.expiring_30d_units)

  if (expired > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-800">
        <span aria-hidden className="text-[9px]">▲</span>
        {formatQuantity(expired)} expired
      </span>
    )
  }
  if (soon > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900">
        <span aria-hidden className="text-[9px]">▲</span>
        {formatQuantity(soon)} within 30 days
      </span>
    )
  }
  if (row.earliest_expiry) {
    return <span className="text-xs text-neutral-600">First expires {formatDay(row.earliest_expiry)}</span>
  }
  // Not every item is expiry-tracked; an em dash is honest, "OK" would not be.
  return <span className="text-xs text-neutral-400">—</span>
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
  {
    key: "available_units",
    label: "Available",
    kind: "number",
    align: "right",
    value: (row) => row.available_units,
    render: (row) => (
      <span className="font-semibold text-neutral-900">
        {formatQuantity(row.available_units)}
        {row.uom ? <span className="ml-1 text-xs font-normal text-neutral-500">{row.uom}</span> : null}
      </span>
    ),
    searchable: false,
    card: "figure",
  },
  {
    key: "held_units",
    label: "On hold",
    kind: "number",
    align: "right",
    value: (row) => row.held_units,
    render: (row) =>
      toNumber(row.held_units) > 0 ? (
        <span className="font-medium text-amber-800">{formatQuantity(row.held_units)}</span>
      ) : (
        <span className="text-neutral-400">—</span>
      ),
    searchable: false,
  },
  {
    key: "in_stock_units",
    label: "On hand",
    kind: "number",
    align: "right",
    value: (row) => row.in_stock_units,
    render: (row) => formatQuantity(row.in_stock_units),
    searchable: false,
  },
  {
    key: "batch_count",
    label: "Batches",
    kind: "number",
    align: "right",
    value: (row) => row.batch_count,
    render: (row) =>
      toNumber(row.batch_count) > 0 ? (
        formatQuantity(row.batch_count)
      ) : (
        <span className="text-neutral-400">—</span>
      ),
    searchable: false,
  },
  {
    key: "earliest_expiry",
    label: "Expiry",
    kind: "date",
    value: (row) => row.earliest_expiry,
    render: (row) => <ExpiryCell row={row} />,
    searchable: false,
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
  const [attentionOnly, setAttentionOnly] = useState("")

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

  const availableUnits = rows.reduce((total, row) => total + toNumber(row.available_units), 0)
  const expiredUnits = rows.reduce((total, row) => total + toNumber(row.expired_units), 0)
  const expiringUnits = rows.reduce((total, row) => total + toNumber(row.expiring_30d_units), 0)
  const heldUnits = rows.reduce((total, row) => total + toNumber(row.held_units), 0)

  const needsAttention = (row: InventoryRow) =>
    toNumber(row.expired_units) > 0 || toNumber(row.expiring_30d_units) > 0 || toNumber(row.held_units) > 0
  const filtered = attentionOnly === "attention" ? rows.filter(needsAttention) : rows

  return (
    <PortalPage
      title="Inventory"
      description={
        rows.length && !loading
          ? `${formatQuantity(availableUnits)} units available across ${rows.length} ${rows.length === 1 ? "item" : "items"}.`
          : "Everything we are holding for you, by item."
      }
      denied={
        can.inventory
          ? null
          : { reason: "Ask your warehouse provider to enable inventory visibility on your portal account." }
      }
    >
      {/* Only rendered when there is something to act on -- a banner that always
          says "all clear" trains people to stop reading it. */}
      {!loading && (expiredUnits > 0 || expiringUnits > 0 || heldUnits > 0) ? (
        <section
          aria-label="Stock needing attention"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
        >
          {expiredUnits > 0 ? (
            <p className="text-red-800">
              <span className="font-semibold tabular-nums">{formatQuantity(expiredUnits)}</span> units have
              expired
            </p>
          ) : null}
          {expiringUnits > 0 ? (
            <p className="text-amber-900">
              <span className="font-semibold tabular-nums">{formatQuantity(expiringUnits)}</span> units expire
              within 30 days
            </p>
          ) : null}
          {heldUnits > 0 ? (
            <p className="text-amber-900">
              <span className="font-semibold tabular-nums">{formatQuantity(heldUnits)}</span> units are on hold
              and cannot ship
            </p>
          ) : null}
        </section>
      ) : null}

      <PortalTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.item_id}
        loading={loading || scopeLoading}
        error={error}
        onRetry={load}
        noun={{ singular: "item", plural: "items" }}
        searchPlaceholder="Search by item code or name"
        initialSort={{ key: "available_units", dir: "desc" }}
        filters={[
          {
            key: "attention",
            label: "Filter stock",
            value: attentionOnly,
            options: [
              { value: "", label: "All items" },
              { value: "attention", label: "Needs attention" },
            ],
            onChange: setAttentionOnly,
          },
        ]}
        empty={{
          title: "No stock on hand",
          body: "Items appear here once your first shipment has been received and booked in.",
        }}
      />
    </PortalPage>
  )
}
