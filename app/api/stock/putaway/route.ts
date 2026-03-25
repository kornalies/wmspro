import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { ensurePutawayMovementSchema } from "@/lib/db-bootstrap"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

const putawaySchema = z.object({
  stock_ids: z.array(z.number().positive()).min(1),
  to_zone_layout_id: z.number().positive(),
  remarks: z.string().max(500).optional(),
})

function ensureStockPermission(policy: Awaited<ReturnType<typeof getEffectivePolicy>>) {
  if (
    policy.permissions.includes("stock.adjust") ||
    policy.permissions.includes("stock.putaway.manage")
  ) {
    return
  }
  requirePolicyPermission(policy, "stock.adjust")
}

export async function GET(request: NextRequest) {
  try {
    await ensurePutawayMovementSchema()
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")
    ensureStockPermission(policy)

    const { searchParams } = new URL(request.url)
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    if (!warehouseId) return fail("VALIDATION_ERROR", "warehouse_id is required", 400)
    requireScope(policy, "warehouse", warehouseId)

    const serial = searchParams.get("serial")?.trim()
    const item = searchParams.get("item")?.trim()
    const fromZoneLayoutId = Number(searchParams.get("from_zone_layout_id") || 0)

    const where: string[] = ["ssn.warehouse_id = $1", "ssn.status = 'IN_STOCK'"]
    const params: Array<string | number> = [warehouseId]
    let idx = 2

    if (serial) {
      where.push(`ssn.serial_number ILIKE $${idx++}`)
      params.push(`%${serial}%`)
    }
    if (item) {
      where.push(`(i.item_code ILIKE $${idx} OR i.item_name ILIKE $${idx})`)
      params.push(`%${item}%`)
      idx++
    }
    if (fromZoneLayoutId) {
      where.push(`ssn.zone_layout_id = $${idx++}`)
      params.push(fromZoneLayoutId)
    }

    const result = await query(
      `SELECT
        ssn.id,
        ssn.serial_number,
        ssn.received_date,
        i.item_code,
        i.item_name,
        ssn.zone_layout_id,
        COALESCE(ssn.bin_location, CONCAT(zl.zone_code, '/', zl.rack_code, '/', zl.bin_code), 'Unassigned') AS current_bin_location
      FROM stock_serial_numbers ssn
      JOIN items i ON i.id = ssn.item_id
      LEFT JOIN warehouse_zone_layouts zl ON zl.id = ssn.zone_layout_id
      WHERE ${where.join(" AND ")}
      ORDER BY ssn.received_date ASC, ssn.id ASC
      LIMIT 300`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch put-away stock"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const dbClient = await getClient()
  try {
    await ensurePutawayMovementSchema(dbClient)
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "stock.putaway.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "stock")
    ensureStockPermission(policy)

    const payload = putawaySchema.parse(await request.json())
    await dbClient.query("BEGIN")
    await setTenantContext(dbClient, session.companyId)

    const targetZone = await dbClient.query(
      `SELECT id, warehouse_id, zone_code, rack_code, bin_code
       FROM warehouse_zone_layouts
       WHERE id = $1 AND is_active = true`,
      [payload.to_zone_layout_id]
    )
    if (!targetZone.rows.length) {
      await dbClient.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Target bin is invalid", 400)
    }

    const target = targetZone.rows[0]
    requireScope(policy, "warehouse", target.warehouse_id)
    const toBinLocation = `${target.zone_code}/${target.rack_code}/${target.bin_code}`

    const movedRows: Array<{ stock_id: number; serial_number: string }> = []
    for (const stockId of payload.stock_ids) {
      const stockResult = await dbClient.query(
        `SELECT id, serial_number, item_id, warehouse_id, zone_layout_id, bin_location
         FROM stock_serial_numbers
         WHERE id = $1
           AND status = 'IN_STOCK'
         FOR UPDATE`,
        [stockId]
      )

      if (!stockResult.rows.length) {
        continue
      }

      const stock = stockResult.rows[0]
      if (Number(stock.warehouse_id) !== Number(target.warehouse_id)) {
        await dbClient.query("ROLLBACK")
        return fail("VALIDATION_ERROR", "Source and destination bins must be in same warehouse", 400)
      }

      const fromZoneLayoutId = stock.zone_layout_id ? Number(stock.zone_layout_id) : null
      const fromBinLocation = stock.bin_location || null

      await dbClient.query(
        `UPDATE stock_serial_numbers
         SET zone_layout_id = $1, bin_location = $2
         WHERE id = $3`,
        [target.id, toBinLocation, stock.id]
      )

      await dbClient.query(
        `INSERT INTO stock_putaway_movements (
          stock_serial_id, serial_number, item_id, warehouse_id,
          from_zone_layout_id, to_zone_layout_id, from_bin_location, to_bin_location,
          remarks, moved_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          stock.id,
          stock.serial_number,
          stock.item_id,
          stock.warehouse_id,
          fromZoneLayoutId,
          target.id,
          fromBinLocation,
          toBinLocation,
          payload.remarks || null,
          session.userId,
        ]
      )

      movedRows.push({ stock_id: stock.id, serial_number: stock.serial_number })
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "stock.adjust",
        entityType: "stock_putaway_movements",
        entityId: movedRows.map((m) => m.stock_id).join(","),
        after: {
          moved_count: movedRows.length,
          to_zone_layout_id: target.id,
          to_bin_location: toBinLocation,
        },
        req: request,
      },
      dbClient
    )

    await dbClient.query("COMMIT")
    return ok(
      {
        moved_count: movedRows.length,
        to_bin_location: toBinLocation,
        moved_rows: movedRows,
      },
      "Put-away transfer completed"
    )
  } catch (error: unknown) {
    await dbClient.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to complete put-away transfer"
    return fail("TRANSFER_FAILED", message, 400)
  } finally {
    dbClient.release()
  }
}
