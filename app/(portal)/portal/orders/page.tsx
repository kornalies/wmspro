"use client"

/**
 * Outbound orders, and how far along each one is.
 *
 * The list answers "did it ship?"; a row opens to answer the two questions that
 * used to be a phone call -- WHICH line came up short, and where the order has
 * actually got to.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { PortalDrawer } from "@/components/portal/PortalDrawer"
import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { PortalTimeline, type TimelineStep } from "@/components/portal/PortalTimeline"
import { StatusChip, statusCopy } from "@/components/portal/StatusChip"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatDay, formatQuantity, toNumber } from "@/lib/portal-format"

type OrderDetail = {
  do_number: string
  status: string
  remarks: string | null
  warehouse_name: string | null
  request_date: string | null
  expected_dispatch_date: string | null
  dispatch_date: string | null
  pack_count: number
  outbound_path: string | null
  lines: Array<{
    id: number
    line_number: number
    item_code: string
    item_name: string
    uom: string | null
    quantity_requested: number | string
    quantity_dispatched: number | string
    remarks: string | null
  }>
  timeline: TimelineStep[]
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
  const { client, can, doLabel, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null

  const [rows, setRows] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  const [openOrder, setOpenOrder] = useState<OrderRow | null>(null)
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState("")

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/orders?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setRows([])
      } else {
        setRows((json?.data || []) as OrderRow[])
      }
    } catch {
      setError("Check your connection and try again.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!can.orders) {
      setLoading(false)
      return
    }
    void load()
  }, [can.orders, load])

  const openDetail = useCallback(
    async (row: OrderRow) => {
      if (!clientId) return
      setOpenOrder(row)
      setDetail(null)
      setDetailError("")
      setDetailLoading(true)
      try {
        const res = await fetch(`/api/portal/orders/${row.id}?client_id=${clientId}`, {
          cache: "no-store",
        })
        const json = await res.json()
        if (!res.ok) setDetailError(json?.error?.message || "Please try again in a moment.")
        else setDetail(json?.data as OrderDetail)
      } catch {
        setDetailError("Check your connection and try again.")
      } finally {
        setDetailLoading(false)
      }
    },
    [clientId]
  )

  const columns = useMemo<Array<PortalColumn<OrderRow>>>(
    () => [
      {
        key: "do_number",
        label: `${doLabel} number`,
        kind: "text",
        value: (row) => row.do_number,
        render: (row) => <span className="font-medium text-neutral-900">{row.do_number}</span>,
        card: "title",
      },
      {
        key: "status",
        label: "Status",
        kind: "text",
        value: (row) => row.status,
        render: (row) => <StatusChip status={row.status} />,
      },
      {
        key: "request_date",
        label: "Requested",
        kind: "date",
        value: (row) => row.request_date,
        render: (row) => formatDay(row.request_date),
        searchable: false,
      },
      {
        key: "dispatch_date",
        label: "Dispatched",
        kind: "date",
        value: (row) => row.dispatch_date,
        render: (row) => formatDay(row.dispatch_date),
        searchable: false,
      },
      {
        key: "total_items",
        label: "Lines",
        kind: "number",
        align: "right",
        value: (row) => row.total_items,
        searchable: false,
      },
      {
        key: "total_quantity_requested",
        label: "Requested qty",
        kind: "number",
        align: "right",
        value: (row) => row.total_quantity_requested,
        render: (row) => formatQuantity(row.total_quantity_requested),
        searchable: false,
      },
      {
        key: "total_quantity_dispatched",
        label: "Dispatched qty",
        kind: "number",
        align: "right",
        value: (row) => row.total_quantity_dispatched,
        // A short dispatch is the thing a client is scanning for, so it is called
        // out on the row rather than left as two numbers to subtract.
        render: (row) => {
          const requested = toNumber(row.total_quantity_requested)
          const dispatched = toNumber(row.total_quantity_dispatched)
          const short = requested - dispatched
          return (
            <span>
              <span className="font-semibold text-neutral-900">{formatQuantity(dispatched)}</span>
              {short > 0 && dispatched > 0 ? (
                <span className="ml-1.5 text-xs font-medium text-amber-700">
                  {formatQuantity(short)} short
                </span>
              ) : null}
            </span>
          )
        },
        searchable: false,
        card: "figure",
      },
      {
        key: "view",
        label: "",
        kind: "text",
        value: () => "",
        sortable: false,
        searchable: false,
        align: "right",
        card: "actions",
        render: (row) => (
          <button
            type="button"
            onClick={() => void openDetail(row)}
            className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            View details
          </button>
        ),
      },
    ],
    [doLabel, openDetail]
  )

  const statusOptions = useMemo(() => {
    const seen = Array.from(new Set(rows.map((row) => row.status).filter(Boolean)))
    return [
      { value: "", label: "All statuses" },
      // The filter reads in the same words as the chips it filters on; offering
      // PARTIALLY_DISPATCHED in a dropdown next to a "Part dispatched" chip asks
      // the client to work out that they are the same thing.
      ...seen.map((status) => ({ value: status, label: statusCopy(status).label })),
    ]
  }, [rows])

  const filtered = statusFilter ? rows.filter((row) => row.status === statusFilter) : rows

  return (
    <PortalPage
      title={`${doLabel} Orders`}
      description="Orders raised against your stock, and what has left the warehouse."
      denied={
        can.orders
          ? null
          : { reason: "Ask your warehouse provider to enable order visibility on your portal account." }
      }
    >
      <PortalTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        loading={loading || scopeLoading}
        error={error}
        onRetry={load}
        noun={{ singular: "order", plural: "orders" }}
        searchPlaceholder={`Search by ${doLabel} number`}
        initialSort={{ key: "request_date", dir: "desc" }}
        filters={[
          {
            key: "status",
            label: "Filter by status",
            value: statusFilter,
            options: statusOptions,
            onChange: setStatusFilter,
          },
        ]}
        empty={{
          title: "No orders yet",
          body: `Orders appear here as soon as the first ${doLabel} is raised against your stock.`,
        }}
      />

      <PortalDrawer
        open={Boolean(openOrder)}
        onClose={() => setOpenOrder(null)}
        title={openOrder?.do_number || "Order"}
        subtitle={detail?.warehouse_name || undefined}
      >
        {detailLoading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="h-4 animate-pulse rounded bg-neutral-100" />
            ))}
          </div>
        ) : detailError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">We could not load this order. {detailError}</p>
            <button
              type="button"
              onClick={() => openOrder && void openDetail(openOrder)}
              className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Try again
            </button>
          </div>
        ) : detail ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={detail.status} />
              {detail.pack_count > 0 ? (
                <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-xs text-neutral-600">
                  {detail.pack_count} {detail.pack_count === 1 ? "package" : "packages"}
                </span>
              ) : null}
            </div>

            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Progress
              </h3>
              <PortalTimeline steps={detail.timeline} />
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Items
              </h3>
              <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200">
                {detail.lines.map((line) => {
                  const requested = toNumber(line.quantity_requested)
                  const dispatched = toNumber(line.quantity_dispatched)
                  const short = requested - dispatched
                  return (
                    <li key={line.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-neutral-900">
                            {line.item_name}
                          </p>
                          <p className="text-xs text-neutral-500">{line.item_code}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm tabular-nums text-neutral-900">
                            {formatQuantity(dispatched)}
                            <span className="text-neutral-400"> / {formatQuantity(requested)}</span>
                            {line.uom ? <span className="ml-1 text-xs text-neutral-500">{line.uom}</span> : null}
                          </p>
                          {/* The whole reason a client opens this drawer. */}
                          {short > 0 ? (
                            <p className="text-xs font-medium text-amber-700">
                              {formatQuantity(short)} short
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {line.remarks ? (
                        <p className="mt-1 text-xs text-neutral-500">{line.remarks}</p>
                      ) : null}
                    </li>
                  )
                })}
                {!detail.lines.length ? (
                  <li className="p-4 text-center text-sm text-neutral-500">
                    No items recorded on this order.
                  </li>
                ) : null}
              </ul>
            </section>

            {detail.remarks ? (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Notes
                </h3>
                <p className="text-sm text-neutral-700">{detail.remarks}</p>
              </section>
            ) : null}
          </div>
        ) : null}
      </PortalDrawer>
    </PortalPage>
  )
}
