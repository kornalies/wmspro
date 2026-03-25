/* eslint-disable @typescript-eslint/no-explicit-any */
// PDF and Excel Export Utilities for WMS Pro
// Install: npm install jspdf jspdf-autotable xlsx

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'

// ============================================================================
// PDF EXPORTS
// ============================================================================

/**
 * Export GRN to PDF
 */
export const exportGRNtoPDF = (grn: any) => {
    const doc = new jsPDF()
    const field = (value: unknown) => (value === null || value === undefined || value === "" ? "-" : String(value))

    // Header
    doc.setFontSize(20)
    doc.text('Goods Receipt Note', 14, 20)

    doc.setFontSize(10)
    const headerRows = [
        [`GRN Number: ${field(grn.grn_number)}`, `GRN Date: ${field(grn.grn_date)}`],
        [`Invoice Number: ${field(grn.invoice_number)}`, `Invoice Date: ${field(grn.invoice_date)}`],
        [`Client: ${field(grn.client_name)}`, `Warehouse: ${field(grn.warehouse_name)}`],
        [`Supplier: ${field(grn.supplier_name)}`, `Gate In Number: ${field(grn.gate_in_number)}`],
        [`Model Number: ${field(grn.model_number)}`, `Handling Type: ${field(grn.handling_type)}`],
        [`Material Description: ${field(grn.material_description)}`, `Receipt Date: ${field(grn.receipt_date)}`],
        [`Mfg Date: ${field(grn.manufacturing_date)}`, `Basic Price: ${field(grn.basic_price)}`],
        [`Invoice Qty: ${field(grn.invoice_quantity)}`, `Received Qty: ${field(grn.received_quantity)}`],
        [`Difference: ${field(grn.quantity_difference)}`, `Damage Qty: ${field(grn.damage_quantity)}`],
        [`Case Count: ${field(grn.case_count)}`, `Pallet Count: ${field(grn.pallet_count)}`],
        [`Weight (kg): ${field(grn.weight_kg)}`, `Total Items: ${field(grn.total_items)} | Total Qty: ${field(grn.total_quantity)}`],
    ]
    let y = 30
    for (const [left, right] of headerRows) {
        doc.text(left, 14, y)
        doc.text(right, 110, y)
        y += 6
    }

    // Items table
    autoTable(doc, {
        startY: y + 4,
        head: [['Item Code', 'Item Name', 'Quantity', 'Unit', 'Bin Location', 'Serials']],
        body: grn.items.map((item: any) => [
            item.item_code,
            item.item_name,
            item.quantity ?? item.quantity_received ?? item.qty ?? 0,
            item.unit ?? item.uom ?? 'PCS',
            item.bin_location || 'N/A',
            Array.isArray(item.serial_numbers) ? item.serial_numbers.join(', ') : (item.serial_numbers || '-')
        ]),
        theme: 'grid',
        headStyles: { fillColor: [59, 130, 246] },
        styles: { fontSize: 8 }
    })

    // Footer
    const finalY = (doc as any).lastAutoTable?.finalY || (y + 4)
    doc.setFontSize(9)
    doc.text(`Generated on ${new Date().toLocaleString()}`, 14, finalY + 10)

    doc.save(`GRN-${grn.grn_number}.pdf`)
}

/**
 * Export Delivery Order to PDF
 */
