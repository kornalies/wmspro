"use client"

/**
 * Announce an inbound shipment, and see what the warehouse did with it.
 *
 * The page used to be write-only: a date, a paragraph of remarks, and a "submitted"
 * message that led nowhere. A client had no way to say what was actually coming,
 * and no way to find out whether anyone had looked at it. Both halves are here
 * now -- itemised lines on the way in, and the request's real status on the way
 * back, including the GRN raised against it once the goods land.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"

import { usePortalScope } from "@/components/portal/portal-scope"

type PortalItem = {
  id: number
  item_code: string
  item_name: string
  uom: string
  is_batch_tracked?: boolean
  is_expiry_tracked?: boolean
}

type AsnLineDraft = {
  key: string
  item_id: string
  expected_quantity: string
  batch_no: string
  expiry_date: string
}

type AsnRequestRow = {
  id: number
  request_number: string
  expected_date: string | null
  status: string
  remarks: string | null
  review_remarks: string | null
  reviewed_at: string | null
  created_at: string
  line_count: number | string
  expected_quantity: number | string
  receipt_count: number | string
}

type AsnRequestDetail = AsnRequestRow & {
  lines: Array<{
    id: number
    line_number: number
    item_code: string
    item_name: string
    expected_quantity: number | string
    uom: string | null
    batch_no: string | null
    expiry_date: string | null
  }>
  receipts: Array<{
    id: number
    grn_number: string
    grn_date: string
    status: string
    total_quantity: number | string
  }>
}

/**
 * What each status means to the client, in their words rather than the
 * warehouse's. "REQUESTED" on its own reads like the request failed to go
 * anywhere -- which, before this feature was wired up, it had.
 */
const STATUS_COPY: Record<string, { label: string; tone: string; detail: string }> = {
  REQUESTED: {
    label: "Awaiting review",
    tone: "bg-amber-50 text-amber-800 border-amber-200",
    detail: "Your warehouse provider has not reviewed this yet.",
  },
  ACCEPTED: {
    label: "Accepted",
    tone: "bg-sky-50 text-sky-800 border-sky-200",
    detail: "The warehouse is expecting this shipment.",
  },
  REJECTED: {
    label: "Rejected",
    tone: "bg-red-50 text-red-700 border-red-200",
    detail: "The warehouse could not accept this request.",
  },
  RECEIVED: {
    label: "Received",
    tone: "bg-emerald-50 text-emerald-800 border-emerald-200",
    detail: "The goods arrived and have been booked in.",
  },
  CANCELLED: {
    label: "Cancelled",
    tone: "bg-slate-100 text-slate-600 border-slate-200",
    detail: "This request was withdrawn.",
  },
}

function statusCopy(status: string) {
  return (
    STATUS_COPY[String(status).toUpperCase()] || {
      label: status,
      tone: "bg-slate-100 text-slate-600 border-slate-200",
      detail: "",
    }
  )
}

function newLine(): AsnLineDraft {
  return {
    key: Math.random().toString(36).slice(2),
    item_id: "",
    expected_quantity: "",
    batch_no: "",
    expiry_date: "",
  }
}

