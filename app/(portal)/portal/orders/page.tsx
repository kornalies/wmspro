"use client"

/**
 * Outbound orders, and how far along each one is.
 *
 * Still a list rather than a detail view -- a client can see that an order went out
 * short but not yet which line was short. That is the next thing this screen needs.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { StatusChip, statusCopy } from "@/components/portal/StatusChip"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatDay, formatQuantity, toNumber } from "@/lib/portal-format"

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
    ],
    [doLabel]
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
    </PortalPage>
  )
}
