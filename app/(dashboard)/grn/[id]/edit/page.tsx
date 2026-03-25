"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { ArrowLeft, Loader2 } from "lucide-react"

import api from "@/lib/api"
import { GRNForm } from "@/components/grn/GRNForm"
import { Button } from "@/components/ui/button"

type GrnDetailsResponse = {
  data: {
    header: {
      id: number
      status: string
      client_id: number
      warehouse_id: number
      invoice_number: string
      invoice_date: string
      supplier_name?: string
      supplier_gst?: string
      gate_in_number?: string
      model_number?: string
      material_description?: string
      receipt_date?: string
      manufacturing_date?: string
      basic_price?: number
      invoice_quantity?: number
      received_quantity?: number
      damage_quantity?: number
      case_count?: number
      pallet_count?: number
      weight_kg?: number
      handling_type?: "MACHINE" | "MANUAL"
    }
    lineItems: Array<{
      item_id: number
      zone_layout_id?: number
      quantity: number
      mrp?: number
      serial_numbers?: string[]
    }>
  }
}

export default function EditDraftGRNPage() {
  const params = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [initialData, setInitialData] = useState<{
    client_id?: number
    warehouse_id?: number
    invoiceNumber?: string
    invoiceDate?: string
    vendorName?: string
    vendorGST?: string
    gate_in_number?: string
    model_number?: string
    material_description?: string
    receipt_date?: string
    manufacturing_date?: string
    basic_price?: number
    invoice_quantity?: number
    received_quantity?: number
    damage_quantity?: number
    case_count?: number
    pallet_count?: number
    weight_kg?: number
    handling_type?: "MACHINE" | "MANUAL"
    lineItems?: Array<{
      item_id?: number
      zone_layout_id?: number
      quantity?: number
      rate?: number
      serial_numbers?: string[]
    }>
  } | null>(null)

  useEffect(() => {
    const fetchDraft = async () => {
      try {
        setLoading(true)
        const response = (await api.get(`/grn/${params.id}`)) as GrnDetailsResponse
        const { header, lineItems } = response.data
        if (header.status !== "DRAFT") {
          setError("Only draft GRN can be edited from this screen.")
          return
        }
        setInitialData({
          client_id: header.client_id,
          warehouse_id: header.warehouse_id,
          invoiceNumber: header.invoice_number,
          invoiceDate: header.invoice_date,
          vendorName: header.supplier_name || "",
          vendorGST: header.supplier_gst || "",
          gate_in_number: header.gate_in_number,
          model_number: header.model_number,
          material_description: header.material_description,
          receipt_date: header.receipt_date,
          manufacturing_date: header.manufacturing_date,
          basic_price: header.basic_price,
          invoice_quantity: header.invoice_quantity,
          received_quantity: header.received_quantity,
          damage_quantity: header.damage_quantity,
          case_count: header.case_count,
          pallet_count: header.pallet_count,
          weight_kg: header.weight_kg,
          handling_type: header.handling_type,
          lineItems: lineItems.map((line) => ({
            item_id: line.item_id,
            zone_layout_id: line.zone_layout_id,
            quantity: line.quantity,
            rate: line.mrp ?? 0,
            serial_numbers: line.serial_numbers || [],
          })),
        })
        setError("")
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load draft GRN")
      } finally {
        setLoading(false)
      }
    }

    if (params.id) void fetchDraft()
  }, [params.id])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !initialData) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-600">{error || "Unable to load draft."}</p>
        <Button asChild variant="outline">
          <Link href="/grn">Back to GRN List</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/grn">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold">Edit Draft GRN</h1>
          <p className="text-gray-500">Update draft details or confirm the GRN</p>
        </div>
      </div>

      <GRNForm draftId={Number(params.id)} initialData={initialData} />
    </div>
  )
}
