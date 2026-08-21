"use client"

/**
 * Invoices, and the three things a client can do about one.
 *
 * The actions used to run through `window.prompt`: a payment meant answering three
 * chained browser dialogs, where "12,000" became NaN and silently aborted, and
 * cancelling the second dialog abandoned the flow with no message. They run through
 * a drawer now, which shows the invoice while you fill the form in, validates the
 * amount against the outstanding balance the same way the route does, and restates
 * the amount on the confirm button.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"

import { PortalDrawer } from "@/components/portal/PortalDrawer"
import { PortalPage } from "@/components/portal/PortalPage"
import { PortalTable, type PortalColumn } from "@/components/portal/PortalTable"
import { StatusChip } from "@/components/portal/StatusChip"
import { usePortalScope } from "@/components/portal/portal-scope"
import { daysPast, formatDay, formatMoney, toNumber } from "@/lib/portal-format"

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

type ActionKind = "APPROVE" | "DISPUTE" | "PAY"

const MIN_REASON = 10

/** Due-date wording a client can act on without doing the arithmetic themselves. */
function dueCopy(row: BillingRow) {
  if (toNumber(row.balance_amount) <= 0) return { text: formatDay(row.due_date), tone: "text-neutral-600" }
  const overdueBy = daysPast(row.due_date)
  if (overdueBy === null) return { text: "—", tone: "text-neutral-500" }
  if (overdueBy > 0) {
    return { text: `${overdueBy} ${overdueBy === 1 ? "day" : "days"} overdue`, tone: "text-red-700 font-medium" }
  }
  if (overdueBy === 0) return { text: "Due today", tone: "text-amber-800 font-medium" }
  return { text: `Due ${formatDay(row.due_date)}`, tone: "text-neutral-600" }
}

