"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { ArrowLeft, Loader2, Printer } from "lucide-react"

import api from "@/lib/api"
import { formatDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type PrintResponse = {
  data: {
    header: {
      grn_number: string
      status: string
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
      total_items: number
      total_quantity: number
    }
    lineItems: Array<{
      id: number
      item_code: string
      item_name: string
      quantity: number
      serial_numbers?: string[]
    }>
  }
}

export default function PrintGRNPage() {
  const params = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [details, setDetails] = useState<PrintResponse["data"] | null>(null)

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        setLoading(true)
        const response = (await api.get(`/grn/${params.id}`)) as PrintResponse
        setDetails(response.data)
        setError("")
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load print details")
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
    return <p className="text-sm text-red-600">{error || "Unable to render print view."}</p>
  }

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/grn/${params.id}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          Print
        </Button>
      </div>

      <div className="grn-print-root rounded-md border bg-white p-6 text-sm">
        <div className="mb-4 border-b pb-3">
          <h1 className="text-xl font-bold">Goods Receipt Note</h1>
          {details.header.status === "CANCELLED" && (
            <p className="mt-1 inline-block rounded border border-red-400 bg-red-50 px-2 py-1 text-xs font-bold text-red-700">
              CANCELLED
            </p>
          )}
          <p className="text-xs text-gray-600">Generated on {new Date().toLocaleString()}</p>
        </div>

        <table className="w-full border-collapse text-xs">
          <tbody>
            <tr>
              <td className="print-cell print-label">GRN Number</td>
              <td className="print-cell">{details.header.grn_number}</td>
              <td className="print-cell print-label">GRN Date</td>
              <td className="print-cell">{formatDate(details.header.grn_date)}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Invoice Number</td>
              <td className="print-cell">{details.header.invoice_number}</td>
              <td className="print-cell print-label">Invoice Date</td>
              <td className="print-cell">{formatDate(details.header.invoice_date)}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Client</td>
              <td className="print-cell">{details.header.client_name}</td>
              <td className="print-cell print-label">Warehouse</td>
              <td className="print-cell">{details.header.warehouse_name}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Supplier</td>
              <td className="print-cell">{details.header.supplier_name || "-"}</td>
              <td className="print-cell print-label">Gate In Number</td>
              <td className="print-cell">{details.header.gate_in_number || "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Model Number</td>
              <td className="print-cell">{details.header.model_number || "-"}</td>
              <td className="print-cell print-label">Handling Type</td>
              <td className="print-cell">{details.header.handling_type || "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Material Description</td>
              <td className="print-cell">{details.header.material_description || "-"}</td>
              <td className="print-cell print-label">Receipt Date</td>
              <td className="print-cell">
                {details.header.receipt_date ? formatDate(details.header.receipt_date) : "-"}
              </td>
            </tr>
            <tr>
              <td className="print-cell print-label">Mfg Date</td>
              <td className="print-cell">
                {details.header.manufacturing_date ? formatDate(details.header.manufacturing_date) : "-"}
              </td>
              <td className="print-cell print-label">Basic Price</td>
              <td className="print-cell">{details.header.basic_price ?? "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Invoice Qty</td>
              <td className="print-cell">{details.header.invoice_quantity ?? "-"}</td>
              <td className="print-cell print-label">Received Qty</td>
              <td className="print-cell">{details.header.received_quantity ?? "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Difference</td>
              <td className="print-cell">{details.header.quantity_difference ?? "-"}</td>
              <td className="print-cell print-label">Damage Qty</td>
              <td className="print-cell">{details.header.damage_quantity ?? "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Case Count</td>
              <td className="print-cell">{details.header.case_count ?? "-"}</td>
              <td className="print-cell print-label">Pallet Count</td>
              <td className="print-cell">{details.header.pallet_count ?? "-"}</td>
            </tr>
            <tr>
              <td className="print-cell print-label">Weight (kg)</td>
              <td className="print-cell">{details.header.weight_kg ?? "-"}</td>
              <td className="print-cell print-label">Totals</td>
              <td className="print-cell">
                Items: {details.header.total_items} | Qty: {details.header.total_quantity}
              </td>
            </tr>
          </tbody>
        </table>

        <h2 className="mb-2 mt-5 text-sm font-semibold">Line Items</h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="print-cell print-head w-[8%]">#</th>
              <th className="print-cell print-head w-[16%]">Item Code</th>
              <th className="print-cell print-head w-[28%]">Item Name</th>
              <th className="print-cell print-head w-[10%]">Qty</th>
              <th className="print-cell print-head w-[38%]">Serial Numbers</th>
            </tr>
          </thead>
          <tbody>
            {details.lineItems.map((item, index) => (
              <tr key={item.id}>
                <td className="print-cell align-top">{index + 1}</td>
                <td className="print-cell align-top">{item.item_code}</td>
                <td className="print-cell align-top">{item.item_name}</td>
                <td className="print-cell align-top">{item.quantity}</td>
                <td className="print-cell align-top break-words">
                  {(item.serial_numbers || []).join(", ") || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style jsx global>{`
        .print-cell {
          border: 1px solid #d1d5db;
          padding: 6px 8px;
          vertical-align: top;
        }
        .print-label {
          width: 18%;
          font-weight: 600;
          background: #f9fafb;
        }
        .print-head {
          font-weight: 700;
          text-align: left;
          background: #f3f4f6;
        }
        @page {
          size: A4;
          margin: 12mm;
        }
        @media print {
          .no-print {
            display: none !important;
          }
          body * {
            visibility: hidden;
          }
          .grn-print-root,
          .grn-print-root * {
            visibility: visible;
          }
          .grn-print-root {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            border: 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            font-size: 11px;
            color: #111827;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
      `}</style>
    </div>
  )
}
