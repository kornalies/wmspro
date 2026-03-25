"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { ArrowLeft, FileText, Loader2 } from "lucide-react"

import api from "@/lib/api"
import { formatDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type GRNDetailsResponse = {
  data: {
    header: {
      id: number
      grn_number: string
      grn_date: string
      invoice_number: string
      invoice_date: string
      client_name: string
      warehouse_name: string
      supplier_name?: string
      gate_in_number?: string
      model_number?: string
      material_description?: string
      receipt_date?: string
      manufacturing_date?: string
      basic_price?: number
      invoice_quantity?: number
      received_quantity?: number
      quantity_difference?: number
      damage_quantity?: number
      case_count?: number
      pallet_count?: number
      weight_kg?: number
      handling_type?: string
      status: string
      total_items: number
      total_quantity: number
    }
    lineItems: Array<{
      id: number
      item_code: string
      item_name: string
      bin_location?: string
      quantity: number
      rate?: number
      amount?: number
      serial_numbers?: string[]
    }>
  }
}

export default function GRNDetailsPage() {
  const params = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [details, setDetails] = useState<GRNDetailsResponse["data"] | null>(null)

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        setLoading(true)
        const response = (await api.get(`/grn/${params.id}`)) as GRNDetailsResponse
        setDetails(response.data)
        setError("")
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load GRN details")
      } finally {
        setLoading(false)
      }
    }

    if (params.id) void fetchDetails()
  }, [params.id])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !details) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GRN Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-red-600">{error || "GRN not found"}</p>
          <Button asChild variant="outline">
            <Link href="/grn">Back to GRN List</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const { header, lineItems } = details

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/grn">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">{header.grn_number}</h1>
          <Badge>{header.status}</Badge>
        </div>
        <Button asChild variant="outline">
          <Link href={`/grn/print/${header.id}`}>
            <FileText className="mr-2 h-4 w-4" />
            Print
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Header Information</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <p className="text-sm">
            <span className="font-medium">GRN Date:</span> {formatDate(header.grn_date)}
          </p>
          <p className="text-sm">
            <span className="font-medium">Invoice Number:</span> {header.invoice_number}
          </p>
          <p className="text-sm">
            <span className="font-medium">Invoice Date:</span> {formatDate(header.invoice_date)}
          </p>
          <p className="text-sm">
            <span className="font-medium">Client:</span> {header.client_name}
          </p>
          <p className="text-sm">
            <span className="font-medium">Warehouse:</span> {header.warehouse_name}
          </p>
          <p className="text-sm">
            <span className="font-medium">Supplier:</span> {header.supplier_name || "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Gate In Number:</span> {header.gate_in_number || "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Model Number:</span> {header.model_number || "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Material Description:</span> {header.material_description || "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Receipt Date:</span> {header.receipt_date ? formatDate(header.receipt_date) : "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Manufacturing Date:</span> {header.manufacturing_date ? formatDate(header.manufacturing_date) : "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Basic Price:</span> {header.basic_price ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Invoice Qty:</span> {header.invoice_quantity ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Received Qty:</span> {header.received_quantity ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Difference:</span> {header.quantity_difference ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Damage Qty:</span> {header.damage_quantity ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">No. of Cases:</span> {header.case_count ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">No. of Pallets:</span> {header.pallet_count ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Weight (kg):</span> {header.weight_kg ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Handling Type:</span> {header.handling_type ?? "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Total Items:</span> {header.total_items}
          </p>
          <p className="text-sm">
            <span className="font-medium">Total Quantity:</span> {header.total_quantity}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Put Away Bin</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Serial Numbers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">{item.item_name}</div>
                    <div className="text-xs text-gray-500">{item.item_code}</div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{item.bin_location || "-"}</TableCell>
                  <TableCell className="text-right">{item.quantity}</TableCell>
                  <TableCell className="text-right">{item.rate ?? 0}</TableCell>
                  <TableCell className="text-right">{item.amount ?? 0}</TableCell>
                  <TableCell className="max-w-[380px]">
                    <div className="max-h-28 overflow-auto text-xs text-gray-600">
                      {(item.serial_numbers || []).join(", ") || "-"}
                    </div>
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
