import { z } from "zod"

export const mobileGrnCaptureSchema = z.object({
  header: z.object({
    client_id: z.number(),
    warehouse_id: z.number(),
    invoice_number: z.string().min(1),
    invoice_date: z.string().min(1),
    supplier_name: z.string().optional(),
    supplier_gst: z.string().optional(),
    gate_in_number: z.string().optional(),
    model_number: z.string().optional(),
    material_description: z.string().optional(),
    receipt_date: z.string().optional(),
    manufacturing_date: z.string().optional(),
    basic_price: z.number().optional(),
    invoice_quantity: z.number().int().optional(),
    received_quantity: z.number().int().optional(),
    quantity_difference: z.number().int().optional(),
    damage_quantity: z.number().int().optional(),
    case_count: z.number().int().optional(),
    pallet_count: z.number().int().optional(),
    weight_kg: z.number().optional(),
    handling_type: z.enum(["MACHINE", "MANUAL"]).optional(),
  }),
  lineItems: z
    .array(
      z.object({
        item_id: z.number(),
        quantity: z.number().min(1),
        rate: z.number().optional(),
        serial_numbers: z.array(z.string()).min(1),
      })
    )
    .min(1),
  source_channel: z.string().optional(),
  notes: z.string().optional(),
})

export type MobileGrnCaptureInput = z.infer<typeof mobileGrnCaptureSchema>
