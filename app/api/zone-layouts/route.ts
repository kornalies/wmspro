import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureZoneLayoutSchema } from "@/lib/db-bootstrap"

const zoneLayoutSchema = z.object({
  warehouse_id: z.number().positive(),
  zone_code: z.string().min(1).max(30),
  zone_name: z.string().min(1).max(100),
  rack_code: z.string().min(1).max(30),
  rack_name: z.string().min(1).max(100),
  bin_code: z.string().min(1).max(40),
  bin_name: z.string().min(1).max(120),
  capacity_units: z.number().int().nonnegative().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

const zoneLayoutUpdateSchema = zoneLayoutSchema.extend({
  id: z.number().positive(),
  is_active: z.boolean().optional(),
})

export async function GET(request: NextRequest) {
  try {
    await ensureZoneLayoutSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { searchParams } = new URL(request.url)
    const warehouseId = searchParams.get("warehouse_id")
    const isActive = searchParams.get("is_active")

    const where: string[] = []
    const params: Array<number | boolean> = []

    if (warehouseId) {
      params.push(Number(warehouseId))
      where.push(`zl.warehouse_id = $${params.length}`)
    }

    if (isActive !== null) {
      params.push(isActive === "true")
      where.push(`zl.is_active = $${params.length}`)
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const result = await query(
      `SELECT
        zl.id,
        zl.warehouse_id,
        w.warehouse_name,
        zl.zone_code,
        zl.zone_name,
        zl.rack_code,
        zl.rack_name,
        zl.bin_code,
        zl.bin_name,
        zl.capacity_units,
        zl.sort_order,
        zl.attributes,
        zl.is_active
      FROM warehouse_zone_layouts zl
      JOIN warehouses w ON w.id = zl.warehouse_id
      ${whereClause}
      ORDER BY w.warehouse_name, zl.zone_code, zl.rack_code, zl.bin_code`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch zone layouts"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureZoneLayoutSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = zoneLayoutSchema.parse(await request.json())

    const result = await query(
      `INSERT INTO warehouse_zone_layouts (
        warehouse_id, zone_code, zone_name, rack_code, rack_name, bin_code, bin_name,
        capacity_units, sort_order, attributes, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
      RETURNING *`,
      [
        payload.warehouse_id,
        payload.zone_code.toUpperCase(),
        payload.zone_name,
        payload.rack_code.toUpperCase(),
        payload.rack_name,
        payload.bin_code.toUpperCase(),
        payload.bin_name,
        payload.capacity_units ?? null,
        payload.sort_order ?? 0,
        payload.attributes ?? {},
      ]
    )

    return ok(result.rows[0], "Zone layout created successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create zone layout"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    await ensureZoneLayoutSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = zoneLayoutUpdateSchema.parse(await request.json())

    const result = await query(
      `UPDATE warehouse_zone_layouts SET
        warehouse_id = $1,
        zone_code = $2,
        zone_name = $3,
        rack_code = $4,
        rack_name = $5,
        bin_code = $6,
        bin_name = $7,
        capacity_units = $8,
        sort_order = $9,
        attributes = $10,
        is_active = $11,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *`,
      [
        payload.warehouse_id,
        payload.zone_code.toUpperCase(),
        payload.zone_name,
        payload.rack_code.toUpperCase(),
        payload.rack_name,
        payload.bin_code.toUpperCase(),
        payload.bin_name,
        payload.capacity_units ?? null,
        payload.sort_order ?? 0,
        payload.attributes ?? {},
        payload.is_active ?? true,
        payload.id,
      ]
    )

    return ok(result.rows[0], "Zone layout updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update zone layout"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await ensureZoneLayoutSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Zone layout id is required", 400)

    await query("UPDATE warehouse_zone_layouts SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id])
    return ok({ id }, "Zone layout deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete zone layout"
    return fail("DELETE_FAILED", message, 400)
  }
}
