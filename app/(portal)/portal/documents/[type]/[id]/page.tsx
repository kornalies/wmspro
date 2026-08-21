"use client"

/**
 * The client's side of the document engine.
 *
 * Renders with the same <DocumentSheet> the operator screens use, deliberately:
 * a client querying an invoice and the finance user answering them should be
 * looking at identical paper, down to the template version in the footer. Only
 * the data route differs, because the access rules do.
 *
 * There is no PDF generator here. The sheet is print-styled, and the browser's
 * own "Save as PDF" produces a better file than a server-side renderer would --
 * with none of the fonts, headless browser or queue that would otherwise have to
 * be operated.
 */

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"

import { DocumentSheet } from "@/components/documents/document-sheet"
import { usePortalScope } from "@/components/portal/portal-scope"
import { isDocumentType, type DocumentModel } from "@/lib/documents/types"

const PORTAL_TYPES = ["commercial-invoice", "client-statement"]

export default function PortalDocumentPage() {
  const params = useParams<{ type: string; id: string }>()
  const { client, can, loading: scopeLoading } = usePortalScope()
  const clientId = client?.id ?? null
  const backHref = client ? `/portal/billing?client=${encodeURIComponent(client.client_code)}` : "/portal/billing"

  const [model, setModel] = useState<DocumentModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    if (!clientId || !params.type || !params.id) return
    if (!isDocumentType(params.type) || !PORTAL_TYPES.includes(params.type)) {
      setError("That document is not available here.")
      setLoading(false)
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch(
        `/api/portal/documents/${params.type}/${params.id}?client_id=${clientId}`,
        { cache: "no-store" }
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message || "Please try again in a moment.")
        setModel(null)
      } else {
        setModel(json?.data as DocumentModel)
      }
    } catch {
      setError("Check your connection and try again.")
      setModel(null)
    } finally {
      setLoading(false)
    }
  }, [clientId, params.id, params.type])

  useEffect(() => {
    if (!can.billing) {
      setLoading(false)
      return
    }
    void load()
  }, [can.billing, load])

  if (!can.billing && !scopeLoading) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-medium text-amber-900">This document is not available to you</p>
        <p className="mt-1 text-sm text-amber-800">
          Ask your warehouse provider to enable billing visibility on your portal account.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* no-print keeps the controls off the paper; the sheet supplies its own
          print styles, shared with the operator view. */}
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link
          href={backHref}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
        >
          Back to billing
        </Link>
        {model ? (
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-800"
          >
            Print or save as PDF
          </button>
        ) : null}
      </div>

      {loading || scopeLoading ? (
        <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-6">
          <div className="h-6 w-1/3 animate-pulse rounded bg-neutral-200" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-100" />
          <div className="h-40 animate-pulse rounded bg-neutral-100" />
        </div>
      ) : error || !model ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-medium text-red-900">We could not produce this document.</p>
          <p className="mt-1 text-sm text-red-800">{error || "Please try again in a moment."}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : (
        <DocumentSheet model={model} />
      )}
    </div>
  )
}
