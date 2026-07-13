import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensureZoneLayoutSchema } from "@/lib/db-bootstrap"
import { ensureWarehouseZone } from "@/lib/warehouse-zones"
import { BIN_STATUSES, DEFAULT_BIN_STATUS, DEFAULT_ZONE_TYPE, ZONE_TYPES } from "@/lib/zone-layouts"

const zoneLayoutSchema = z.object({
  warehouse_id: z.number().positive(),
  zone_code: z.string().min(1).max(30),
  zone_name: z.string().min(1).max(100),
  zone_type: z.enum(ZONE_TYPES).default(DEFAULT_ZONE_TYPE),
  rack_code: z.string().min(1).max(30),
  rack_name: z.string().min(1).max(100),
  bin_code: z.string().min(1).max(40),
  bin_name: z.string().min(1).max(120),
  bin_status: z.enum(BIN_STATUSES).default(DEFAULT_BIN_STATUS),
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
        zl.zone_type,
        zl.rack_code,
        zl.rack_name,
        zl.bin_code,
        zl.bin_name,
        zl.bin_status,
        zl.capacity_units,
        COALESCE(stock.stock_count, 0)::int AS stock_count,
        zl.sort_order,
        zl.attributes,
        zl.is_active
      FROM warehouse_zone_layouts zl
      JOIN warehouses w ON w.id = zl.warehouse_id
      LEFT JOIN (
        SELECT
          zone_layout_id,
          COUNT(*) FILTER (WHERE status IN ('IN_STOCK', 'RESERVED'))::int AS stock_count
        FROM stock_serial_numbers
        WHERE zone_layout_id IS NOT NULL
        GROUP BY zone_layout_id
      ) stock ON stock.zone_layout_id = zl.id
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
  await ensureZoneLayoutSchema()
  const session = await getSession()
  if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

  const client = await getClient()
  try {
    const payload = zoneLayoutSchema.parse(await request.json())
    const zoneCode = payload.zone_code.toUpperCase()

    await client.query("BEGIN")
    await setTenantContext(client, session.companyId)

    const warehouseZoneId = await ensureWarehouseZone(client, {
      companyId: session.companyId,
      warehouseId: payload.warehouse_id,
      zoneCode,
      zoneName: payload.zone_name,
      zoneType: payload.zone_type,
    })

    const result = await client.query(
      `INSERT INTO warehouse_zone_layouts (
        warehouse_id, zone_code, zone_name, zone_type, rack_code, rack_name, bin_code, bin_name,
        bin_status, capacity_units, sort_order, attributes, warehouse_zone_id, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
      RETURNING *`,
      [
        payload.warehouse_id,
        zoneCode,
        payload.zone_name,
        payload.zone_type,
        payload.rack_code.toUpperCase(),
        payload.rack_name,
        payload.bin_code.toUpperCase(),
        payload.bin_name,
        payload.bin_status,
        payload.capacity_units ?? null,
        payload.sort_order ?? 0,
        payload.attributes ?? {},
        warehouseZoneId,
      ]
    )

    await client.query("COMMIT")
    return ok(result.rows[0], "Zone layout created successfully")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => {})
    const message = error instanceof Error ? error.message : "Failed to create zone layout"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    client.release()
  }
}

export async function PUT(request: NextRequest) {
  await ensureZoneLayoutSchema()
  const session = await getSession()
  if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

  const client = await getClient()
  try {
    const payload = zoneLayoutUpdateSchema.parse(await request.json())
    const zoneCode = payload.zone_code.toUpperCase()

    await client.query("BEGIN")
    await setTenantContext(client, session.companyId)

    // Re-resolve the canonical zone in case the zone_code/name/type changed.
    const warehouseZoneId = await ensureWarehouseZone(client, {
      companyId: session.companyId,
      warehouseId: payload.warehouse_id,
      zoneCode,
      zoneName: payload.zone_name,
      zoneType: payload.zone_type,
    })

    const result = await client.query(
      `UPDATE warehouse_zone_layouts SET
        warehouse_id = $1,
        zone_code = $2,
        zone_name = $3,
        zone_type = $4,
        rack_code = $5,
        rack_name = $6,
        bin_code = $7,
        bin_name = $8,
        bin_status = $9,
        capacity_units = $10,
        sort_order = $11,
        attributes = $12,
        is_active = $13,
        warehouse_zone_id = $14,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING *`,
      [
        payload.warehouse_id,
        zoneCode,
        payload.zone_name,
        payload.zone_type,
        payload.rack_code.toUpperCase(),
        payload.rack_name,
        payload.bin_code.toUpperCase(),
        payload.bin_name,
        payload.bin_status,
        payload.capacity_units ?? null,
        payload.sort_order ?? 0,
        payload.attributes ?? {},
        payload.is_active ?? true,
        warehouseZoneId,
        payload.id,
      ]
    )

    await client.query("COMMIT")
    return ok(result.rows[0], "Zone layout updated successfully")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => {})
    const message = error instanceof Error ? error.message : "Failed to update zone layout"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    client.release()
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
