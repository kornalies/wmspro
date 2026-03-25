"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowRight, Loader2 } from "lucide-react"

import { useMobileGrnCaptures } from "@/hooks/use-mobile-grn"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

export default function MobileGrnApprovalListPage() {
  const [status, setStatus] = useState<"PENDING" | "APPROVED" | "REJECTED" | "ALL">("PENDING")
  const listQuery = useMobileGrnCaptures(status)

  if (listQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Mobile GRN Approvals</h1>
          <p className="mt-1 text-gray-500">Review captured mobile GRNs and approve into stock</p>
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="ALL">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {listQuery.isError && (
        <Card className="border-red-200">
          <CardContent className="pt-6 text-sm text-red-700">
            Failed to load mobile captures.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Captured GRNs ({listQuery.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Capture Ref</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(listQuery.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-gray-500">
                    No captures found
                  </TableCell>
                </TableRow>
              )}
              {(listQuery.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-sm">{row.capture_ref}</TableCell>
                  <TableCell>{row.invoice_number || "-"}</TableCell>
                  <TableCell>{row.supplier_name || "-"}</TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell>{new Date(row.created_at).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/grn/mobile-approvals/${row.id}`}>
                        Open
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
