import { z } from "zod"

export const loginSchema = z.object({
  company_code: z.string().trim().min(2, "Company code is required"),
  username: z.string().trim().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
})

export const registerSchema = z.object({
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(6),
  full_name: z.string().min(2),
  role: z.string().min(2).max(50),
  warehouse_id: z.number().optional(),
})

export const grnHeaderSchema = z.object({
  client_id: z.number(),
  warehouse_id: z.number(),
  invoice_number: z.string().min(1),
  invoice_date: z.string(),
  supplier_name: z.string().optional(),
  supplier_gst: z.string().optional(),
  total_items: z.number().int().min(1),
  total_quantity: z.number().min(1),
  total_value: z.number().optional(),
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
  source_channel: z.string().optional(),
  status: z.enum(["DRAFT", "CONFIRMED"]).optional(),
})

export const grnLineItemSchema = z.object({
  item_id: z.number(),
  quantity: z.number().min(1),
  serial_numbers: z.array(z.string()).min(1),
  rate: z.number().optional(),
  zone_layout_id: z.number().positive().optional(),
})

export const doHeaderSchema = z.object({
  client_id: z.number(),
  warehouse_id: z.number(),
  delivery_address: z.string().min(5),
  customer_name: z.string().min(2),
  customer_phone: z.string().optional(),
  dispatch_date: z.string().optional(),
  supplier_name: z.string().optional(),
  invoice_no: z.string().optional(),
  invoice_date: z.string().optional(),
  model_no: z.string().optional(),
  serial_no: z.string().optional(),
  material_description: z.string().optional(),
  date_of_manufacturing: z.string().optional(),
  basic_price: z.number().optional(),
  invoice_qty: z.number().int().optional(),
  dispatched_qty: z.number().int().optional(),
  quantity_difference: z.number().int().optional(),
  no_of_cases: z.number().int().optional(),
  no_of_pallets: z.number().int().optional(),
  weight_kg: z.number().optional(),
  handling_type: z.enum(["MACHINE", "MANUAL"]).optional(),
  machine_type: z.string().optional(),
  machine_from_time: z.string().optional(),
  machine_to_time: z.string().optional(),
  outward_remarks: z.string().optional(),
  total_items: z.number().min(1),
  total_quantity_requested: z.number().int().min(1),
})

export const doLineItemSchema = z.object({
  item_id: z.number(),
  quantity_requested: z.number().int().min(1),
  serial_numbers: z.array(z.string()).optional(),
})

export const userSchema = z.object({
  username: z.string().min(3),
  email: z.string().email(),
  full_name: z.string().min(2),
  phone: z.string().optional(),
  role: z.string().min(2).max(50),
  warehouse_id: z.number().optional(),
})

export const clientSchema = z.object({
  client_code: z.string().min(2),
  client_name: z.string().min(2),
  gst_number: z.string().optional(),
  pan_number: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  contact_person: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z
    .union([z.string().trim().email(), z.literal("")])
    .optional()
    .transform((value) => (value ? value : undefined)),
})

export const itemSchema = z.object({
  item_code: z.string().min(2),
  item_name: z.string().min(2),
  category_id: z.number().optional(),
  hsn_code: z.string().optional(),
  uom: z.string().min(1),
  standard_mrp: z.number().optional(),
  min_stock_alert: z.number().optional(),
})

export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
export type GRNHeaderInput = z.infer<typeof grnHeaderSchema>
export type GRNLineItemInput = z.infer<typeof grnLineItemSchema>
export type DOHeaderInput = z.infer<typeof doHeaderSchema>
export type DOLineItemInput = z.infer<typeof doLineItemSchema>
export type UserInput = z.infer<typeof userSchema>
export type ClientInput = z.infer<typeof clientSchema>
export type ItemInput = z.infer<typeof itemSchema>