export const exportDOtoPDF = (deliveryOrder: any) => {
    const doc = new jsPDF()
    const field = (value: unknown) => (value === null || value === undefined || value === "" ? "-" : String(value))
    const requestedQty = Number(deliveryOrder.total_quantity_requested || 0)
    const dispatchedQty = Number(deliveryOrder.total_quantity_dispatched || 0)
    const fulfillment =
        deliveryOrder.fulfillment_percentage !== undefined && deliveryOrder.fulfillment_percentage !== null
            ? Number(deliveryOrder.fulfillment_percentage)
            : requestedQty > 0
                ? Math.min(100, Math.round((dispatchedQty / requestedQty) * 100))
                : 0

    // Header
    doc.setFontSize(20)
    doc.text('Delivery Order', 14, 20)

    doc.setFontSize(10)
    const headerRows = [
        [`DO Number: ${field(deliveryOrder.do_number)}`, `Request Date: ${field(deliveryOrder.request_date)}`],
        [`Client: ${field(deliveryOrder.client_name)}`, `Warehouse: ${field(deliveryOrder.warehouse_name)}`],
        [`Status: ${field(deliveryOrder.status)}`, `Dispatch Date: ${field(deliveryOrder.dispatch_date)}`],
        [`Supplier: ${field(deliveryOrder.supplier_name)}`, `Invoice No: ${field(deliveryOrder.invoice_no)}`],
        [`Invoice Date: ${field(deliveryOrder.invoice_date)}`, `Model No: ${field(deliveryOrder.model_no)}`],
        [`Serial No: ${field(deliveryOrder.serial_no)}`, `Material: ${field(deliveryOrder.material_description)}`],
        [`Mfg Date: ${field(deliveryOrder.date_of_manufacturing)}`, `Basic Price: ${field(deliveryOrder.basic_price)}`],
        [`Invoice Qty: ${field(deliveryOrder.invoice_qty)}`, `Dispatched Qty: ${field(deliveryOrder.dispatched_qty)}`],
        [`Difference: ${field(deliveryOrder.quantity_difference)}`, `Handling Type: ${field(deliveryOrder.handling_type)}`],
        [`Cases: ${field(deliveryOrder.no_of_cases)}`, `Pallets: ${field(deliveryOrder.no_of_pallets)}`],
        [`Weight (kg): ${field(deliveryOrder.weight_kg)}`, `Machine Type: ${field(deliveryOrder.machine_type)}`],
        [`Machine From: ${field(deliveryOrder.machine_from_time)}`, `Machine To: ${field(deliveryOrder.machine_to_time)}`],
        [`Outward Remarks: ${field(deliveryOrder.outward_remarks)}`, ""],
    ]

    let y = 30
    for (const [left, right] of headerRows) {
        doc.text(left, 14, y)
        if (right) doc.text(right, 110, y)
        y += 6
    }

    // Items table
    autoTable(doc, {
        startY: y + 2,
        head: [['Item Code', 'Item Name', 'Requested', 'Dispatched', 'Remaining', 'Unit']],
        body: (deliveryOrder.items || []).map((item: any) => [
            item.item_code,
            item.item_name,
            item.quantity_requested,
            item.quantity_dispatched || 0,
            item.quantity_remaining || item.quantity_requested,
            item.unit
        ]),
        theme: 'grid',
        headStyles: { fillColor: [59, 130, 246] }
    })

    const finalY = (doc as any).lastAutoTable?.finalY || y + 2

    // Summary
    doc.setFontSize(11)
    doc.text('Summary:', 14, finalY + 10)
    doc.setFontSize(9)
    doc.text(`Total Items: ${(deliveryOrder.items || []).length}`, 14, finalY + 16)
    doc.text(`Fulfillment: ${fulfillment}%`, 14, finalY + 22)

    doc.save(`DO-${deliveryOrder.do_number}.pdf`)
}

/**
 * Export Stock Report to PDF
 */
export const exportStockReportPDF = (stockData: Array<any>) => {
    const doc = new jsPDF('landscape')

    doc.setFontSize(20)
    doc.text('Stock Report', 14, 20)

    doc.setFontSize(10)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
    doc.text(`Total Records: ${stockData.length}`, 14, 34)

    autoTable(doc, {
        startY: 40,
        head: [['Item Code', 'Item Name', 'Client', 'Warehouse', 'Bin', 'Quantity', 'Unit']],
        body: stockData.map((stock: any) => [
            stock.item_code,
            stock.item_name,
            stock.client_name,
            stock.warehouse_name,
            stock.bin_location,
            stock.quantity,
            stock.unit
        ]),
        theme: 'grid',
        headStyles: { fillColor: [59, 130, 246] },
        styles: { fontSize: 8 }
    })

    doc.save(`Stock-Report-${new Date().toISOString().split('T')[0]}.pdf`)
}

