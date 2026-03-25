"use client"

import { Loader2 } from "lucide-react"

import { useGateOutLogs } from "@/hooks/use-gate"
import { GateOutForm } from "@/components/gate/GateOutForm"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type GateOutRow = {
  id: number
  gate_out_number: string
  do_number?: string
  vehicle_number: string
  driver_name: string
  gate_out_datetime: string
}

export default function GateOutPage() {
  const { data, isLoading } = useGateOutLogs()
  const rows = (data?.data as GateOutRow[] | undefined) ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Gate Out</h1>
        <p className="mt-1 text-gray-500">Record vehicle exit</p>
      </div>

      <GateOutForm />

      <Card>
        <CardContent className="pt-6">
          <h3 className="mb-4 text-lg font-semibold">Recent Exits</h3>
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Gate Out</TableHead>
                  <TableHead>DO Number</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Date/Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 20).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.gate_out_number}</TableCell>
                    <TableCell>{row.do_number || "-"}</TableCell>
                    <TableCell>{row.vehicle_number}</TableCell>
                    <TableCell>{row.driver_name}</TableCell>
                    <TableCell>{new Date(row.gate_out_datetime).toLocaleString()}</TableCell>
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
