"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowLeft, Camera, FileText } from "lucide-react"

import { GRNForm } from "@/components/grn/GRNForm"
import { InvoiceCameraScanner } from "@/components/grn/InvoiceCameraScanner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type OcrData = {
  client_id?: number
  warehouse_id?: number
  invoiceNumber?: string
  invoiceDate?: string
  vendorName?: string
  vendorGST?: string
  totalAmount?: number
  taxAmount?: number
  lineItems?: Array<{ quantity?: number; amount?: number }>
} | null

export default function NewGRNPage() {
  const [mode, setMode] = useState<"choice" | "scan" | "manual">("choice")
  const [ocrData, setOcrData] = useState<OcrData>(null)

  const handleDataExtracted = (data: OcrData) => {
    setOcrData(data)
    setMode("manual")
  }

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
          <h1 className="text-3xl font-bold">Create New GRN</h1>
          <p className="mt-1 text-gray-500">
            {mode === "choice" && "Choose your preferred method"}
            {mode === "scan" && "Scan invoice to auto-fill"}
            {mode === "manual" && "Fill in GRN details"}
          </p>
        </div>
      </div>

      {mode === "choice" && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card
            className="cursor-pointer border-2 border-blue-200 bg-blue-50 transition-all hover:shadow-lg"
            onClick={() => setMode("scan")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-blue-700">
                <Camera className="h-6 w-6" />
                Scan Invoice (OCR)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-gray-600">
                Use your camera to scan and auto-fill invoice details
              </p>
              <div className="space-y-2 text-sm text-gray-500">
                <div className="flex items-center gap-2">Auto-extract invoice number</div>
                <div className="flex items-center gap-2">Auto-extract vendor details</div>
                <div className="flex items-center gap-2">Works offline, no internet needed</div>
                <div className="flex items-center gap-2">No API costs</div>
              </div>
              <Button className="mt-6 w-full bg-blue-600 hover:bg-blue-700">
                <Camera className="mr-2 h-4 w-4" />
                Start Scanning
              </Button>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer border-2 border-gray-200 transition-all hover:shadow-lg"
            onClick={() => setMode("manual")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <FileText className="h-6 w-6" />
                Manual Entry
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-gray-600">Enter GRN details manually using the form</p>
              <div className="space-y-2 text-sm text-gray-500">
                <div className="flex items-center gap-2">Complete form control</div>
                <div className="flex items-center gap-2">Line item management</div>
                <div className="flex items-center gap-2">Auto serial number generation</div>
                <div className="flex items-center gap-2">Real-time validation</div>
              </div>
              <Button variant="outline" className="mt-6 w-full">
                <FileText className="mr-2 h-4 w-4" />
                Manual Entry
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {mode === "scan" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode("choice")}>
              Back to Options
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/grn/mobile-approvals">Open Mobile GRN Approvals</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode("manual")}>
              Skip to Manual Entry
            </Button>
          </div>
          <InvoiceCameraScanner onDataExtracted={handleDataExtracted} />
        </div>
      )}

      {mode === "manual" && (
        <div className="space-y-4">
          {!ocrData && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setMode("choice")}>
                Back to Options
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMode("scan")}
                className="text-blue-600"
              >
                <Camera className="mr-2 h-4 w-4" />
                Use OCR Scanner Instead
              </Button>
            </div>
          )}

          {ocrData && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm text-green-800">
                Data extracted from invoice. Review and modify as needed below.
              </p>
            </div>
          )}

          <GRNForm initialData={ocrData} />
        </div>
      )}
    </div>
  )
}
