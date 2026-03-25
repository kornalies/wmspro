import type { DOStatus } from "@/lib/do-status"

export interface User {
  id: number
  username: string
  email: string
  full_name: string
  phone?: string
  role: "ADMIN" | "OPERATIONS" | "GATE_STAFF" | "FINANCE"
  warehouse_id?: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Client {
  id: number
  client_code: string
  client_name: string
  gst_number?: string
  pan_number?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
  contact_person?: string
  contact_phone?: string
  contact_email?: string
  is_active: boolean
  created_at: string
}

export interface Item {
  id: number
  item_code: string
  item_name: string
  category_id?: number
  category_name?: string
  hsn_code?: string
  uom: string
  standard_mrp?: number
  min_stock_alert?: number
  is_active: boolean
}

export interface Warehouse {
  id: number
  warehouse_code: string
  warehouse_name: string
  address?: string
  city?: string
  state?: string
  pincode?: string
  is_active: boolean
}

export interface WarehouseZone {
  id: number
  warehouse_id: number
  zone_code: string
  zone_name?: string
  zone_type?: string
  capacity_cubic_meters?: number
  is_active: boolean
}

export interface StockSerialNumber {
  id: number
  serial_number: string
  item_id: number
  client_id: number
  warehouse_id: number
  zone_id?: number
  status: "IN_STOCK" | "RESERVED" | "DISPATCHED"
  received_date: string
  grn_header_id?: number
  do_header_id?: number
}

export interface GRNHeader {
  id: number
  grn_number: string
  grn_date: string
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
  quantity_difference?: number
  damage_quantity?: number
  case_count?: number
  pallet_count?: number
  weight_kg?: number
  handling_type?: "MACHINE" | "MANUAL"
  source_channel?: string
  total_items: number
  total_quantity: number
  total_value?: number
  status: "DRAFT" | "COMPLETED" | "CANCELLED"
  created_by: number
  created_at: string
}

export interface GRNLineItem {
  id: number
  grn_header_id: number
  item_id: number
  quantity: number
  rate?: number
  amount?: number
  serial_numbers?: string[]
}

export interface DOHeader {
  id: number
  do_number: string
  request_date: string
  client_id: number
  warehouse_id: number
  delivery_address: string
  customer_name: string
  customer_phone?: string
  dispatch_date?: string
  supplier_name?: string
  invoice_no?: string
  invoice_date?: string
  model_no?: string
  serial_no?: string
  material_description?: string
  date_of_manufacturing?: string
  basic_price?: number
  invoice_qty?: number
  dispatched_qty?: number
  quantity_difference?: number
  no_of_cases?: number
  no_of_pallets?: number
  weight_kg?: number
  handling_type?: "MACHINE" | "MANUAL"
  machine_type?: string
  machine_from_time?: string
  machine_to_time?: string
  outward_remarks?: string
  total_items: number
  total_quantity_requested: number
  total_quantity_dispatched: number
  status: DOStatus
  created_by: number
  created_at: string
}

export interface DOLineItem {
  id: number
  do_header_id: number
  item_id: number
  quantity_requested: number
  quantity_dispatched: number
  serial_numbers?: string[]
}

export interface GateIn {
  id: number
  gate_in_number: string
  gate_in_datetime: string
  warehouse_id: number
  client_id: number
  grn_header_id?: number
  vehicle_number: string
  driver_name?: string
  driver_phone?: string
  transport_company?: string
  lr_number?: string
  lr_date?: string
  e_way_bill_number?: string
  e_way_bill_date?: string
  from_location?: string
  to_location?: string
  vehicle_type?: string
  vehicle_model?: string
  transported_by?: string
  vendor_name?: string
  transportation_remarks?: string
  created_by: number
}

export interface GateOut {
  id: number
  gate_out_number: string
  gate_out_datetime: string
  warehouse_id: number
  client_id: number
  do_header_id?: number
  vehicle_number: string
  driver_name: string
  driver_phone?: string
  created_by: number
}

export interface APIResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export type BillingChargeType =
  | "INBOUND_HANDLING"
  | "OUTBOUND_HANDLING"
  | "STORAGE"
  | "VAS"
  | "FIXED"
  | "MINIMUM"
  | "ADJUSTMENT"

export type BillingTxnStatus = "UNBILLED" | "BILLED" | "VOID"
export type BillingCycle = "WEEKLY" | "MONTHLY"
export type StorageBillingMethod = "SNAPSHOT" | "DURATION"
export type BillingSourceType = "GRN" | "DO" | "VAS" | "STORAGE" | "MANUAL"
export type InvoiceStatus = "DRAFT" | "FINALIZED" | "SENT" | "PAID" | "OVERDUE" | "VOID"

export interface BillingTransaction {
  id: number
  client_id: number
  warehouse_id?: number
  charge_type: BillingChargeType
  source_type: BillingSourceType
  source_doc_id?: number
  source_ref_no?: string
  event_date: string
  quantity: number
  rate: number
  amount: number
  total_tax_amount: number
  gross_amount: number
  status: BillingTxnStatus
  invoice_id?: number
}
