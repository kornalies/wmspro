import { NextRequest, NextResponse } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { assertInvoiceOperationalValueCompliance } from "@/lib/billing-service"

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const invoiceNumber = String(body?.invoice_number || "").trim()

    if (!invoiceNumber) {
      return NextResponse.json({ error: "Invoice number is required" }, { status: 400 })
    }

    const invoiceResult = await query(
      `SELECT id
       FROM invoice_header
       WHERE company_id = $1
         AND invoice_number = $2
       LIMIT 1`,
      [session.companyId, invoiceNumber]
    )
    if (invoiceResult.rows.length > 0) {
      await assertInvoiceOperationalValueCompliance(
        { query },
        {
          companyId: session.companyId,
          invoiceId: Number(invoiceResult.rows[0].id),
        }
      )
    }

    // Placeholder email gateway hook: keep endpoint contract stable for real provider integration.
    return NextResponse.json({
      success: true,
      message: `Invoice ${invoiceNumber} email queued`,
    })
  } catch (error: unknown) {
    console.error("Invoice email send error:", error)
    const message = error instanceof Error ? error.message : "Failed to queue invoice email"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
