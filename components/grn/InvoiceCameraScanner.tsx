"use client"

import { useRef, useState } from "react"
import type { ChangeEvent } from "react"
import Image from "next/image"
import { AlertCircle, Camera, CheckCircle, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface InvoiceCameraScannerProps {
  onDataExtracted: (data: {
    invoiceNumber?: string
    invoiceDate?: string
    vendorName?: string
    vendorGST?: string
    totalAmount?: number
    taxAmount?: number
    lineItems?: Array<{ quantity?: number; amount?: number }>
  }) => void
}

export function InvoiceCameraScanner({ onDataExtracted }: InvoiceCameraScannerProps) {
  const [image, setImage] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [extractedData, setExtractedData] = useState<{
    invoiceNumber: string
    invoiceDate: string
    vendorName: string
    vendorGST: string
    totalAmount: number
    taxAmount: number
    lineItems: Array<{ quantity: number; amount: number }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleCapture = async (file: File) => {
    setError(null)
    setProgress(0)

    try {
      const reader = new FileReader()
      reader.onload = (e) => setImage((e.target?.result as string) || null)
      reader.readAsDataURL(file)

      setError("Web OCR is disabled. Use the native Android/iOS ML Kit app to scan invoices.")
      toast.info("Use mobile ML Kit scanner for OCR, then sync extracted data to backend.")
    } catch {
      setError("Failed to process image. Please try again.")
      toast.error("Failed to load image")
    } finally {
      setIsProcessing(false)
    }
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file")
      return
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error("Image size should be less than 10MB")
      return
    }

    void handleCapture(file)
  }

  const handleUseData = () => {
    if (extractedData) {
      onDataExtracted(extractedData)
    }
  }

  const handleReset = () => {
    setImage(null)
    setExtractedData(null)
    setError(null)
    setProgress(0)
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          Scan Invoice with OCR
          <span className="ml-auto text-xs font-normal text-green-600">ML Kit Mobile Only</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!image && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Button
              onClick={() => cameraInputRef.current?.click()}
              size="lg"
              className="h-32 flex-col gap-2 bg-blue-600 hover:bg-blue-700"
            >
              <Camera className="h-10 w-10" />
              <span className="text-lg">Take Photo</span>
              <span className="text-xs opacity-80">Use your camera</span>
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              size="lg"
              className="h-32 flex-col gap-2"
            >
              <Upload className="h-10 w-10" />
              <span className="text-lg">Upload Image</span>
              <span className="text-xs opacity-80">From gallery</span>
            </Button>
          </div>
        )}

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        {image && (
          <div className="space-y-4">
            <div className="relative">
              <Image
                src={image}
                alt="Invoice"
                width={1200}
                height={1600}
                className="h-auto w-full rounded-lg border shadow-sm"
                unoptimized
              />
              {!isProcessing && !extractedData && !error && (
                <div className="absolute right-2 top-2">
                  <Button onClick={handleReset} variant="secondary" size="sm">
                    Retake
                  </Button>
                </div>
              )}
            </div>

            {isProcessing && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  <span className="text-sm font-medium">Processing invoice with OCR...</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {progress < 40 && "Optimizing image..."}
                  {progress >= 40 && progress < 80 && "Extracting text..."}
                  {progress >= 80 && "Parsing invoice data..."}
                </p>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                  <div className="flex-1">
                    <p className="font-medium text-red-900">Extraction Failed</p>
                    <p className="mt-1 text-sm text-red-700">{error}</p>
                    <Button onClick={handleReset} variant="outline" size="sm" className="mt-3">
                      Try Again
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {extractedData && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <div className="mb-4 flex items-start gap-3">
                  <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
                  <div className="flex-1">
                    <p className="font-medium text-green-900">Data Extracted Successfully</p>
                    <p className="text-sm text-green-700">Review and click Use This Data</p>
                  </div>
                </div>

                <div className="space-y-3 rounded border bg-white p-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <span className="text-gray-500">Invoice Number:</span>
                      <p className="font-medium">{extractedData.invoiceNumber}</p>
                    </div>

                    <div>
                      <span className="text-gray-500">Invoice Date:</span>
                      <p className="font-medium">{extractedData.invoiceDate}</p>
                    </div>

                    <div className="col-span-2">
                      <span className="text-gray-500">Vendor Name:</span>
                      <p className="font-medium">{extractedData.vendorName}</p>
                    </div>

                    <div>
                      <span className="text-gray-500">GST Number:</span>
                      <p className="text-xs font-medium">{extractedData.vendorGST}</p>
                    </div>

                    <div>
                      <span className="text-gray-500">Total Amount:</span>
                      <p className="text-lg font-bold text-green-700">
                        {extractedData.totalAmount.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button onClick={handleUseData} className="flex-1 bg-green-600 hover:bg-green-700">
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Use This Data
                  </Button>
                  <Button onClick={handleReset} variant="outline">
                    Retry
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}