export default function PortalAsnPage() {
  // Client scope and both access gates come from the shell. This page used to
  // resolve all three itself, including its own copy of the client dropdown.
  const { client, can, canCreateAsn } = usePortalScope()
  const clientId = client?.id ?? null
  const asnEnabled = can.shipments
  const canCreate = canCreateAsn

  const [items, setItems] = useState<PortalItem[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const [expectedDate, setExpectedDate] = useState("")
  const [remarks, setRemarks] = useState("")
  const [lines, setLines] = useState<AsnLineDraft[]>([newLine()])
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [history, setHistory] = useState<AsnRequestRow[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [detail, setDetail] = useState<AsnRequestDetail | null>(null)

  const loadHistory = useCallback(async (id: number) => {
    const res = await fetch(`/api/portal/asn?client_id=${id}`, { cache: "no-store" })
    const json = await res.json()
    setHistory(res.ok ? ((json?.data || []) as AsnRequestRow[]) : [])
  }, [])

  useEffect(() => {
    if (!clientId) return
    setItemsLoaded(false)
    void (async () => {
      const [itemsRes] = await Promise.all([
        fetch(`/api/portal/items?client_id=${clientId}`, { cache: "no-store" }),
        loadHistory(clientId),
      ])
      const itemsJson = await itemsRes.json()
      setItems(itemsRes.ok ? ((itemsJson?.data || []) as PortalItem[]) : [])
      setItemsLoaded(true)
      setLines([newLine()])
      setExpanded(null)
      setDetail(null)
    })()
  }, [clientId, loadHistory])

  const itemsById = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items])

  const totalExpected = lines.reduce((sum, line) => sum + (Number(line.expected_quantity) || 0), 0)
  const filledLines = lines.filter((line) => line.item_id && Number(line.expected_quantity) > 0)
  const canSubmit = Boolean(clientId) && asnEnabled && canCreate && filledLines.length > 0 && !submitting

  function updateLine(key: string, patch: Partial<AsnLineDraft>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  async function toggleDetail(requestId: number) {
    if (expanded === requestId) {
      setExpanded(null)
      setDetail(null)
      return
    }
    setExpanded(requestId)
    setDetail(null)
    const res = await fetch(`/api/portal/asn?client_id=${clientId}&id=${requestId}`, { cache: "no-store" })
    const json = await res.json()
    if (res.ok) setDetail(json?.data as AsnRequestDetail)
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit || !clientId) return
    setSubmitting(true)
    setMessage(null)

    try {
      const res = await fetch("/api/portal/asn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The route has always supported this; the page never sent one, so a
          // double-click or a retry on a flaky connection filed the shipment twice.
          "x-idempotency-key": `asn-${clientId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: JSON.stringify({
          client_id: clientId,
          expected_date: expectedDate || undefined,
          remarks: remarks || undefined,
          lines: filledLines.map((line) => ({
            item_id: Number(line.item_id),
            expected_quantity: Number(line.expected_quantity),
            batch_no: line.batch_no || undefined,
            expiry_date: line.expiry_date || undefined,
          })),
        }),
      })
      const json = await res.json()
      if (res.ok) {
        setMessage({
          tone: "ok",
          text: `Shipment announced as ${json?.data?.request_number}. Your warehouse provider can see it now.`,
        })
        setExpectedDate("")
        setRemarks("")
        setLines([newLine()])
        await loadHistory(clientId)
      } else {
        setMessage({ tone: "error", text: json?.error?.message || "Failed to submit the request." })
      }
    } catch {
      setMessage({ tone: "error", text: "Could not reach the server. Please try again." })
    } finally {
      setSubmitting(false)
    }
  }

  const blocked = !asnEnabled || !canCreate

  return (
    // The shell supplies <main>, the page padding and the client switcher; this
    // stays narrower than the full width because it is a form, not a table.
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Shipments</h1>
        <p className="mt-1 text-sm text-slate-500">
          Tell your warehouse provider what is coming and when, so the goods can be booked in against
          your request when they arrive.
        </p>
      </div>

      <div aria-live="polite" role="status" className="empty:hidden">
        {message ? (
          <p
            className={`rounded-md border p-3 text-sm ${
              message.tone === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      {!asnEnabled ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Shipment announcements are disabled for this account.
        </p>
      ) : !canCreate ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Your access is view-only. Contact your warehouse provider to be able to announce shipments.
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-5 rounded-lg border bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="expected_date" className="mb-2 block text-sm font-medium">
              Expected arrival
            </label>
            <input
              id="expected_date"
              type="date"
              className="w-full rounded-md border px-3 py-2"
              value={expectedDate}
              onChange={(event) => setExpectedDate(event.target.value)}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">What is coming</label>
            <span className="text-xs text-slate-500">
              {filledLines.length} line{filledLines.length === 1 ? "" : "s"} &middot; {totalExpected} units
            </span>
          </div>

          {itemsLoaded && items.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              None of your items are set up in the warehouse system yet. Ask your warehouse provider to
              add them, then come back to announce your shipment.
            </p>
          ) : (
            <div className="space-y-3">
              {lines.map((line, index) => {
                const selected = itemsById.get(line.item_id)
                return (
                  <div key={line.key} className="rounded-md border p-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
                      <div>
                        <label className="mb-1 block text-xs text-slate-500">Item {index + 1}</label>
                        <select
                          className="w-full rounded-md border px-3 py-2"
                          value={line.item_id}
                          disabled={blocked}
                          onChange={(event) => updateLine(line.key, { item_id: event.target.value })}
                        >
                          <option value="">Select an item...</option>
                          {items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.item_name} ({item.item_code})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-xs text-slate-500">
                          Quantity{selected?.uom ? ` (${selected.uom})` : ""}
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          className="w-full rounded-md border px-3 py-2"
                          value={line.expected_quantity}
                          disabled={blocked}
                          onChange={(event) =>
                            updateLine(line.key, { expected_quantity: event.target.value })
                          }
                        />
                      </div>

                      <div className="flex items-end">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-2 text-sm text-slate-600 disabled:opacity-40"
                          disabled={lines.length === 1 || blocked}
                          onClick={() =>
                            setLines((current) => current.filter((entry) => entry.key !== line.key))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    {/* Only asked for when the item master says the item is
                        tracked that way -- every client sees a batch box on
                        every line otherwise, and fills it in with nothing. */}
                    {selected?.is_batch_tracked || selected?.is_expiry_tracked ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {selected?.is_batch_tracked ? (
                          <div>
                            <label className="mb-1 block text-xs text-slate-500">Batch number</label>
                            <input
                              type="text"
                              className="w-full rounded-md border px-3 py-2"
                              value={line.batch_no}
                              disabled={blocked}
                              onChange={(event) => updateLine(line.key, { batch_no: event.target.value })}
                            />
                          </div>
                        ) : null}
                        {selected?.is_expiry_tracked ? (
                          <div>
                            <label className="mb-1 block text-xs text-slate-500">Expiry date</label>
                            <input
                              type="date"
                              className="w-full rounded-md border px-3 py-2"
                              value={line.expiry_date}
                              disabled={blocked}
                              onChange={(event) =>
                                updateLine(line.key, { expiry_date: event.target.value })
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}

              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-40"
                disabled={blocked}
                onClick={() => setLines((current) => [...current, newLine()])}
              >
                + Add another item
              </button>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="remarks" className="mb-2 block text-sm font-medium">
            Notes for the warehouse
          </label>
          <textarea
            id="remarks"
            rows={3}
            className="w-full rounded-md border px-3 py-2"
            value={remarks}
            disabled={blocked}
            placeholder="Vehicle number, transporter, special handling..."
            onChange={(event) => setRemarks(event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-[#0b2545] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Submitting..." : "Announce shipment"}
        </button>
      </form>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your announcements</h2>
        {history.length === 0 ? (
          <p className="rounded-md border bg-white p-4 text-sm text-slate-500">
            You have not announced any shipments yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((row) => {
              const copy = statusCopy(row.status)
              const isOpen = expanded === row.id
              return (
                <li key={row.id} className="rounded-lg border bg-white">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 p-4 text-left"
                    onClick={() => void toggleDetail(row.id)}
                    aria-expanded={isOpen}
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{row.request_number}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {row.expected_date
                          ? `Expected ${new Date(row.expected_date).toLocaleDateString()}`
                          : "No expected date"}
                        {" · "}
                        {Number(row.line_count)} line{Number(row.line_count) === 1 ? "" : "s"}
                        {" · "}
                        {Number(row.expected_quantity)} units
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${copy.tone}`}>
                      {copy.label}
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="border-t px-4 py-3 text-sm">
                      <p className="text-slate-600">{copy.detail}</p>
                      {row.review_remarks ? (
                        <p className="mt-2 rounded-md bg-slate-50 p-2 text-slate-700">
                          <span className="font-medium">Warehouse note:</span> {row.review_remarks}
                        </p>
                      ) : null}

                      {!detail ? (
                        <p className="mt-3 text-slate-400">Loading...</p>
                      ) : (
                        <>
                          <table className="mt-3 w-full text-left">
                            <thead className="text-xs uppercase text-slate-500">
                              <tr>
                                <th className="py-1">Item</th>
                                <th className="py-1">Expected</th>
                                <th className="py-1">Batch</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.lines.map((detailLine) => (
                                <tr key={detailLine.id} className="border-t">
                                  <td className="py-1.5">
                                    {detailLine.item_name}{" "}
                                    <span className="text-slate-400">({detailLine.item_code})</span>
                                  </td>
                                  <td className="py-1.5">
                                    {Number(detailLine.expected_quantity)} {detailLine.uom || ""}
                                  </td>
                                  <td className="py-1.5 text-slate-500">{detailLine.batch_no || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {detail.receipts.length > 0 ? (
                            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                              <p className="text-xs font-medium uppercase text-emerald-800">
                                Booked in against this request
                              </p>
                              <ul className="mt-1 space-y-1">
                                {detail.receipts.map((receipt) => (
                                  <li key={receipt.id} className="text-emerald-900">
                                    <Link href={`/portal/orders`} className="font-medium underline">
                                      {receipt.grn_number}
                                    </Link>{" "}
                                    &middot; {new Date(receipt.grn_date).toLocaleDateString()} &middot;{" "}
                                    {Number(receipt.total_quantity)} units received
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