/**
 * Export Invoice to PDF
 */
export const exportInvoicePDF = (invoice: any) => {
    const doc = new jsPDF()
    const pageWidth = doc.internal.pageSize.getWidth()
    const text = (value: unknown, fallback = '-') => {
        if (value === null || value === undefined) return fallback
        const t = String(value).trim()
        return t.length > 0 ? t : fallback
    }
    const amount = (value: unknown) => {
        const n = Number(value || 0)
        return `INR ${Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`
    }

    const taxable = Number(invoice.taxable_amount ?? invoice.total_amount ?? 0)
    const cgst = Number(invoice.cgst_amount ?? 0)
    const sgst = Number(invoice.sgst_amount ?? 0)
    const igst = Number(invoice.igst_amount ?? 0)
    const totalTax = Number(invoice.total_tax_amount ?? (cgst + sgst + igst))
    const grandTotal = Number(invoice.grand_total ?? (taxable + totalTax))
    const gstRate = Number(invoice.gst_rate ?? 18)
    const supplyType = text(invoice.supply_type, cgst + sgst > 0 ? 'INTRA_STATE' : 'INTER_STATE')

    doc.setFillColor(23, 80, 173)
    doc.rect(0, 0, pageWidth, 28, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(18)
    doc.text('TAX INVOICE', 14, 18)
    doc.setFontSize(10)
    doc.text(text(invoice.supplier_name, 'WMS Pro'), pageWidth - 14, 12, { align: 'right' })
    doc.text('Warehouse Management Solutions', pageWidth - 14, 18, { align: 'right' })
    doc.text('Chennai, Tamil Nadu', pageWidth - 14, 24, { align: 'right' })
    doc.setTextColor(0, 0, 0)

    doc.setDrawColor(220, 220, 220)
    doc.rect(14, 34, 90, 42)
    doc.rect(106, 34, 90, 42)
    doc.setFontSize(10)
    doc.setFont('helvetica', 'bold')
    doc.text('Supplier Details', 17, 40)
    doc.setFont('helvetica', 'normal')
    doc.text(text(invoice.supplier_name, 'WMS Pro'), 17, 46)
    doc.text(`GSTIN: ${text(invoice.supplier_gstin)}`, 17, 52)
    doc.text(
        `State: ${text(invoice.supplier_state, 'Tamil Nadu')}${text(invoice.supplier_state_code) !== '-' ? ` (${text(invoice.supplier_state_code)})` : ''}`,
        17,
        58
    )
    doc.text(`PAN: ${text(invoice.supplier_pan)}`, 17, 64)
    const supplierAddress = text(invoice.supplier_address, '')
    if (supplierAddress) {
        doc.setFontSize(8)
        doc.text(`Addr: ${supplierAddress}`.slice(0, 54), 17, 69)
        doc.setFontSize(10)
    }

    doc.setFont('helvetica', 'bold')
    doc.text('Bill To', 109, 40)
    doc.setFont('helvetica', 'normal')
    doc.text(text(invoice.client_name), 109, 46)
    doc.text(`GSTIN: ${text(invoice.client_gstin)}`, 109, 52)
    doc.text(`Place of Supply: ${text(invoice.place_of_supply)}`, 109, 58)
    doc.text(`Supply Type: ${supplyType}`, 109, 64)

    doc.rect(14, 80, 182, 24)
    doc.setFont('helvetica', 'bold')
    doc.text('Invoice Metadata', 17, 86)
    doc.setFont('helvetica', 'normal')
    doc.text(`Invoice No: ${text(invoice.invoice_number)}`, 17, 92)
    doc.text(`Invoice Date: ${text(invoice.invoice_date)}`, 17, 98)
    doc.text(`Due Date: ${text(invoice.due_date)}`, 74, 92)
    doc.text(`Billing Period: ${text(invoice.billing_period)}`, 74, 98)
    doc.text(`Status: ${text(invoice.status)}`, 149, 92)
    doc.text('Payment Terms: As per contract', 149, 98)

    autoTable(doc, {
        startY: 110,
        head: [['#', 'Description', 'HSN/SAC', 'Qty', 'UOM', 'Rate', 'Taxable Amount']],
        body: (invoice.items || []).map((item: any, index: number) => [
            index + 1,
            text(item.description),
            '-',
            Number(item.quantity || 0),
            text(item.uom || item.unit || 'UNIT'),
            amount(item.rate || 0),
            amount(item.amount || 0),
        ]),
        theme: 'grid',
        headStyles: { fillColor: [37, 99, 235], textColor: [255, 255, 255] },
        styles: { fontSize: 9, cellPadding: 2.2 },
        columnStyles: {
            0: { halign: 'center', cellWidth: 10 },
            2: { halign: 'center', cellWidth: 22 },
            3: { halign: 'right', cellWidth: 16 },
            4: { halign: 'center', cellWidth: 16 },
            5: { halign: 'right', cellWidth: 30 },
            6: { halign: 'right', cellWidth: 34 },
        },
    })

    const finalY = (doc as any).lastAutoTable?.finalY || 110
    const summaryY = finalY + 8
    doc.rect(120, summaryY, 76, 40)
    doc.setFont('helvetica', 'normal')
    doc.text('Taxable Amount:', 124, summaryY + 8)
    doc.text(amount(taxable), 192, summaryY + 8, { align: 'right' })
    doc.text(`CGST (${(gstRate / 2).toFixed(2)}%):`, 124, summaryY + 14)
    doc.text(amount(cgst), 192, summaryY + 14, { align: 'right' })
    doc.text(`SGST (${(gstRate / 2).toFixed(2)}%):`, 124, summaryY + 20)
    doc.text(amount(sgst), 192, summaryY + 20, { align: 'right' })
    doc.text(`IGST (${gstRate.toFixed(2)}%):`, 124, summaryY + 26)
    doc.text(amount(igst), 192, summaryY + 26, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.text('Grand Total:', 124, summaryY + 34)
    doc.text(amount(grandTotal), 192, summaryY + 34, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text(`Total Tax: ${amount(totalTax)}`, 14, summaryY + 8)
    doc.text(`Balance Due: ${amount(invoice.balance || 0)}`, 14, summaryY + 14)
    doc.text('Bank Details: To be configured', 14, summaryY + 20)
    doc.text('This is a system generated invoice.', 14, summaryY + 26)
    doc.text('Authorized Signatory', 14, summaryY + 36)

    const paid = String(invoice.status || '').toUpperCase() === 'PAID'
    if (paid) {
        doc.setTextColor(22, 163, 74)
    } else {
        doc.setTextColor(217, 119, 6)
    }
    const statusText = `STATUS: ${text(invoice.status).toUpperCase()}`
    const statusY = summaryY + 47
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.text(statusText, pageWidth - 14, statusY, { align: 'right' })
    doc.setTextColor(0, 0, 0)

    doc.save(`Invoice-${invoice.invoice_number}.pdf`)
}

// ============================================================================
// EXCEL EXPORTS
// ============================================================================

/**
 * Export GRN List to Excel
 */
export const exportGRNsToExcel = (grns: Array<any>) => {
    const data = grns.map(grn => ({
        'GRN Number': grn.grn_number,
        'Receipt Date': grn.receipt_date,
        'Supplier': grn.supplier_name,
        'Warehouse': grn.warehouse_name,
        'Total Items': grn.total_items,
        'Total Quantity': grn.total_quantity,
        'Status': grn.status
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'GRNs')

    XLSX.writeFile(wb, `GRN-List-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Delivery Orders to Excel
 */
export const exportDOsToExcel = (deliveryOrders: Array<any>) => {
    const data = deliveryOrders.map(dO => ({
        'DO Number': dO.do_number,
        'Request Date': dO.request_date,
        'Dispatch Date': dO.dispatch_date,
        'Client': dO.client_name,
        'Warehouse': dO.warehouse_name,
        'Supplier': dO.supplier_name,
        'Invoice No': dO.invoice_no,
        'Invoice Date': dO.invoice_date,
        'Model No': dO.model_no,
        'Serial No': dO.serial_no,
        'Material Description': dO.material_description,
        'Mfg Date': dO.date_of_manufacturing,
        'Basic Price': dO.basic_price,
        'Invoice Qty': dO.invoice_qty,
        'Dispatched Qty (Capture)': dO.dispatched_qty,
        'Difference': dO.quantity_difference,
        'No. of Cases': dO.no_of_cases,
        'No. of Pallets': dO.no_of_pallets,
        'Weight (KG)': dO.weight_kg,
        'Handling Type': dO.handling_type,
        'Machine Type': dO.machine_type,
        'Machine From': dO.machine_from_time,
        'Machine To': dO.machine_to_time,
        'Outward Remarks': dO.outward_remarks,
        'Total Items': dO.total_items,
        'Requested Qty': dO.total_quantity_requested,
        'Dispatched Qty': dO.total_quantity_dispatched,
        'Fulfillment %': dO.fulfillment_percentage,
        'Status': dO.status
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Delivery Orders')

    XLSX.writeFile(wb, `DO-List-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Stock to Excel
 */
export const exportStockToExcel = (stockData: Array<any>) => {
    const data = stockData.map(stock => ({
        'Item Code': stock.item_code,
        'Item Name': stock.item_name,
        'Client': stock.client_name,
        'Warehouse': stock.warehouse_name,
        'Bin Location': stock.bin_location,
        'Quantity': stock.quantity,
        'Unit': stock.unit,
        'Last Updated': stock.last_updated
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock')

    // Auto-width columns
    const maxWidth = data.reduce((w: number[], r: any) => {
        return Object.keys(r).map((key, i) => {
            const colWidth = Math.max(
                w[i] || 10,
                key.length,
                String(r[key]).length
            )
            return colWidth
        })
    }, [])

    ws['!cols'] = maxWidth.map((w: number) => ({ width: w + 2 }))

    XLSX.writeFile(wb, `Stock-Report-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Invoices to Excel
 */
export const exportInvoicesToExcel = (invoices: Array<any>) => {
    const data = invoices.map(inv => ({
        'Invoice Number': inv.invoice_number,
        'Client': inv.client_name,
        'Billing Period': inv.billing_period,
        'Invoice Date': inv.invoice_date,
        'Due Date': inv.due_date,
        'Total Amount': inv.total_amount,
        'Paid Amount': inv.paid_amount,
        'Balance': inv.balance,
        'Status': inv.status
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Invoices')

    XLSX.writeFile(wb, `Invoices-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Gate Log to Excel
 */
export const exportGateLogToExcel = (gateLogs: Array<any>) => {
    const data = gateLogs.map(log => ({
        'Gate Entry ID': log.gate_entry_id,
        'Type': log.entry_type,
        'Vehicle Number': log.vehicle_number,
        'Driver Name': log.driver_name,
        'Driver Phone': log.driver_phone,
        'Transporter Name': log.transport_company,
        'LR Number': log.lr_number,
        'LR Date': log.lr_date,
        'E-Way Bill Number': log.e_way_bill_number,
        'E-Way Bill Date': log.e_way_bill_date,
        'From Location': log.from_location,
        'To Location': log.to_location,
        'Vehicle Type': log.vehicle_type,
        'Vehicle Model': log.vehicle_model,
        'Transported By': log.transported_by,
        'Vendor Name': log.vendor_name,
        'Transportation Remarks': log.transportation_remarks,
        'Entry Time': log.entry_time,
        'Exit Time': log.exit_time || 'N/A',
        'Purpose': log.purpose,
        'Status': log.status
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Gate Log')

    XLSX.writeFile(wb, `Gate-Log-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Gate In report to PDF
 */
export const exportGateInReportPDF = (gateInRows: Array<any>) => {
    const doc = new jsPDF('landscape')

    doc.setFontSize(18)
    doc.text('Gate In Report', 14, 18)
    doc.setFontSize(10)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 25)
    doc.text(`Total Records: ${gateInRows.length}`, 14, 31)

    autoTable(doc, {
        startY: 36,
        head: [[
            'Gate In No',
            'Vehicle',
            'Transporter',
            'LR No/Date',
            'E-Way Bill',
            'Route',
            'Vehicle Type/Model',
            'Transported By',
            'Vendor',
            'In Time',
            'Remarks',
            'Client',
            'Warehouse',
        ]],
        body: gateInRows.map((row: any) => [
            row.gate_in_number || '-',
            row.vehicle_number || '-',
            row.transport_company || row.driver_name || '-',
            `${row.lr_number || '-'} / ${row.lr_date || '-'}`,
            `${row.e_way_bill_number || '-'} / ${row.e_way_bill_date || '-'}`,
            `${row.from_location || '-'} -> ${row.to_location || '-'}`,
            `${row.vehicle_type || '-'} / ${row.vehicle_model || '-'}`,
            row.transported_by || '-',
            row.vendor_name || '-',
            row.gate_in_datetime || '-',
            row.transportation_remarks || row.remarks || '-',
            row.client_name || '-',
            row.warehouse_name || '-',
        ]),
        theme: 'grid',
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [34, 197, 94] },
    })

    doc.save(`Gate-In-Report-${new Date().toISOString().split('T')[0]}.pdf`)
}

/**
 * Export Gate In report to Excel
 */
export const exportGateInToExcel = (gateInRows: Array<any>) => {
    const data = gateInRows.map((row) => ({
        'Gate In Number': row.gate_in_number,
        'Gate In Time': row.gate_in_datetime,
        'Vehicle Number': row.vehicle_number,
        'Transporter Name': row.transport_company,
        'Driver Name': row.driver_name,
        'Driver Phone': row.driver_phone,
        'LR Number': row.lr_number,
        'LR Date': row.lr_date,
        'E-Way Bill Number': row.e_way_bill_number,
        'E-Way Bill Date': row.e_way_bill_date,
        'From Location': row.from_location,
        'To Location': row.to_location,
        'Vehicle Type': row.vehicle_type,
        'Vehicle Model': row.vehicle_model,
        'Transported By': row.transported_by,
        'Vendor Name': row.vendor_name,
        'Transportation Remarks': row.transportation_remarks,
        'Client': row.client_name,
        'Warehouse': row.warehouse_name,
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Gate In')
    XLSX.writeFile(wb, `Gate-In-Report-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Users to Excel
 */
export const exportUsersToExcel = (users: Array<any>) => {
    const data = users.map(user => ({
        'User ID': user.user_code,
        'Full Name': user.full_name,
        'Email': user.email,
        'Role': user.role,
        'Assigned Warehouse': user.warehouse_name || 'All Warehouses',
        'Status': user.status,
        'Created Date': user.created_at
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Users')

    XLSX.writeFile(wb, `Users-${new Date().toISOString().split('T')[0]}.xlsx`)
}

/**
 * Export Clients to Excel
 */
export const exportClientsToExcel = (clients: Array<any>) => {
    const data = clients.map(client => ({
        'Client Code': client.client_code,
        'Company Name': client.company_name,
        'Contact Person': client.contact_person,
        'Email': client.email,
        'Phone': client.phone,
        'City': client.city,
        'State': client.state,
        'GST Number': client.gst_number,
        'Rate Card': client.rate_card_type,
        'Status': client.status
    }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Clients')

    XLSX.writeFile(wb, `Clients-${new Date().toISOString().split('T')[0]}.xlsx`)
}



