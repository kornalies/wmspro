import { z } from "zod"

export const freightModeSchema = z.enum(["AIR", "SEA", "ROAD"])
export const freightDirectionSchema = z.enum(["IMPORT", "EXPORT", "DOMESTIC"])
export const freightShipmentStatusSchema = z.enum([
  "DRAFT",
  "BOOKED",
  "IN_TRANSIT",
  "CUSTOMS_HOLD",
  "ARRIVED",
  "DELIVERED",
  "CANCELLED",
])
export const freightLegStatusSchema = z.enum(["PLANNED", "BOOKED", "DEPARTED", "ARRIVED", "CANCELLED"])
export const freightMilestoneStatusSchema = z.enum(["PENDING", "COMPLETED", "DELAYED", "CANCELLED"])
export const freightDocumentTypeSchema = z.enum([
  "HAWB",
  "MAWB",
  "HBL",
  "MBL",
  "INVOICE",
  "PACKING_LIST",
  "COO",
  "BOE",
  "OTHER",
])

export const freightShipmentCreateSchema = z.object({
  mode: freightModeSchema,
  direction: freightDirectionSchema.default("EXPORT"),
  status: freightShipmentStatusSchema.optional(),
  client_id: z.number().int().positive().optional(),
  shipper_name: z.string().trim().max(160).optional(),
  consignee_name: z.string().trim().max(160).optional(),
  incoterm: z.string().trim().max(20).optional(),
  origin: z.string().trim().min(2).max(120),
  destination: z.string().trim().min(2).max(120),
  etd: z.string().datetime().optional(),
  eta: z.string().datetime().optional(),
  remarks: z.string().trim().max(1500).optional(),
})

export const freightShipmentUpdateSchema = freightShipmentCreateSchema.partial()

export const freightLegCreateSchema = z.object({
  leg_no: z.number().int().positive().optional(),
  transport_mode: freightModeSchema,
  carrier_name: z.string().trim().max(160).optional(),
  vessel_or_flight: z.string().trim().max(120).optional(),
  voyage_or_flight_no: z.string().trim().max(80).optional(),
  from_location: z.string().trim().min(2).max(120),
  to_location: z.string().trim().min(2).max(120),
  etd: z.string().datetime().optional(),
  eta: z.string().datetime().optional(),
  atd: z.string().datetime().optional(),
  ata: z.string().datetime().optional(),
  status: freightLegStatusSchema.optional(),
})

export const freightMilestoneCreateSchema = z.object({
  code: z.string().trim().min(2).max(40),
  planned_at: z.string().datetime().optional(),
  actual_at: z.string().datetime().optional(),
  status: freightMilestoneStatusSchema.optional(),
  remarks: z.string().trim().max(1000).optional(),
})

export const freightDocumentCreateSchema = z.object({
  doc_type: freightDocumentTypeSchema,
  doc_no: z.string().trim().min(2).max(120),
  issue_date: z.string().date().optional(),
  attachment_id: z.number().int().positive().optional(),
  is_master: z.boolean().optional(),
  metadata_json: z.record(z.string(), z.unknown()).optional(),
})