export default function PortalBillingPage() {
  const { client, can, canActOnInvoice, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null
  const clientQuery = client ? `?client=${encodeURIComponent(client.client_code)}` : ""

  const [rows, setRows] = useState<BillingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [outstandingOnly, setOutstandingOnly] = useState("")
  const [confirmation, setConfirmation] = useState("")

  // One drawer, three shapes. Kept as a single piece of state so opening one
  // action always closes any other.
  const [action, setAction] = useState<{ kind: ActionKind; invoice: BillingRow } | null>(null)
  const [amount, setAmount] = useState("")
  const [paymentDate, setPaymentDate] = useState("")
  const [reference, setReference] = useState("")
  const [reason, setReason] = useState("")
  const [disputeAmount, setDisputeAmount] = useState("")
  const [formError, setFormError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/portal/billing?client_id=${clientId}`, { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setRows([])
      } else {
        setRows((json?.data || []) as BillingRow[])
      }
    } catch {
      setError("Check your connection and try again.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!can.billing) {
      setLoading(false)
      return
    }
    void load()
  }, [can.billing, load])

  function openAction(kind: ActionKind, invoice: BillingRow) {
    setConfirmation("")
    setFormError("")
    setAmount(kind === "PAY" ? String(toNumber(invoice.balance_amount).toFixed(2)) : "")
    setPaymentDate(new Date().toISOString().slice(0, 10))
    setReference("")
    setReason("")
    setDisputeAmount("")
    setAction({ kind, invoice })
  }

  function closeAction() {
    setAction(null)
    setFormError("")
  }

  async function submitAction() {
    if (!action || !clientId) return
    const { kind, invoice } = action
    const balance = toNumber(invoice.balance_amount)

    let payload: Record<string, unknown> = { client_id: clientId, action: kind }

    if (kind === "PAY") {
      // Accept "1,18,000" and "₹1180" the way a person types them, then hold the
      // parsed value to the same rule the route enforces.
      const parsed = Number(amount.replace(/[^0-9.]/g, ""))
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setFormError("Enter the amount you are paying, for example 1180.00.")
        return
      }
      if (parsed > balance + 0.01) {
        setFormError(`That is more than the ${formatMoney(balance, invoice.currency_code)} outstanding on this invoice.`)
        return
      }
      payload = {
        ...payload,
        amount: parsed,
        payment_date: paymentDate || new Date().toISOString().slice(0, 10),
        payment_mode: "PORTAL",
        reference_no: reference.trim() || undefined,
        notes: "Client self-service payment",
      }
    }

    if (kind === "DISPUTE") {
      if (reason.trim().length < MIN_REASON) {
        setFormError(`Tell us a little more — at least ${MIN_REASON} characters.`)
        return
      }
      const parsedDispute = disputeAmount.trim() ? Number(disputeAmount.replace(/[^0-9.]/g, "")) : undefined
      if (disputeAmount.trim() && (!Number.isFinite(parsedDispute) || (parsedDispute as number) < 0)) {
        setFormError("The disputed amount must be a number, or left blank.")
        return
      }
      payload = { ...payload, dispute_reason: reason.trim(), dispute_amount: parsedDispute }
    }

    setSubmitting(true)
    setFormError("")
    try {
      const res = await fetch(`/api/portal/billing/${invoice.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        setFormError(json?.error?.message || "That did not go through. Please try again.")
      } else {
        setConfirmation(
          kind === "APPROVE"
            ? `${invoice.invoice_number} approved.`
            : kind === "PAY"
              ? `Payment of ${formatMoney(payload.amount, invoice.currency_code)} recorded against ${invoice.invoice_number}.`
              : `Query raised against ${invoice.invoice_number}. We will come back to you.`
        )
        closeAction()
        await load()
      }
    } catch {
      setFormError("That did not go through. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const columns = useMemo<Array<PortalColumn<BillingRow>>>(
    () => [
      {
        key: "invoice_number",
        label: "Invoice",
        kind: "text",
        value: (row) => row.invoice_number,
        // The number is the link: a client looking for the paper looks for the
        // invoice number, not for a separate "download" column.
        render: (row) => (
          <Link
            href={`/portal/documents/commercial-invoice/${row.id}${clientQuery}`}
            className="font-medium text-blue-800 underline-offset-2 hover:underline"
          >
            {row.invoice_number}
          </Link>
        ),
        card: "title",
      },
      {
        key: "invoice_date",
        label: "Issued",
        kind: "date",
        value: (row) => row.invoice_date,
        render: (row) => formatDay(row.invoice_date),
        searchable: false,
      },
      {
        key: "due_date",
        label: "Due",
        kind: "date",
        value: (row) => row.due_date,
        render: (row) => {
          const { text, tone } = dueCopy(row)
          return <span className={tone}>{text}</span>
        },
        searchable: false,
      },
      {
        key: "status",
        label: "Status",
        kind: "text",
        value: (row) => row.status,
        render: (row) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusChip status={row.status} />
            {row.open_disputes > 0 ? (
              <span className="whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                {row.open_disputes} open {row.open_disputes === 1 ? "query" : "queries"}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "total_amount",
        label: "Total",
        kind: "number",
        align: "right",
        value: (row) => row.total_amount,
        render: (row) => formatMoney(row.total_amount, row.currency_code),
        searchable: false,
      },
      {
        key: "balance_amount",
        label: "Outstanding",
        kind: "number",
        align: "right",
        value: (row) => row.balance_amount,
        render: (row) => (
          <span
            className={
              toNumber(row.balance_amount) > 0 ? "font-semibold text-neutral-900" : "text-emerald-700"
            }
          >
            {toNumber(row.balance_amount) > 0 ? formatMoney(row.balance_amount, row.currency_code) : "Settled"}
          </span>
        ),
        searchable: false,
        card: "figure",
      },
      {
        key: "client_action_status",
        label: "Your action",
        kind: "text",
        value: (row) => row.client_action_status,
        render: (row) => <StatusChip status={row.client_action_status || "PENDING"} />,
      },
      ...(canActOnInvoice
        ? [
            {
              key: "actions",
              label: "",
              kind: "text" as const,
              value: () => "",
              sortable: false,
              searchable: false,
              align: "right" as const,
              card: "actions" as const,
              render: (row: BillingRow) => (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => openAction("APPROVE", row)}
                    className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => openAction("DISPUTE", row)}
                    className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50"
                  >
                    Query
                  </button>
                  <button
                    type="button"
                    onClick={() => openAction("PAY", row)}
                    disabled={toNumber(row.balance_amount) <= 0}
                    className="rounded-lg bg-blue-700 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-500"
                  >
                    Pay
                  </button>
                </div>
              ),
            },
          ]
        : []),
    ],
    [canActOnInvoice, clientQuery]
  )

  const filtered = outstandingOnly === "open" ? rows.filter((row) => toNumber(row.balance_amount) > 0) : rows
  const outstandingTotal = rows.reduce((total, row) => total + toNumber(row.balance_amount), 0)

  const activeInvoice = action?.invoice
  const activeBalance = toNumber(activeInvoice?.balance_amount)
  const parsedPayAmount = Number(amount.replace(/[^0-9.]/g, ""))

  return (
    <PortalPage
      title="Billing"
      description={
        outstandingTotal > 0
          ? `${formatMoney(outstandingTotal)} outstanding across ${filtered.length} ${filtered.length === 1 ? "invoice" : "invoices"}.`
          : "Your invoices, and anything still owing."
      }
      denied={
        can.billing
          ? null
          : { reason: "Ask your warehouse provider to enable billing visibility on your portal account." }
      }
      actions={
        can.billing && clientId ? (
          // Replaces "Download snapshot", which produced raw JSON no finance
          // team would open. This is the open-item statement the engine builds.
          <Link
            href={`/portal/documents/client-statement/${clientId}${clientQuery}`}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            Statement of account
          </Link>
        ) : null
      }
    >
      {confirmation ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {confirmation}
        </p>
      ) : null}

      <PortalTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        loading={loading || scopeLoading}
        error={error}
        onRetry={load}
        noun={{ singular: "invoice", plural: "invoices" }}
        searchPlaceholder="Search by invoice number"
        initialSort={{ key: "invoice_date", dir: "desc" }}
        filters={[
          {
            key: "outstanding",
            label: "Filter invoices",
            value: outstandingOnly,
            options: [
              { value: "", label: "All invoices" },
              { value: "open", label: "Outstanding only" },
            ],
            onChange: setOutstandingOnly,
          },
        ]}
        empty={{
          title: "No invoices yet",
          body: "Invoices appear here as soon as your first billing cycle has run.",
        }}
      />

      <PortalDrawer
        open={Boolean(action)}
        onClose={closeAction}
        title={
          action?.kind === "APPROVE"
            ? "Approve invoice"
            : action?.kind === "PAY"
              ? "Record a payment"
              : "Query this invoice"
        }
        subtitle={activeInvoice ? `${activeInvoice.invoice_number} · ${formatMoney(activeInvoice.total_amount, activeInvoice.currency_code)}` : undefined}
        footer={
          <div className="space-y-3">
            {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={submitAction}
                disabled={submitting}
                className="flex-1 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {/* The button restates what is about to happen, including the amount. */}
                {submitting
                  ? "Submitting..."
                  : action?.kind === "APPROVE"
                    ? `Approve ${activeInvoice?.invoice_number}`
                    : action?.kind === "PAY"
                      ? `Record payment of ${formatMoney(Number.isFinite(parsedPayAmount) ? parsedPayAmount : 0, activeInvoice?.currency_code)}`
                      : "Submit query"}
              </button>
              <button
                type="button"
                onClick={closeAction}
                className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
            </div>
          </div>
        }
      >
        {activeInvoice ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Issued</dt>
                <dd className="mt-0.5 text-neutral-800">{formatDay(activeInvoice.invoice_date)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Due</dt>
                <dd className="mt-0.5 text-neutral-800">{formatDay(activeInvoice.due_date)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Paid so far</dt>
                <dd className="mt-0.5 tabular-nums text-neutral-800">
                  {formatMoney(activeInvoice.paid_amount, activeInvoice.currency_code)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Outstanding</dt>
                <dd className="mt-0.5 font-semibold tabular-nums text-neutral-900">
                  {formatMoney(activeBalance, activeInvoice.currency_code)}
                </dd>
              </div>
            </dl>

            {action?.kind === "APPROVE" ? (
              <p className="text-sm text-neutral-700">
                Approving confirms the charges on this invoice are correct. If something looks wrong, close
                this and raise a query instead — you can still do that after approving, but it is quicker
                to sort out before.
              </p>
            ) : null}

            {action?.kind === "PAY" ? (
              <div className="space-y-4">
                <div>
                  <label htmlFor="pay-amount" className="block text-sm font-medium text-neutral-800">
                    Amount
                  </label>
                  <input
                    id="pay-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-base tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <p className="text-xs text-neutral-500">
                      {formatMoney(activeBalance, activeInvoice.currency_code)} outstanding
                    </p>
                    {parsedPayAmount !== activeBalance ? (
                      <button
                        type="button"
                        onClick={() => setAmount(activeBalance.toFixed(2))}
                        className="text-xs font-medium text-blue-700 hover:underline"
                      >
                        Pay in full
                      </button>
                    ) : null}
                  </div>
                </div>

                <div>
                  <label htmlFor="pay-date" className="block text-sm font-medium text-neutral-800">
                    Payment date
                  </label>
                  <input
                    id="pay-date"
                    type="date"
                    value={paymentDate}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(event) => setPaymentDate(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  />
                </div>

                <div>
                  <label htmlFor="pay-reference" className="block text-sm font-medium text-neutral-800">
                    Reference <span className="font-normal text-neutral-500">(optional)</span>
                  </label>
                  <input
                    id="pay-reference"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="UTR or transaction number"
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Helps us match your transfer to this invoice.
                  </p>
                </div>
              </div>
            ) : null}

            {action?.kind === "DISPUTE" ? (
              <div className="space-y-4">
                <div>
                  <label htmlFor="dispute-detail" className="block text-sm font-medium text-neutral-800">
                    What looks wrong?
                  </label>
                  <textarea
                    id="dispute-detail"
                    rows={4}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="For example: storage was billed for 31 days but the stock left on the 12th."
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    {reason.trim().length < MIN_REASON
                      ? `${MIN_REASON - reason.trim().length} more characters needed`
                      : `${reason.trim().length} characters`}
                  </p>
                </div>

                <div>
                  <label htmlFor="dispute-amount" className="block text-sm font-medium text-neutral-800">
                    Amount in question <span className="font-normal text-neutral-500">(optional)</span>
                  </label>
                  <input
                    id="dispute-amount"
                    inputMode="decimal"
                    value={disputeAmount}
                    onChange={(event) => setDisputeAmount(event.target.value)}
                    placeholder="Leave blank to query the whole invoice"
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </PortalDrawer>
    </PortalPage>
  )
}
