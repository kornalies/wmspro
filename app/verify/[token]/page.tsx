/**
 * Public document verification landing page (FR-09).
 *
 * This is the other half of the QR printed on every document. It is reachable
 * WITHOUT a session — the audience is the transporter at a gate, the consignee
 * signing for a delivery, and the auditor holding a printout two years later,
 * none of whom have a WMS login. proxy.ts short-circuits /verify before its auth
 * gate for exactly this reason; see the comment there.
 *
 * What it discloses is deliberately thin: document number, type, date, issuing
 * warehouse and live status. It answers "is this genuine and still current?" and
 * nothing else. No line items, no quantities, no prices, no counterparty. If
 * this page ever needs to show more, that is a decision to re-make explicitly
 * rather than a field to quietly add.
 */

import Link from "next/link"

import { getClient, setTenantContext } from "@/lib/db"
import { loadDocumentSummary, type DocumentSummary } from "@/lib/documents/summary"
import { verifyDocumentToken } from "@/lib/documents/verify"
import type { DocumentStatusTone } from "@/lib/documents/types"

export const dynamic = "force-dynamic"

const TONE_STYLES: Record<DocumentStatusTone, string> = {
  pending: "bg-amber-50 text-amber-800 ring-amber-300",
  approved: "bg-green-50 text-green-800 ring-green-300",
  completed: "bg-green-50 text-green-800 ring-green-300",
  "in-transit": "bg-blue-50 text-blue-800 ring-blue-300",
  cancelled: "bg-red-50 text-red-800 ring-red-300",
  draft: "bg-slate-100 text-slate-700 ring-slate-300",
}

async function resolve(token: string): Promise<DocumentSummary | null> {
  const payload = await verifyDocumentToken(token)
  if (!payload) return null

  const db = await getClient()
  try {
    // The tenant context comes from the signed token, not from a session or the
    // URL, so a scanner can only ever reach the company the document was issued
    // by — and only the one record the token names.
    await db.query("BEGIN")
    await setTenantContext(db, payload.companyId)
    const summary = await loadDocumentSummary(db, payload.type, payload.id, payload.companyId)
    await db.query("COMMIT")
    return summary
  } catch {
    await db.query("ROLLBACK")
    return null
  } finally {
    db.release()
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
        {children}
        <p className="mt-7 border-t border-slate-100 pt-4 text-center text-[11px] leading-relaxed text-slate-400">
          Document verification · GWU WMS
          <br />
          This page confirms a document&apos;s authenticity and current status only.
        </p>
      </div>
    </main>
  )
}

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const summary = await resolve(token)

  if (!summary) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-xl text-red-600 ring-1 ring-red-200">
            !
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Not verified</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            This code does not correspond to a document issued by this system. It may
            have been mistyped, damaged in printing, or altered.
          </p>
          <p className="mt-4 text-xs text-slate-500">
            If you received this document from a counterparty, contact the issuing
            warehouse before acting on it.
          </p>
        </div>
      </Shell>
    )
  }

  const tone = TONE_STYLES[summary.status.tone]
  const warn = summary.status.tone === "cancelled" || summary.status.tone === "draft"

  return (
    <Shell>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-green-50 text-xl text-green-600 ring-1 ring-green-200">
          ✓
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Document verified</h1>
        <p className="mt-1 text-sm text-slate-600">
          This document was issued by GWU WMS.
        </p>
      </div>

      <dl className="mt-6 divide-y divide-slate-100 border-y border-slate-100 text-sm">
        {[
          ["Document", summary.title],
          ["Number", summary.documentNumber],
          ["Date", summary.documentDate],
          ["Warehouse", summary.warehouse],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="text-right font-medium text-slate-900">{value}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 py-2.5">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt>
          <dd>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${tone}`}
            >
              {summary.status.label}
            </span>
          </dd>
        </div>
      </dl>

      {warn ? (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-800 ring-1 ring-red-200">
          <strong>Do not act on this document.</strong> Its current status is{" "}
          {summary.status.label.toLowerCase()}. Any printed copy you are holding is
          superseded — confirm with the issuing warehouse.
        </p>
      ) : null}

      <p className="mt-6 text-center text-xs text-slate-500">
        Warehouse staff can{" "}
        <Link href="/login" className="font-medium text-blue-700 underline">
          sign in
        </Link>{" "}
        for full document details.
      </p>
    </Shell>
  )
}
