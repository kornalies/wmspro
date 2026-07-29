import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { ensureZoneLayoutSchema } from "@/lib/db-bootstrap"
import { ensureWarehouseZone } from "@/lib/warehouse-zones"
import { BIN_STATUSES, DEFAULT_BIN_STATUS, DEFAULT_ZONE_TYPE, ZONE_TYPES } from "@/lib/zone-layouts"
import {
  LocationGeneratorError,
  countGeneratedBins,
  describeGeometry,
  generateBins,
} from "@/lib/location-generator"

/**
 * Generate a zone's bins from rack geometry.
 *
 * `dry_run` is the point of this endpoint as much as the insert is. Generating a
 * thousand bins with a wrong prefix is tedious to undo — bins get referenced by
 * stock the moment anyone puts something away — so an onboarder previews the
 * codes, then commits the same spec.
 */

const axisSchema = z.object({
  prefix: z.string().trim().max(20).default(""),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  pad: z.number().int().min(0).max(10).optional(),
})

const generateSchema = z.object({
  warehouse_id: z.number().positive(),
  zone_code: z.string().trim().min(1).max(30),
  zone_name: z.string().trim().min(1).max(100),
  zone_type: z.enum(ZONE_TYPES).default(DEFAULT_ZONE_TYPE),
  bin_status: z.enum(BIN_STATUSES).default(DEFAULT_BIN_STATUS),
  capacity_units: z.number().int().nonnegative().optional(),
  racks: axisSchema,
  levels: axisSchema.nullish(),
  bins: axisSchema,
  bin_separator: z.string().trim().max(3).optional(),
  dry_run: z.boolean().default(false),
})

export async function POST(request: NextRequest) {
  await ensureZoneLayoutSchema()
  const session = await getSession()
  if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
  requirePermission(session, "master.data.manage")

  const client = await getClient()
  try {
    const payload = generateSchema.parse(await request.json())
    const zoneCode = payload.zone_code.toUpperCase()

    const spec = {
      zoneCode,
      racks: payload.racks,
      levels: payload.levels ?? null,
      bins: payload.bins,
      binSeparator: payload.bin_separator,
    }

    // Validate and expand before opening a transaction: a bad spec should cost
    // nothing, and countGeneratedBins throws the same validation errors.
    const total = countGeneratedBins(spec)
    const bins = generateBins(spec)

    if (payload.dry_run) {
      return ok(
        {
          dry_run: true,
          total,
          summary: describeGeometry(spec),
          // Enough to see the shape at both ends without shipping 5000 rows to
          // a browser that only needs to confirm the naming looks right.
          preview: bins.slice(0, 20).map((b) => ({
            rack_code: b.rackCode,
            bin_code: b.binCode,
            bin_name: b.binName,
          })),
          preview_tail: bins.length > 20 ? bins.slice(-3).map((b) => `${b.rackCode}/${b.binCode}`) : [],
        },
        `${describeGeometry(spec)} — nothing written`
      )
    }

    await client.query("BEGIN")
    await setTenantContext(client, session.companyId)

    const warehouseZoneId = await ensureWarehouseZone(client, {
      companyId: session.companyId,
      warehouseId: payload.warehouse_id,
      zoneCode,
      zoneName: payload.zone_name,
      zoneType: payload.zone_type,
    })

    // One multi-row INSERT rather than a statement per bin: at 5000 bins the
    // per-statement round trip dominates, and the whole generation has to be one
    // transaction anyway so a half-created zone is impossible.
    const values: unknown[] = []
    const tuples: string[] = []
    for (const bin of bins) {
      const base = values.length
      values.push(
        payload.warehouse_id,
        zoneCode,
        payload.zone_name,
        payload.zone_type,
        bin.rackCode,
        bin.rackName,
        bin.binCode,
        bin.binName,
        payload.bin_status,
        payload.capacity_units ?? null,
        bin.sortOrder,
        warehouseZoneId
      )
      tuples.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
          `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},'{}'::jsonb,true)`
      )
    }

    const inserted = await client.query(
      `INSERT INTO warehouse_zone_layouts (
         warehouse_id, zone_code, zone_name, zone_type, rack_code, rack_name,
         bin_code, bin_name, bin_status, capacity_units, sort_order,
         warehouse_zone_id, attributes, is_active
       ) VALUES ${tuples.join(",")}
       ON CONFLICT (warehouse_id, zone_code, rack_code, bin_code) DO NOTHING`,
      values
    )

    const created = inserted.rowCount ?? 0
    const skipped = bins.length - created

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "master.zone_layout.generate",
        entityType: "warehouse_zone_layouts",
        entityId: `${payload.warehouse_id}:${zoneCode}`,
        after: { zone_code: zoneCode, requested: bins.length, created, skipped },
        req: request,
      },
      client
    )

    await client.query("COMMIT")
    return ok(
      { created, skipped, total: bins.length, summary: describeGeometry(spec) },
      skipped
        ? `${created} bin(s) created, ${skipped} already existed`
        : `${created} bin(s) created`
    )
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => {})
    if (error instanceof LocationGeneratorError) {
      return fail(error.code, error.message, error.code === "TOO_MANY_BINS" ? 409 : 400)
    }
    const message = error instanceof Error ? error.message : "Failed to generate locations"
    return fail("GENERATE_FAILED", message, 400)
  } finally {
    client.release()
  }
}