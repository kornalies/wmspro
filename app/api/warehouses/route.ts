import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return fail("UNAUTHORIZED", "Unauthorized", 401)
    }

    const { searchParams } = new URL(request.url)
    const isActive = searchParams.get("is_active")
    const params: Array<string | boolean | number> = []

    const columnResult = await query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'warehouses'
         AND column_name = ANY($1::text[])`,
      [["created_at", "updated_at", "warehouse_type", "region_tag", "latitude", "longitude"]]
    )
    const available = new Set(
      columnResult.rows.map((row: { column_name: string }) => row.column_name)
    )
    const hasCreatedAt = available.has("created_at")
    const hasUpdatedAt = available.has("updated_at")
    const hasWarehouseType = available.has("warehouse_type")
    const hasRegionTag = available.has("region_tag")
    const hasLatitude = available.has("latitude")
    const hasLongitude = available.has("longitude")

    const createdAtExpr = hasCreatedAt
      ? "w.created_at"
      : "NULL::timestamp AS created_at"
    const updatedAtExpr = hasUpdatedAt
      ? "w.updated_at"
      : "NULL::timestamp AS updated_at"
    const typeExpr = hasWarehouseType
      ? "COALESCE(NULLIF(w.warehouse_type, ''), 'Secondary') AS warehouse_type"
      : "CASE WHEN w.id = min_wh.min_id THEN 'Main' ELSE 'Secondary' END AS warehouse_type"
    const regionExpr = hasRegionTag
      ? "COALESCE(NULLIF(w.region_tag, ''), 'Unassigned') AS region_tag"
      : `CASE
           WHEN UPPER(COALESCE(w.state, '')) IN ('TAMIL NADU','KERALA','KARNATAKA','ANDHRA PRADESH','TELANGANA') THEN 'South'
           WHEN UPPER(COALESCE(w.state, '')) IN ('DELHI','HARYANA','PUNJAB','UTTAR PRADESH','RAJASTHAN','HIMACHAL PRADESH','UTTARAKHAND','JAMMU AND KASHMIR') THEN 'North'
           WHEN UPPER(COALESCE(w.state, '')) IN ('MAHARASHTRA','GUJARAT','GOA') THEN 'West'
           WHEN UPPER(COALESCE(w.state, '')) IN ('WEST BENGAL','ODISHA','BIHAR','JHARKHAND','ASSAM') THEN 'East'
           ELSE 'Unassigned'
         END AS region_tag`
    const latitudeExpr = hasLatitude ? "w.latitude" : "NULL::numeric AS latitude"
    const longitudeExpr = hasLongitude ? "w.longitude" : "NULL::numeric AS longitude"

    let sql = `
      SELECT
        w.id,
        w.warehouse_code,
        w.warehouse_name,
        w.city,
        w.state,
        w.pincode,
        ${latitudeExpr},
        ${longitudeExpr},
        w.is_active,
        ${createdAtExpr},
        ${updatedAtExpr},
        ${typeExpr},
        ${regionExpr},
        COALESCE(manager.manager_name, 'Unassigned') AS manager_name,
        COALESCE(zone.total_zones, 0)::int AS total_zones,
        COALESCE(stock.active_skus, 0)::int AS active_skus,
        COALESCE(grn.open_grns, 0)::int AS open_grns,
        COALESCE(stock.stock_value, 0)::numeric(14,2) AS stock_value,
        COALESCE(cap.capacity_total_units, 0)::int AS capacity_total_units,
        COALESCE(cap.capacity_used_units, 0)::int AS capacity_used_units,
        CASE
          WHEN COALESCE(cap.capacity_total_units, 0) > 0
            THEN ROUND((cap.capacity_used_units::numeric / cap.capacity_total_units::numeric) * 100, 1)
          ELSE 0
        END AS capacity_used_pct,
        COALESCE(client_mix.client_breakdown, '[]'::json) AS client_breakdown
      FROM warehouses
      w
      CROSS JOIN (
        SELECT MIN(id) AS min_id
        FROM warehouses
        WHERE company_id = $1
      ) min_wh
      LEFT JOIN LATERAL (
        SELECT u.full_name AS manager_name
        FROM users u
        WHERE u.company_id = $1
          AND u.warehouse_id = w.id
          AND u.is_active = true
        ORDER BY
          CASE WHEN u.role = 'WAREHOUSE_MANAGER' THEN 0 ELSE 1 END,
          u.id ASC
        LIMIT 1
      ) manager ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total_zones
        FROM warehouse_zone_layouts zl
        WHERE zl.company_id = $1
          AND zl.warehouse_id = w.id
          AND zl.is_active = true
      ) zone ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT ssn.item_id) FILTER (WHERE ssn.status IN ('IN_STOCK', 'RESERVED')) AS active_skus,
          SUM(COALESCE(gli.mrp, 0)) FILTER (WHERE ssn.status IN ('IN_STOCK', 'RESERVED')) AS stock_value
        FROM stock_serial_numbers ssn
        LEFT JOIN grn_line_items gli ON gli.id = ssn.grn_line_item_id
        WHERE ssn.company_id = $1
          AND ssn.warehouse_id = w.id
      ) stock ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS open_grns
        FROM grn_header gh
        WHERE gh.company_id = $1
          AND gh.warehouse_id = w.id
          AND gh.status = 'DRAFT'
      ) grn ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN COALESCE(SUM(COALESCE(zl.capacity_units, 0)), 0) > 0
              THEN COALESCE(SUM(COALESCE(zl.capacity_units, 0)), 0)
            ELSE COUNT(*)
          END::int AS capacity_total_units,
          (
            SELECT COUNT(*)
            FROM stock_serial_numbers ssn
            WHERE ssn.company_id = $1
              AND ssn.warehouse_id = w.id
              AND ssn.status IN ('IN_STOCK', 'RESERVED')
          )::int AS capacity_used_units
        FROM warehouse_zone_layouts zl
        WHERE zl.company_id = $1
          AND zl.warehouse_id = w.id
          AND zl.is_active = true
      ) cap ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'client_name', c.client_name,
              'units', m.units
            ) ORDER BY m.units DESC
          ),
          '[]'::json
        ) AS client_breakdown
        FROM (
          SELECT ssn.client_id, COUNT(*)::int AS units
          FROM stock_serial_numbers ssn
          WHERE ssn.company_id = $1
            AND ssn.warehouse_id = w.id
            AND ssn.status IN ('IN_STOCK', 'RESERVED')
          GROUP BY ssn.client_id
          ORDER BY COUNT(*) DESC
          LIMIT 4
        ) m
        JOIN clients c ON c.id = m.client_id
      ) client_mix ON true
      WHERE w.company_id = $1
    `
    params.push(session.companyId)

    if (isActive !== null) {
      params.push(isActive === "true")
      sql += ` AND w.is_active = $2`
    }

    sql += ` ORDER BY w.warehouse_name ASC`

    const result = await query(sql, params)

    return ok(result.rows)
  } catch (error: unknown) {
    console.error("Warehouses fetch error:", error)
    const message = error instanceof Error ? error.message : "Failed to fetch warehouses"
    return fail("SERVER_ERROR", message, 500)
  }
}

const latitudeSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().min(-90).max(90).optional()
)
const longitudeSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().min(-180).max(180).optional()
)

const warehouseSchema = z.object({
  warehouse_code: z.string().min(2),
  warehouse_name: z.string().min(2),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
})

const warehouseUpdateSchema = warehouseSchema.extend({
  id: z.number().positive(),
  is_active: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = warehouseSchema.parse(await request.json())
    const result = await query(
      `INSERT INTO warehouses (
        company_id, warehouse_code, warehouse_name, city, state, pincode, latitude, longitude, is_active
      )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING *`,
      [
        session.companyId,
        payload.warehouse_code,
        payload.warehouse_name,
        payload.city || null,
        payload.state || null,
        payload.pincode || null,
        payload.latitude ?? null,
        payload.longitude ?? null,
      ]
    )

    return ok(result.rows[0], "Warehouse created successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create warehouse"
    return fail("CREATE_FAILED", message, 400)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const payload = warehouseUpdateSchema.parse(await request.json())
    const result = await query(
      `UPDATE warehouses SET
        warehouse_code = $1,
        warehouse_name = $2,
        city = $3,
        state = $4,
        pincode = $5,
        latitude = $6,
        longitude = $7,
        is_active = $8
       WHERE id = $9 AND company_id = $10
       RETURNING *`,
      [
        payload.warehouse_code,
        payload.warehouse_name,
        payload.city || null,
        payload.state || null,
        payload.pincode || null,
        payload.latitude ?? null,
        payload.longitude ?? null,
        payload.is_active ?? true,
        payload.id,
        session.companyId,
      ]
    )

    return ok(result.rows[0], "Warehouse updated successfully")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update warehouse"
    return fail("UPDATE_FAILED", message, 400)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!id) return fail("VALIDATION_ERROR", "Warehouse id is required", 400)

    await query("UPDATE warehouses SET is_active = false WHERE id = $1 AND company_id = $2", [
      id,
      session.companyId,
    ])
    return ok({ id }, "Warehouse deactivated")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete warehouse"
    return fail("DELETE_FAILED", message, 400)
  }
}
