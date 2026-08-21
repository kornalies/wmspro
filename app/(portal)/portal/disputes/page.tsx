"use client"

/**
 * Billing queries the client has raised, and where each one stands.
 *
 * The raise form used to ask for a numeric "Invoice ID" -- a primary key the client
 * has no way of knowing, since every other screen shows them an invoice NUMBER. It
 * now picks from their own open invoices.
 *
 * Each row opens into the conversation behind it. Those messages were always
 * being written -- the update route has recorded COMMENT and STATUS_CHANGE
 * events since disputes shipped -- but nothing read them back, so a dispute that
 * ended in a status change and no explanation got re-raised as a phone call.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { PortalDrawer } from "@/components/portal/PortalDrawer"
import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { StatusChip, statusCopy } from "@/components/portal/StatusChip"
import { usePortalScope } from "@/components/portal/portal-scope"
import { formatDayTime, formatMoney } from "@/lib/portal-format"

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

type DisputeEvent = {
  id: number
  event_type: string
  from_status: string | null
  to_status: string | null
  comment: string | null
  created_at: string
  author: "you" | "warehouse"
}

type DisputeDetail = DisputeRow & {
  currency_code: string | null
  grand_total: number | string | null
  resolution_notes: string | null
  events: DisputeEvent[]
  can_comment: boolean
  can_change_status: boolean
}

type InvoiceOption = {
  id: number
  invoice_number: string
  total_amount: number | string
  currency_code: string
}

const CATEGORIES = [
  { value: "BILLING_AMOUNT", label: "The amount is wrong" },
  { value: "SERVICE_QUALITY", label: "Service quality" },
  { value: "DAMAGE", label: "Damaged or missing goods" },
  { value: "OTHER", label: "Something else" },
]

const MIN_REASON = 10

export default function PortalDisputesPage() {
  const { client, can, canCreateDispute, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null

  const [rows, setRows] = useState<DisputeRow[]>([])
  const [invoices, setInvoices] = useState<InvoiceOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const [formOpen, setFormOpen] = useState(false)
  const [invoiceId, setInvoiceId] = useState("")
  const [category, setCategory] = useState(CATEGORIES[0].value)
  const [reason, setReason] = useState("")
  const [formError, setFormError] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmation, setConfirmation] = useState("")

  const [openDispute, setOpenDispute] = useState<DisputeRow | null>(null)
  const [detail, setDetail] = useState<DisputeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState("")
  const [reply, setReply] = useState("")
  const [replying, setReplying] = useState(false)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/disputes?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setRows([])
      } else {
        setRows((json?.data || []) as DisputeRow[])
      }
    } catch {
      setError("Check your connection and try again.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [clientId])

  // The invoice list backs the picker. A failure here is not worth an error banner
  // on the disputes list -- the form falls back to reporting it on submit.
  const loadInvoices = useCallback(async () => {
    if (!clientId || !can.billing) return
    try {
      const res = await fetch(`/api/portal/billing?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (res.ok) setInvoices((json?.data || []) as InvoiceOption[])
    } catch {
      setInvoices([])
    }
  }, [can.billing, clientId])

  useEffect(() => {
    if (!can.disputes) {
      setLoading(false)
      return
    }
    void load()
    void loadInvoices()
  }, [can.disputes, load, loadInvoices])

  const openThread = useCallback(
    async (row: DisputeRow) => {
      if (!clientId) return
      setOpenDispute(row)
      setDetail(null)
      setReply("")
      setDetailError("")
      setDetailLoading(true)
      try {
        const res = await fetch(`/api/portal/disputes/${row.id}?client_id=${clientId}`, {
          cache: "no-store",
        })
        const json = await res.json()
        if (!res.ok) setDetailError(json?.error?.message || "Please try again in a moment.")
        else setDetail(json?.data as DisputeDetail)
      } catch {
        setDetailError("Check your connection and try again.")
      } finally {
        setDetailLoading(false)
      }
    },
    [clientId]
  )

  async function sendReply() {
    if (!openDispute || !clientId || reply.trim().length < 1) return
    setReplying(true)
    setDetailError("")
    try {
      const res = await fetch(`/api/portal/disputes/${openDispute.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // No status: a client replying is commenting, not resolving their own
        // dispute. The route refuses a status change from a non-manager anyway.
        body: JSON.stringify({ client_id: clientId, comment: reply.trim() }),
      })
      const json = await res.json()
      if (!res.ok) {
        setDetailError(json?.error?.message || "Your reply was not sent.")
      } else {
        setReply("")
        await openThread(openDispute)
        await load()
      }
    } catch {
      setDetailError("Your reply was not sent. Check your connection and try again.")
    } finally {
      setReplying(false)
    }
  }

  const columns = useMemo<Array<PortalColumn<DisputeRow>>>(
    () => [
      {
        key: "dispute_number",
        label: "Reference",
        kind: "text",
        value: (row) => row.dispute_number,
        render: (row) => (
          <button
            type="button"
            onClick={() => void openThread(row)}
            className="font-medium text-blue-800 underline-offset-2 hover:underline"
          >
            {row.dispute_number}
          </button>
        ),
        card: "title",
      },
      { key: "invoice_number", label: "Invoice", kind: "text", value: (row) => row.invoice_number },
      {
        key: "status",
        label: "Status",
        kind: "text",
        value: (row) => row.status,
        render: (row) => <StatusChip status={row.status} />,
      },
      {
        key: "category",
        label: "Reason",
        kind: "text",
        value: (row) => row.category,
        render: (row) => CATEGORIES.find((entry) => entry.value === row.category)?.label || row.category,
      },
      {
        key: "dispute_amount",
        label: "Amount",
        kind: "number",
        align: "right",
        value: (row) => row.dispute_amount,
        render: (row) => (row.dispute_amount === null ? "—" : formatMoney(row.dispute_amount)),
        searchable: false,
        card: "figure",
      },
      {
        key: "raised_at",
        label: "Raised",
        kind: "date",
        value: (row) => row.raised_at,
        render: (row) => formatDayTime(row.raised_at),
        searchable: false,
      },
      {
        key: "dispute_reason",
        label: "Detail",
        kind: "text",
        value: (row) => row.dispute_reason,
        render: (row) => (
          <span className="block max-w-xs truncate text-neutral-600" title={row.dispute_reason}>
            {row.dispute_reason}
          </span>
        ),
        sortable: false,
      },
    ],
    [openThread]
  )

  function resetForm() {
    setInvoiceId("")
    setCategory(CATEGORIES[0].value)
    setReason("")
    setFormError("")
  }

  async function raiseDispute() {
    if (!clientId) return
    if (!invoiceId) {
      setFormError("Choose the invoice you are querying.")
      return
    }
    if (reason.trim().length < MIN_REASON) {
      setFormError(`Tell us a little more — at least ${MIN_REASON} characters.`)
      return
    }

    setSaving(true)
    setFormError("")
    try {
      const res = await fetch("/api/portal/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          invoice_id: Number(invoiceId),
          dispute_reason: reason.trim(),
          category,
          priority: "MEDIUM",
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setFormError(json?.error?.message || "Your query was not submitted. Please try again.")
      } else {
        const invoiceNumber = invoices.find((invoice) => String(invoice.id) === invoiceId)?.invoice_number
        setConfirmation(
          invoiceNumber
            ? `Query raised against ${invoiceNumber}. We will come back to you.`
            : "Query raised. We will come back to you."
        )
        resetForm()
        setFormOpen(false)
        await load()
      }
    } catch {
      setFormError("Your query was not submitted. Check your connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  const openCount = rows.filter((row) => row.status === "OPEN" || row.status === "UNDER_REVIEW").length

  return (
    <PortalPage
      title="Disputes"
      description={
        openCount > 0
          ? `${openCount} of your ${rows.length} queries are still open.`
          : "Queries you have raised about your invoices."
      }
      denied={
        can.disputes
          ? null
          : { reason: "Ask your warehouse provider to enable billing queries on your portal account." }
      }
      actions={
        canCreateDispute ? (
          <button
            type="button"
            onClick={() => {
              setConfirmation("")
              setFormOpen((current) => !current)
            }}
            aria-expanded={formOpen}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800"
          >
            {formOpen ? "Cancel" : "Raise a query"}
          </button>
        ) : null
      }
    >
      {confirmation ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {confirmation}
        </p>
      ) : null}

      {formOpen ? (
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Raise a query</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Tell us which invoice is wrong and what looks wrong about it. We will respond against your
            agreed resolution target.
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="dispute-invoice" className="block text-sm font-medium text-neutral-800">
                Invoice
              </label>
              {invoices.length ? (
                <select
                  id="dispute-invoice"
                  value={invoiceId}
                  onChange={(event) => setInvoiceId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <option value="">Choose an invoice</option>
                  {invoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number} — {formatMoney(invoice.total_amount, invoice.currency_code)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="dispute-invoice"
                  inputMode="numeric"
                  value={invoiceId}
                  onChange={(event) => setInvoiceId(event.target.value)}
                  placeholder="Invoice reference"
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                />
              )}
            </div>

            <div>
              <label htmlFor="dispute-category" className="block text-sm font-medium text-neutral-800">
                What is the problem?
              </label>
              <select
                id="dispute-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                {CATEGORIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="dispute-reason" className="block text-sm font-medium text-neutral-800">
                Details
              </label>
              <textarea
                id="dispute-reason"
                value={reason}
                rows={3}
                onChange={(event) => setReason(event.target.value)}
                placeholder="For example: storage was billed for 31 days but the stock left on the 12th."
                className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              {/* The minimum used to be enforced by silently dropping the submission. */}
              <p className="mt-1 text-xs text-neutral-500">
                {reason.trim().length < MIN_REASON
                  ? `${MIN_REASON - reason.trim().length} more characters needed`
                  : `${reason.trim().length} characters`}
              </p>
            </div>
          </div>

          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={raiseDispute}
              disabled={saving}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Submitting..." : "Submit query"}
            </button>
            <button
              type="button"
              onClick={() => {
                resetForm()
                setFormOpen(false)
              }}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <PortalTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        loading={loading || scopeLoading}
        error={error}
        onRetry={load}
        noun={{ singular: "query", plural: "queries" }}
        searchPlaceholder="Search by reference or invoice"
        initialSort={{ key: "raised_at", dir: "desc" }}
        empty={{
          title: "No queries raised",
          body: "If an invoice does not look right, raise a query and we will look into it.",
        }}
      />

      <PortalDrawer
        open={Boolean(openDispute)}
        onClose={() => setOpenDispute(null)}
        title={openDispute?.dispute_number || "Query"}
        subtitle={openDispute ? `Invoice ${openDispute.invoice_number}` : undefined}
        footer={
          detail?.can_comment ? (
            <div className="space-y-2">
              <label htmlFor="dispute-reply" className="sr-only">
                Add a reply
              </label>
              <textarea
                id="dispute-reply"
                rows={2}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Add a reply..."
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              <button
                type="button"
                onClick={sendReply}
                disabled={replying || !reply.trim()}
                className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {replying ? "Sending..." : "Send reply"}
              </button>
            </div>
          ) : detail ? (
            <p className="text-xs text-neutral-500">
              This conversation is read-only for your account. Contact your warehouse provider to reply.
            </p>
          ) : null
        }
      >
        {detailLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-12 animate-pulse rounded bg-neutral-100" />
            ))}
          </div>
        ) : detailError && !detail ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">{detailError}</p>
            <button
              type="button"
              onClick={() => openDispute && void openThread(openDispute)}
              className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Try again
            </button>
          </div>
        ) : detail ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={detail.status} />
              {detail.dispute_amount !== null ? (
                <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-xs text-neutral-700">
                  {formatMoney(detail.dispute_amount, detail.currency_code || "INR")} in question
                </span>
              ) : null}
            </div>

            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs uppercase tracking-wide text-neutral-500">What you told us</p>
              <p className="mt-1 text-sm text-neutral-800">{detail.dispute_reason}</p>
              <p className="mt-1 text-xs text-neutral-500">{formatDayTime(detail.raised_at)}</p>
            </div>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Conversation
              </h3>
              {detail.events.length === 0 ? (
                <p className="rounded-xl border border-dashed border-neutral-200 p-4 text-sm text-neutral-500">
                  No replies yet. We will respond against your agreed resolution target.
                </p>
              ) : (
                <ul className="space-y-3">
                  {detail.events.map((event) => {
                    const mine = event.author === "you"
                    return (
                      <li key={event.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                        <div
                          className={`max-w-[85%] rounded-xl px-3 py-2 ${
                            mine ? "bg-blue-50 text-blue-950" : "bg-neutral-100 text-neutral-800"
                          }`}
                        >
                          <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">
                            {mine ? "You" : "Warehouse team"}
                          </p>
                          {/* A status change with no comment still says something. */}
                          {event.event_type === "STATUS_CHANGE" && event.to_status ? (
                            <p className="mt-0.5 text-xs font-medium">
                              Marked {statusCopy(event.to_status).label.toLowerCase()}
                            </p>
                          ) : null}
                          {event.comment ? <p className="mt-0.5 text-sm">{event.comment}</p> : null}
                          <p className="mt-1 text-[11px] opacity-60">{formatDayTime(event.created_at)}</p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {detailError ? <p className="mt-2 text-sm text-red-700">{detailError}</p> : null}
            </section>
          </div>
        ) : null}
      </PortalDrawer>
    </PortalPage>
  )
}
