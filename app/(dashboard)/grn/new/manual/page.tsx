"use client"

import Link from "next/link"
import { ArrowLeft, FileText } from "lucide-react"

import { GRNForm } from "@/components/grn/GRNForm"
import { Button } from "@/components/ui/button"

export default function ManualGRNPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/grn">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Create GRN (Manual Entry)</h1>
            <p className="text-gray-500">Enter invoice and line item details manually</p>
          </div>
        </div>

        <Button asChild variant="outline">
          <Link href="/grn/new">
            <FileText className="mr-2 h-4 w-4" />
            Switch to Scanner
          </Link>
        </Button>
      </div>

      <GRNForm initialData={null} />
    </div>
  )
}
