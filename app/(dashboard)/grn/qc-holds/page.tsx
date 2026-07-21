"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
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
  QcDisposition,
  QcHoldRow,
  useDispositionQcHold,
  useQcHolds,
} from "@/hooks/use-qc-holds"

const DISPOSITIONS: { value: QcDisposition; label: string }[] = [
  { value: "RELEASE", label: "Release to stock" },
  { value: "SCRAP", label: "Scrap" },
  { value: "RETURN_TO_VENDOR", label: "Return to vendor" },
  { value: "REWORK", label: "Rework (keep held)" },
]

function HoldRow({ hold }: { hold: QcHoldRow }) {
  const [choice, setChoice] = useState<QcDisposition | "">("")
  const disposition = useDispositionQcHold()

  return (
    <TableRow>
      <TableCell className="font-medium">{hold.lp_code || hold.lp_id}</TableCell>
      <TableCell>{hold.sku || "—"}</TableCell>
      <TableCell>
        <Badge variant="outline">{hold.result || "REJECT"}</Badge>
      </TableCell>
      <TableCell>{hold.reason_code || "—"}</TableCell>
      <TableCell className="text-right">
        {hold.rejected_qty ?? "—"}
        {hold.total_qty != null ? ` / ${hold.total_qty}` : ""}
      </TableCell>
      <TableCell className="max-w-[220px] truncate" title={hold.remarks || ""}>
        {hold.remarks || "—"}
      </TableCell>
      <TableCell>{hold.inspector_name || "—"}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Select value={choice} onValueChange={(v) => setChoice(v as QcDisposition)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Disposition" />
            </SelectTrigger>
            <SelectContent>
              {DISPOSITIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!choice || disposition.isPending}
            onClick={() => {
              if (!choice) return
              disposition.mutate({ hold_id: hold.hold_id, disposition: choice })
            }}
          >
            {disposition.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

export default function QcHoldsPage() {
  const holdsQuery = useQcHolds()

  if (holdsQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const holds = holdsQuery.data ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">QC Holds</h1>
        <p className="mt-1 text-gray-500">
          Review inbound QC rejections and decide the disposition of quarantined stock
        </p>
      </div>

      {holdsQuery.isError && (
        <Card className="border-red-200">
          <CardContent className="pt-6 text-sm text-red-700">
            {holdsQuery.error instanceof Error
              ? holdsQuery.error.message
              : "Failed to load QC holds. The disposition workflow may not be enabled for this tenant."}
          </CardContent>
        </Card>
      )}

      {!holdsQuery.isError && holds.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No open QC holds.
          </CardContent>
        </Card>
      )}

      {holds.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>LP</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead>Remarks</TableHead>
                  <TableHead>Inspector</TableHead>
                  <TableHead>Disposition</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holds.map((hold) => (
                  <HoldRow key={hold.hold_id} hold={hold} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}