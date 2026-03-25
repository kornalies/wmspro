"use client"

import { CheckCircle, Clock, Download, FileSpreadsheet, Loader2, Truck } from "lucide-react"

import { useGateInLogs } from "@/hooks/use-gate"
import { GateInForm } from "@/components/gate/GateInForm"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { exportGateInReportPDF, exportGateInToExcel } from "@/lib/export-utils"

type GateInRow = {
  id: number
  gate_in_number: string
  vehicle_number: string
  driver_name: string
  transport_company?: string
  lr_number?: string
  lr_date?: string
  e_way_bill_number?: string
  e_way_bill_date?: string
  from_location?: string
  to_location?: string
  vehicle_type?: string
  vehicle_model?: string
  transported_by?: string
  vendor_name?: string
  transportation_remarks?: string
  gate_in_datetime: string
  client_name: string
  warehouse_name: string
}

export default function GateInPage() {
  const { data, isLoading } = useGateInLogs()
  const entries = (data?.data as GateInRow[] | undefined) ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Gate In</h1>
        <p className="mt-1 text-gray-500">Record vehicle entry</p>
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="outline" onClick={() => exportGateInReportPDF(entries)}>
            <Download className="mr-2 h-4 w-4" />
            Export PDF
          </Button>
          <Button type="button" variant="outline" onClick={() => exportGateInToExcel(entries)}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <GateInForm />
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-4 flex items-center gap-2 font-semibold">
                <Clock className="h-4 w-4" />
                Recent Entries
              </h3>
              {isLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  {entries.slice(0, 5).map((entry) => (
                    <div key={entry.id} className="rounded border-l-4 border-green-500 bg-green-50 p-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <p className="text-sm font-medium">{entry.vehicle_number}</p>
                          <p className="text-xs text-gray-600">{entry.transport_company || entry.driver_name}</p>
                          <p className="mt-1 text-xs text-gray-500">{entry.client_name}</p>
                          <p className="mt-1 text-xs text-gray-500">
                            {entry.from_location || "-"} to {entry.to_location || "-"}
                          </p>
                        </div>
                        <CheckCircle className="h-4 w-4 text-green-600" />
                      </div>
                      <p className="mt-2 text-xs text-gray-400">
                        {new Date(entry.gate_in_datetime).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <Truck className="mx-auto mb-2 h-12 w-12 text-gray-400" />
                <p className="text-2xl font-bold">{entries.length}</p>
                <p className="text-sm text-gray-600">Recent Gate In Records</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
