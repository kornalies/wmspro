"use client"

import { Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { ArrowLeft, FileText, Loader2, PackageSearch } from "lucide-react"

import { GRNForm } from "@/components/grn/GRNForm"
import { Button } from "@/components/ui/button"
import { useAsnRequest } from "@/hooks/use-asn-requests"

/**
 * Manual GRN entry, optionally seeded from a client's shipment notice.
 *
 * With ?asn=<id> the client's announced lines are filled in and the saved GRN
 * points back at the request. The quantities are only a starting point --
 * they are what the client said was coming, and the operator is expected to
 * correct them to what the count on the dock actually was. Serial numbers and
 * putaway bins are deliberately left empty: no client can tell us those.
 */
function ManualGRNContent() {
  const searchParams = useSearchParams()
  const asnRequestId = Number(searchParams.get("asn")) || null
  const { data: asn, isLoading, isError } = useAsnRequest(asnRequestId)

  if (asnRequestId && isLoading) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading shipment notice...
      </p>
    )
  }

  if (asnRequestId && (isError || !asn)) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">
          That shipment notice could not be loaded. It may have been withdrawn.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link href="/grn/asn-requests">Back to shipment notices</Link>
        </Button>
      </div>
    )
  }

  // An ASN that is not ACCEPTED cannot be received -- the API rejects the link
  // on save. Saying so here beats letting an operator key in an entire GRN and
  // then fail at the last step.
  if (asn && asn.status !== "ACCEPTED") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm text-amber-800">
          {asn.request_number} is {asn.status.toLowerCase()}, so it cannot be received against.
          {asn.status === "REQUESTED" ? " Accept it first." : ""}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link href="/grn/asn-requests">Back to shipment notices</Link>
        </Button>
      </div>
    )
  }

  const initialData = asn
    ? {
        client_id: asn.client_id,
        material_description: asn.remarks || undefined,
        lineItems: asn.lines.map((line) => ({
          item_id: line.item_id,
          quantity: Number(line.expected_quantity),
        })),
      }
    : null

  return (
    <>
      {asn ? (
        <div className="flex items-start gap-3 rounded-md border border-sky-200 bg-sky-50 p-4">
          <PackageSearch className="mt-0.5 h-5 w-5 shrink-0 text-sky-700" />
          <div className="text-sm">
            <p className="font-medium text-sky-900">
              Receiving against {asn.request_number} — {asn.client_name}
            </p>
            <p className="mt-1 text-sky-800">
              Lines below are what the client announced
              {asn.expected_date
                ? `, expected ${new Date(asn.expected_date).toLocaleDateString()}`
                : ""}
              . Change the quantities to what actually arrived, then add serials and putaway bins.
            </p>
          </div>
        </div>
      ) : null}

      <GRNForm initialData={initialData} asnRequestId={asnRequestId ?? undefined} />
    </>
  )
}

export default function ManualGRNPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/grn">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Create GRN (Manual Entry)</h1>
            <p className="text-gray-500">Enter invoice and line item details manually</p>
          </div>
        </div>

        <Button asChild variant="outline">
          <Link href="/grn/new">
            <FileText className="mr-2 h-4 w-4" />
            Switch to Scanner
          </Link>
        </Button>
      </div>

      {/* useSearchParams opts the whole route out of static rendering without a
          boundary, which fails the production build. */}
      <Suspense
        fallback={
          <p className="flex items-center gap-2 p-6 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </p>
        }
      >
        <ManualGRNContent />
      </Suspense>
    </div>
  )
}
