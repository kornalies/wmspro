"use client"

/**
 * Inbound announcements from the client portal.
 *
 * This screen is the missing half of the portal's ASN feature: clients could
 * submit shipment notices, and no operator-facing page ever displayed one, so
 * every request sat unread. Accepting a request does not create anything -- it
 * records that the warehouse expects the truck and unlocks "Receive", which
 * opens the ordinary GRN form prefilled from the announced lines. Staff correct
 * the quantities against what actually came off the vehicle before saving,
 * because what was announced and what arrived are different facts.
 */

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, Loader2, PackageSearch, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  useAsnRequest,
  useAsnRequests,
  useReviewAsnRequest,
  type AsnRequestRow,
} from "@/hooks/use-asn-requests"

const STATUS_VARIANTS: Record<string, string> = {
  REQUESTED: "border-amber-300 bg-amber-50 text-amber-800",
  ACCEPTED: "border-sky-300 bg-sky-50 text-sky-800",
  REJECTED: "border-red-300 bg-red-50 text-red-700",
  RECEIVED: "border-emerald-300 bg-emerald-50 text-emerald-800",
  CANCELLED: "border-slate-300 bg-slate-100 text-slate-600",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_VARIANTS[status] || ""}>
      {status}
    </Badge>
  )
}

function RequestDetail({ request, onClose }: { request: AsnRequestRow; onClose: () => void }) {
  const router = useRouter()
  const { data: detail, isLoading } = useAsnRequest(request.id)
  const review = useReviewAsnRequest()
  const [remarks, setRemarks] = useState("")

  const isPending = request.status === "REQUESTED"
  const canReceive = request.status === "ACCEPTED"

  return (
    <Card className="border-2 border-blue-200">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-3">
            {request.request_number}
            <StatusBadge status={request.status} />
          </CardTitle>
          <p className="mt-1 text-sm text-gray-500">
            {request.client_name} ({request.client_code})
            {request.expected_date
              ? ` · expected ${new Date(request.expected_date).toLocaleDateString()}`
              : " · no expected date"}
            {request.requested_by_name ? ` · raised by ${request.requested_by_name}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {request.remarks ? (
          <p className="rounded-md bg-slate-50 p-3 text-sm">
            <span className="font-medium">Client note:</span> {request.remarks}
          </p>
        ) : null}

        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading lines...
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Expiry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(detail?.lines || []).map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.line_number}</TableCell>
                  <TableCell>
                    <span className="font-medium">{line.item_name}</span>{" "}
                    <span className="text-gray-400">({line.item_code})</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(line.expected_quantity)} {line.uom || ""}
                  </TableCell>
                  <TableCell>{line.batch_no || "—"}</TableCell>
                  <TableCell>
                    {line.expiry_date ? new Date(line.expiry_date).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {detail?.receipts?.length ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
            <p className="font-medium text-emerald-900">Receipts against this request</p>
            <ul className="mt-1 space-y-1">
              {detail.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <Link href={`/grn/${receipt.id}`} className="font-medium underline">
                    {receipt.grn_number}
                  </Link>{" "}
                  · {receipt.status} · {Number(receipt.total_quantity)} units
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {request.review_remarks ? (
          <p className="rounded-md bg-slate-50 p-3 text-sm">
            <span className="font-medium">Review note:</span> {request.review_remarks}
            {request.reviewed_by_name ? ` — ${request.reviewed_by_name}` : ""}
          </p>
        ) : null}

        {isPending ? (
          <div className="space-y-3 border-t pt-4">
            <Input
              placeholder="Note to the client (optional, but expected if you reject)"
              value={remarks}
              onChange={(event) => setRemarks(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  review.mutate({ id: request.id, decision: "ACCEPT", remarks: remarks || undefined })
                }
                disabled={review.isPending || Number(request.line_count) === 0}
              >
                <Check className="mr-2 h-4 w-4" />
                Accept shipment
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  review.mutate({ id: request.id, decision: "REJECT", remarks: remarks || undefined })
                }
                disabled={review.isPending}
              >
                <X className="mr-2 h-4 w-4" />
                Reject
              </Button>
            </div>
            {Number(request.line_count) === 0 ? (
              <p className="text-sm text-amber-700">
                This request has no line items — it predates itemised announcements. It can only be
                rejected; ask the client to resubmit.
              </p>
            ) : null}
          </div>
        ) : null}

        {canReceive ? (
          <div className="border-t pt-4">
            <Button onClick={() => router.push(`/grn/new/manual?asn=${request.id}`)}>
              <PackageSearch className="mr-2 h-4 w-4" />
              Receive against this request
            </Button>
            <p className="mt-2 text-sm text-gray-500">
              Opens a new GRN with these lines filled in. Correct the quantities to what actually
              arrived before saving.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default function AsnRequestsPage() {
  const [status, setStatus] = useState("OPEN")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<AsnRequestRow | null>(null)

  // "OPEN" is the page default and means REQUESTED + ACCEPTED, which the API
  // applies when no status is sent. Any other value is passed straight through.
  const { data: requests = [], isLoading } = useAsnRequests({
    status: status === "OPEN" ? undefined : status,
    search: search || undefined,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/grn">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to GRN List
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold">Client Shipment Notices</h1>
          <p className="mt-1 text-gray-500">
            Inbound shipments your clients have announced through the portal.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="OPEN">Open (awaiting action)</SelectItem>
            <SelectItem value="REQUESTED">Awaiting review</SelectItem>
            <SelectItem value="ACCEPTED">Accepted</SelectItem>
            <SelectItem value="RECEIVED">Received</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="ALL">All</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-[280px]"
          placeholder="Search request number or client"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {selected ? <RequestDetail request={selected} onClose={() => setSelected(null)} /> : null}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="flex items-center gap-2 p-6 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </p>
          ) : requests.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">
              No shipment notices here. Clients raise these from the portal.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Raised</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <TableCell className="font-medium">{row.request_number}</TableCell>
                    <TableCell>{row.client_name}</TableCell>
                    <TableCell>
                      {row.expected_date ? new Date(row.expected_date).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">{Number(row.line_count)}</TableCell>
                    <TableCell className="text-right">{Number(row.expected_quantity)}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>{new Date(row.created_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm">
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
