import { z } from "zod"

export const grnLineFormSchema = z.object({
  item_id: z.string().min(1, "Item is required"),
  zone_layout_id: z.string().min(1, "Put away bin is required"),
  quantity: z.number().min(1, "Quantity must be at least 1"),
  rate: z.number().min(0, "Rate must be 0 or greater").optional(),
  serial_numbers: z.string().min(1, "Serial numbers required"),
})

export const grnFormSchema = z
  .object({
    client_id: z.string().min(1, "Client is required"),
    warehouse_id: z.string().min(1, "Warehouse is required"),
    invoice_number: z.string().min(1, "Invoice number is required"),
    invoice_date: z.string().min(1, "Invoice date is required"),
    supplier_name: z.string().optional(),
    supplier_gst: z
      .string()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid GST number")
      .optional()
      .or(z.literal("")),
    supplier_phone: z.string().optional(),
    supplier_address: z.string().optional(),
    gate_in_number: z.string().optional(),
    model_number: z.string().optional(),
    material_description: z.string().optional(),
    receipt_date: z.string().optional(),
    manufacturing_date: z.string().optional(),
    basic_price: z.number().min(0, "Basic price must be 0 or greater").optional(),
    invoice_quantity: z.number().int().min(0).optional(),
    received_quantity: z.number().int().min(0).optional(),
    damage_quantity: z.number().int().min(0).optional(),
    case_count: z.number().int().min(0).optional(),
    pallet_count: z.number().int().min(0).optional(),
    weight_kg: z.number().min(0).optional(),
    handling_type: z.enum(["MACHINE", "MANUAL"]).optional(),
    qc_status: z.enum(["PENDING", "PASSED", "HOLD", "REJECTED"]).optional(),
    variance_reason: z.string().optional(),
    attachment_names: z.array(z.string()).optional(),
    lineItems: z.array(grnLineFormSchema).min(1, "At least one line item required"),
  })
  .superRefine((value, ctx) => {
    if (value.invoice_date && value.receipt_date && new Date(value.invoice_date) > new Date(value.receipt_date)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invoice date cannot be after receipt date",
        path: ["invoice_date"],
      })
    }
    if (value.manufacturing_date && value.invoice_date && new Date(value.manufacturing_date) > new Date(value.invoice_date)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manufacturing date cannot be after invoice date",
        path: ["manufacturing_date"],
      })
    }
  })

export type GRNFormValues = z.infer<typeof grnFormSchema>

export type GRNFormPayload = {
  header: {
    client_id: number
    warehouse_id: number
    invoice_number: string
    invoice_date: string
    supplier_name: string
    supplier_gst: string
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
    handling_type?: "MACHINE" | "MANUAL"
    source_channel?: string
    status?: "DRAFT" | "CONFIRMED"
    total_items: number
    total_quantity: number
    total_value: number
  }
  lineItems: Array<{
    item_id: number
    zone_layout_id?: number
    quantity: number
    rate: number
    serial_numbers: string[]
  }>
}
