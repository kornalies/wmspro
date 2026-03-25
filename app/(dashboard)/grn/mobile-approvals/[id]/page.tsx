"use client"

import Link from "next/link"
import { useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react"

import {
  useApproveMobileCapture,
  useMobileGrnCaptureDetail,
  useRejectMobileCapture,
} from "@/hooks/use-mobile-grn"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export default function MobileGrnApprovalDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [rejectNote, setRejectNote] = useState("")

  const detailQuery = useMobileGrnCaptureDetail(params.id)
  const approveMutation = useApproveMobileCapture()
  const rejectMutation = useRejectMobileCapture()

  const details = detailQuery.data
  const payloadHeader = details?.payload?.header ?? {}
  const lineItems = details?.payload?.lineItems ?? []

  const onApprove = async () => {
    await approveMutation.mutateAsync(Number(params.id))
    router.push("/grn/mobile-approvals")
  }

  const onReject = async () => {
    await rejectMutation.mutateAsync({ id: Number(params.id), notes: rejectNote })
    router.push("/grn/mobile-approvals")
  }

  if (detailQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (detailQuery.isError || !details) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-red-700">Capture not found.</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm">
          <Link href="/grn/mobile-approvals">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to list
          </Link>
        </Button>
        <div className="text-sm text-gray-600">
          Ref: <span className="font-mono">{details.capture_ref}</span>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Captured Header</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <p className="text-sm"><span className="font-medium">Status:</span> {details.status}</p>
          <p className="text-sm">
            <span className="font-medium">Invoice No:</span> {String(payloadHeader.invoice_number || "-")}
          </p>
          <p className="text-sm">
            <span className="font-medium">Invoice Date:</span> {String(payloadHeader.invoice_date || "-")}
          </p>
          <p className="text-sm">
            <span className="font-medium">Supplier:</span> {String(payloadHeader.supplier_name || "-")}
          </p>
          <p className="text-sm">
            <span className="font-medium">Gate In No:</span> {String(payloadHeader.gate_in_number || "-")}
          </p>
          <p className="text-sm">
            <span className="font-medium">Handling:</span> {String(payloadHeader.handling_type || "-")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Captured Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item ID</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Serials</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((line, idx) => (
                <TableRow key={`${line.item_id}-${idx}`}>
                  <TableCell>{line.item_id}</TableCell>
                  <TableCell className="text-right">{line.quantity}</TableCell>
                  <TableCell className="text-right">{line.rate ?? 0}</TableCell>
                  <TableCell className="max-w-[420px] text-xs text-gray-600">
                    {(line.serial_numbers || []).join(", ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {details.status === "PENDING" && (
        <Card>
          <CardHeader>
            <CardTitle>Approval Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-gray-600">Rejection note (optional)</p>
              <Input
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Reason for rejection"
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={onApprove}
                disabled={approveMutation.isPending || rejectMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle2 className="h-4 w-4" />
                Approve
              </Button>
              <Button
                onClick={onReject}
                disabled={approveMutation.isPending || rejectMutation.isPending}
                variant="destructive"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
