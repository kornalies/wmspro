import { NextRequest, NextResponse } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

type RouteContext = {
  params: Promise<{ id: string }>
}

type PrintProfile = "dispatch_note" | "packing_slip"

function escapePdfText(input: string) {
  return input.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

function fmtDate(value: unknown) {
  if (!value) return "-"
  return String(value).slice(0, 10)
}

function statusColor(status: string): [number, number, number] {
  const normalized = String(status || "").toUpperCase()
  if (normalized === "COMPLETED") return [0.12, 0.62, 0.35]
  if (normalized === "PARTIALLY_FULFILLED") return [0.9, 0.58, 0.11]
  if (normalized === "STAGED") return [0.48, 0.27, 0.76]
  if (normalized === "PICKED") return [0.3, 0.36, 0.82]
  if (normalized === "CANCELLED") return [0.84, 0.2, 0.29]
  return [0.09, 0.42, 0.72]
}

function drawRect(x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]} rg ${x} ${y} ${w} ${h} re f`
}

function drawStrokeRect(x: number, y: number, w: number, h: number, rgb: [number, number, number], lineWidth = 1) {
  return `${lineWidth} w ${rgb[0]} ${rgb[1]} ${rgb[2]} RG ${x} ${y} ${w} ${h} re S`
}

function drawText(
  x: number,
  y: number,
  text: string,
  size = 11,
  rgb: [number, number, number] = [0, 0, 0],
  bold = false
) {
  const font = bold ? "F2" : "F1"
  return `BT /${font} ${size} Tf ${rgb[0]} ${rgb[1]} ${rgb[2]} rg 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET`
}

function parseHexColor(value: unknown, fallback: [number, number, number]): [number, number, number] {
  const hex = String(value || "").trim()
  if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) return fallback
  const clean = hex.startsWith("#") ? hex.slice(1) : hex
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  return [r, g, b]
}

function normalizeProfile(value: unknown): PrintProfile | null {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "dispatch_note" || normalized === "dispatch") return "dispatch_note"
  if (normalized === "packing_slip" || normalized === "packing") return "packing_slip"
  return null
}

function safeTruncate(value: unknown, max = 48) {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

const CODE39_PATTERNS: Record<string, string> = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  $: "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
}

function sanitizeCode39(value: string) {
  const upper = String(value || "").toUpperCase()
  const chars = upper.split("").filter((ch) => !!CODE39_PATTERNS[ch])
  return chars.join("") || "DO"
}

function drawCode39Barcode(
  x: number,
  y: number,
  value: string,
  options?: {
    barHeight?: number
    narrow?: number
    wide?: number
    charGap?: number
    color?: [number, number, number]
  }
) {
  const barHeight = options?.barHeight ?? 34
  const narrow = options?.narrow ?? 1.2
  const wide = options?.wide ?? 2.8
  const charGap = options?.charGap ?? 1.2
  const color = options?.color ?? [0.04, 0.12, 0.19]
  const payload = `*${sanitizeCode39(value)}*`
  const ops: string[] = []
  let cursor = x
  for (let c = 0; c < payload.length; c++) {
    const pattern = CODE39_PATTERNS[payload[c]]
    if (!pattern) continue
    for (let i = 0; i < pattern.length; i++) {
      const width = pattern[i] === "w" ? wide : narrow
      const isBar = i % 2 === 0
      if (isBar) {
        ops.push(drawRect(cursor, y, width, barHeight, color))
      }
      cursor += width
    }
    cursor += charGap
  }
  return { ops, width: cursor - x, payload }
}

function drawReferenceMatrix(x: number, y: number, size: number, seed: string) {
  const modules = 21
  const cellSize = size / modules
  const ops: string[] = []
  const hash = Array.from(seed).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0x1f2e3d4c)
  ops.push(drawStrokeRect(x, y, size, size, [0.15, 0.22, 0.3], 0.8))
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      const bit = (((hash + r * 131 + c * 197) ^ (r * c * 17)) & 1) === 1
      const inFinder =
        (r < 7 && c < 7) ||
        (r < 7 && c >= modules - 7) ||
        (r >= modules - 7 && c < 7)
      let fill = bit
      if (inFinder) {
        const fr = r % 7
        const fc = c % 7
        fill = fr === 0 || fr === 6 || fc === 0 || fc === 6 || (fr >= 2 && fr <= 4 && fc >= 2 && fc <= 4)
      }
      if (fill) {
        ops.push(drawRect(x + c * cellSize, y + (modules - 1 - r) * cellSize, cellSize, cellSize, [0.08, 0.14, 0.2]))
      }
    }
  }
  return ops
}

function buildDoPdf(payload: {
  companyName: string
  companyCode: string
  profile: PrintProfile
  logoUrl: string
  brandColor: [number, number, number]
  doNumber: string
  requestDate: string
  dispatchDate: string
  status: string
  clientCode: string
  clientName: string
  warehouseName: string
  supplierName: string
  invoiceNo: string
  lineItems: Array<{
    line_number: number
    item_code: string
    item_name: string
    quantity_requested: number
    quantity_dispatched: number
    uom: string
  }>
}): Uint8Array {
  const ops: string[] = []

  const pageW = 595
  const pageH = 842
  const statusRgb = statusColor(payload.status)
  const safeStatus = String(payload.status || "UNKNOWN").toUpperCase()
  const isPackingSlip = payload.profile === "packing_slip"
  const title = isPackingSlip ? "Packing Slip" : "Dispatch Note"
  const accent = isPackingSlip ? ([0.86, 0.42, 0.12] as [number, number, number]) : ([0.12, 0.42, 0.72] as [number, number, number])

  ops.push(drawRect(0, 778, pageW, 64, payload.brandColor))
  ops.push(drawText(36, 814, safeTruncate(payload.companyName || "GWU WMS", 42), 10, [0.86, 0.93, 1], true))
  ops.push(drawText(36, 792, `${title} - Delivery Order`, 22, [1, 1, 1], true))
  ops.push(drawStrokeRect(420, 782, 140, 46, [1, 1, 1], 0.8))
  ops.push(drawText(428, 812, `Tenant: ${safeTruncate(payload.companyCode || "-", 20)}`, 8, [1, 1, 1], true))
  ops.push(drawText(428, 800, payload.logoUrl ? `Logo: ${safeTruncate(payload.logoUrl, 24)}` : "Logo: Not configured", 7, [1, 1, 1]))
  ops.push(drawRect(420, 790, 140, 30, isPackingSlip ? accent : statusRgb))
  ops.push(drawText(438, 801, isPackingSlip ? "PACKING SLIP" : safeStatus.replaceAll("_", " "), 11, [1, 1, 1], true))

  ops.push(drawRect(36, 650, 255, 112, [0.93, 0.97, 1]))
  ops.push(drawRect(304, 650, 255, 112, [0.94, 0.99, 0.95]))
  ops.push(drawStrokeRect(36, 650, 255, 112, [0.78, 0.87, 0.98], 0.8))
  ops.push(drawStrokeRect(304, 650, 255, 112, [0.74, 0.9, 0.78], 0.8))

  ops.push(drawText(48, 742, "Document Details", 11, [0.06, 0.25, 0.49], true))
  ops.push(drawText(48, 722, `DO Number: ${payload.doNumber}`, 11))
  ops.push(drawText(48, 704, `Request Date: ${payload.requestDate}`, 11))
  ops.push(drawText(48, 686, `Dispatch Date: ${payload.dispatchDate}`, 11))
  if (!isPackingSlip) {
    ops.push(drawText(48, 668, `Invoice No: ${payload.invoiceNo || "-"}`, 11))
  } else {
    ops.push(drawText(48, 668, `Document Type: Packing Slip`, 11))
  }

  ops.push(drawText(316, 742, "Customer & Warehouse", 11, [0.11, 0.42, 0.2], true))
  const rightBlockY = 722
  const rightLineGap = 17
  const clientNameText = safeTruncate(payload.clientName || "-", 30)
  const clientCodeText = safeTruncate(payload.clientCode || "-", 24)
  const warehouseText = safeTruncate(payload.warehouseName || "-", 28)
  const supplierText = safeTruncate(payload.supplierName || "-", 28)
  ops.push(drawText(316, rightBlockY, `Client: ${clientNameText}`, 10.5))
  ops.push(drawText(316, rightBlockY - rightLineGap, `Client Code: ${clientCodeText}`, 10.5))
  ops.push(drawText(316, rightBlockY - rightLineGap * 2, `Warehouse: ${warehouseText}`, 10.5))
  if (!isPackingSlip) {
    ops.push(drawText(316, rightBlockY - rightLineGap * 3, `Supplier: ${supplierText}`, 10.5))
  }
  ops.push(
    drawText(
      316,
      rightBlockY - rightLineGap * 4,
      isPackingSlip ? "Shipment: Packed Items" : `Status: ${safeStatus.replaceAll("_", " ")}`,
      10.5
    )
  )

  const barcode = drawCode39Barcode(36, 614, payload.doNumber, {
    barHeight: 28,
    color: [0.07, 0.15, 0.23],
  })
  ops.push(...barcode.ops)
  ops.push(drawText(36, 604, `*${barcode.payload.replace(/\*/g, "")}*`, 9, [0.11, 0.19, 0.3], true))
  ops.push(drawText(36, 592, "Barcode: Code39", 8, [0.32, 0.36, 0.41]))
  ops.push(...drawReferenceMatrix(506, 588, 53, `${payload.doNumber}|${payload.clientCode}|${payload.companyCode}`))
  ops.push(drawText(503, 578, "QR Ref", 8, [0.27, 0.3, 0.33], true))

  ops.push(drawRect(36, 548, 523, 28, accent))
  ops.push(drawText(48, 558, isPackingSlip ? "Package Contents" : "Line Items", 12, [1, 1, 1], true))

  const tableX = 36
  const tableTop = 520
  const rowH = 22
  const colX =
    isPackingSlip ? [40, 80, 170, 440, 512] : [40, 80, 170, 382, 452, 525]
  const colTitles =
    isPackingSlip
      ? ["#", "Item Code", "Item Name", "Qty", "UOM"]
      : ["#", "Item Code", "Item Name", "Req", "Disp", "UOM"]

  ops.push(drawRect(tableX, tableTop, 523, rowH, [0.2, 0.52, 0.83]))
  for (let i = 0; i < colTitles.length; i++) {
    ops.push(drawText(colX[i], tableTop + 7, colTitles[i], 10, [1, 1, 1], true))
  }

  const visibleRows = payload.lineItems.slice(0, 16)
  let totalReq = 0
  let totalDisp = 0

  visibleRows.forEach((item, idx) => {
    const y = tableTop - rowH * (idx + 1)
    const even = idx % 2 === 0
    ops.push(drawRect(tableX, y, 523, rowH, even ? [0.97, 0.98, 1] : [0.92, 0.96, 1]))
    ops.push(drawStrokeRect(tableX, y, 523, rowH, [0.8, 0.88, 0.97], 0.3))

    const itemName = String(item.item_name || "").slice(0, 40)
    const itemCode = String(item.item_code || "").slice(0, 18)
    const req = Number(item.quantity_requested || 0)
    const disp = Number(item.quantity_dispatched || 0)
    totalReq += req
    totalDisp += disp

    ops.push(drawText(colX[0], y + 7, String(item.line_number || idx + 1), 10))
    ops.push(drawText(colX[1], y + 7, itemCode || "-", 10))
    ops.push(drawText(colX[2], y + 7, itemName || "-", 10))
    if (isPackingSlip) {
      ops.push(drawText(colX[3], y + 7, String(disp || req), 10, [0.05, 0.4, 0.17], true))
      ops.push(drawText(colX[4], y + 7, String(item.uom || "-").slice(0, 8), 10))
    } else {
      ops.push(drawText(colX[3], y + 7, String(req), 10, [0, 0, 0], true))
      ops.push(drawText(colX[4], y + 7, String(disp), 10, [0.05, 0.4, 0.17], true))
      ops.push(drawText(colX[5], y + 7, String(item.uom || "-").slice(0, 8), 10))
    }
  })

  const tableBottomY = tableTop - rowH * (visibleRows.length + 1)
  ops.push(drawRect(36, tableBottomY - 48, 523, 38, isPackingSlip ? [0.72, 0.32, 0.08] : [0.1, 0.31, 0.54]))
  if (isPackingSlip) {
    ops.push(drawText(48, tableBottomY - 33, `Total Packed Qty: ${totalDisp || totalReq}`, 11, [1, 1, 1], true))
    ops.push(drawText(312, tableBottomY - 33, `SKU Lines: ${payload.lineItems.length}`, 11, [1, 1, 1], true))
  } else {
    ops.push(drawText(48, tableBottomY - 33, `Total Requested: ${totalReq}`, 11, [1, 1, 1], true))
    ops.push(drawText(250, tableBottomY - 33, `Total Dispatched: ${totalDisp}`, 11, [1, 1, 1], true))
    ops.push(drawText(458, tableBottomY - 33, `Lines: ${payload.lineItems.length}`, 11, [1, 1, 1], true))
  }

  if (payload.lineItems.length > visibleRows.length) {
    ops.push(drawText(36, tableBottomY - 66, `Note: ${payload.lineItems.length - visibleRows.length} more line(s) omitted in print preview`, 10, [0.75, 0.2, 0.2], true))
  }

  ops.push(
    drawText(
      36,
      36,
      isPackingSlip
        ? `Packing Slip generated by ${payload.companyName || "GWU WMS"}`
        : `Dispatch Note generated by ${payload.companyName || "GWU WMS"}`,
      9,
      [0.42, 0.45, 0.49]
    )
  )
  ops.push(drawText(404, 36, `Printed: ${fmtDate(new Date().toISOString())}`, 9, [0.42, 0.45, 0.49]))
  ops.push(drawStrokeRect(30, 30, pageW - 60, pageH - 60, [0.84, 0.87, 0.91], 0.5))

  const stream = ops.join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]

  let pdf = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return new TextEncoder().encode(pdf)
}

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      },
      { status: 401 }
    )
  }

  const { id } = await context.params
  const { searchParams } = new URL(request.url)
  const explicitProfile = normalizeProfile(searchParams.get("profile"))
  const rawRef = decodeURIComponent(id).trim()
  const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
  const doNumber = numericId ? null : rawRef
  const result = await query(
    `SELECT
       dh.id,
       dh.do_number,
       dh.request_date,
       dh.dispatch_date,
       dh.status,
       dh.supplier_name,
       dh.invoice_no,
       c.client_code,
       c.client_name,
       w.warehouse_name,
       co.company_code,
       co.company_name,
       ts.ui_branding
     FROM do_header dh
      JOIN clients c ON c.id = dh.client_id AND c.company_id = dh.company_id
      JOIN warehouses w ON w.id = dh.warehouse_id AND w.company_id = dh.company_id
      LEFT JOIN companies co ON co.id = dh.company_id
      LEFT JOIN tenant_settings ts ON ts.company_id = dh.company_id
     WHERE dh.company_id = $1
       AND (
         ($2::int IS NOT NULL AND dh.id = $2)
         OR ($3::text IS NOT NULL AND dh.do_number ILIKE $3)
       )
     LIMIT 1`,
    [session.companyId, numericId, doNumber]
  )

  if (!result.rows.length) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "NOT_FOUND", message: "Delivery Order not found" },
      },
      { status: 404 }
    )
  }

  const row = result.rows[0]
  const brandingRaw =
    typeof row.ui_branding === "string"
      ? (() => {
          try {
            return JSON.parse(row.ui_branding)
          } catch {
            return {}
          }
        })()
      : (row.ui_branding as Record<string, unknown> | null) || {}
  const logoUrl = String((brandingRaw as { logoUrl?: unknown }).logoUrl || "")
  const brandColor = parseHexColor((brandingRaw as { primaryColor?: unknown }).primaryColor, [0.06, 0.25, 0.49])
  const tenantDefaultProfile = normalizeProfile((brandingRaw as { doPrintProfile?: unknown }).doPrintProfile)
  const clientProfiles = ((brandingRaw as { doPrintProfilesByClient?: unknown }).doPrintProfilesByClient ||
    {}) as Record<string, unknown>
  const clientCode = String(row.client_code || "").toUpperCase()
  const clientProfile = normalizeProfile(clientProfiles[clientCode])
  const profile: PrintProfile = explicitProfile || clientProfile || tenantDefaultProfile || "dispatch_note"

  const linesResult = await query(
    `SELECT
       dli.line_number,
       i.item_code,
       i.item_name,
       dli.quantity_requested,
       dli.quantity_dispatched,
       dli.uom
     FROM do_line_items dli
     JOIN items i ON i.id = dli.item_id AND i.company_id = dli.company_id
     WHERE dli.company_id = $1
       AND dli.do_header_id = $2
     ORDER BY dli.line_number ASC`,
    [session.companyId, Number(row.id)]
  )

  const pdfBytes = buildDoPdf({
    companyName: String(row.company_name || "GWU WMS"),
    companyCode: String(row.company_code || ""),
    profile,
    logoUrl,
    brandColor,
    doNumber: String(row.do_number || rawRef),
    requestDate: fmtDate(row.request_date),
    dispatchDate: fmtDate(row.dispatch_date),
    status: String(row.status || "UNKNOWN"),
    clientCode,
    clientName: String(row.client_name || "-"),
    warehouseName: String(row.warehouse_name || "-"),
    supplierName: String(row.supplier_name || ""),
    invoiceNo: String(row.invoice_no || ""),
    lineItems: (linesResult.rows as Array<{
      line_number: number
      item_code: string
      item_name: string
      quantity_requested: number
      quantity_dispatched: number
      uom: string
    }>),
  })
  const pdfBody = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength
  ) as ArrayBuffer

  return new NextResponse(pdfBody, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${row.do_number || "delivery-order"}-${profile}.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
