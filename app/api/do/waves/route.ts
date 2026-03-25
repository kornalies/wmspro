import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, query, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { DO_WAVE_STATUSES } from "@/lib/do-wave"
import { getIdempotentResponse, saveIdempotentResponse } from "@/lib/idempotency"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission, requireScope } from "@/lib/policy/guards"

const createWaveSchema = z.object({
  warehouse_id: z.number().int().positive(),
  client_id: z.number().int().positive().optional(),
  strategy: z.enum(["BATCH", "CLUSTER"]).default("BATCH"),
  max_orders: z.number().int().positive().max(200).default(20),
  do_ids: z.array(z.number().int().positive()).optional(),
})

type EligibleRow = {
  id: number
  do_number: string
  warehouse_id: number
  client_id: number
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(session.companyId, session.userId, resolvePolicyActorType(session))
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const warehouseId = Number(searchParams.get("warehouse_id") || 0)
    const where: string[] = ["w.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2

    if (status && DO_WAVE_STATUSES.includes(status as (typeof DO_WAVE_STATUSES)[number])) {
      where.push(`w.status = $${idx++}`)
      params.push(status)
    }
    if (warehouseId) {
      where.push(`w.warehouse_id = $${idx++}`)
      params.push(warehouseId)
      requireScope(policy, "warehouse", warehouseId)
    }

    const result = await query(
      `SELECT
         w.id,
         w.wave_number,
         w.warehouse_id,
         wh.warehouse_name,
         w.client_id,
         c.client_name,
         w.strategy,
         w.status,
         w.total_orders,
         w.total_tasks,
         w.created_at,
         w.released_at,
         w.started_at,
         w.completed_at
       FROM do_wave_header w
       JOIN warehouses wh ON wh.id = w.warehouse_id AND wh.company_id = w.company_id
       LEFT JOIN clients c ON c.id = w.client_id AND c.company_id = w.company_id
       WHERE ${where.join(" AND ")}
       ORDER BY w.id DESC
       LIMIT 200`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch waves"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(session.companyId, session.userId, resolvePolicyActorType(session))
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const payload = createWaveSchema.parse(await request.json())
    requireScope(policy, "warehouse", payload.warehouse_id)
    if (payload.client_id) requireScope(policy, "client", payload.client_id)

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim()
    const doKeySource = (payload.do_ids || []).slice().sort((a, b) => a - b).join(",") || "auto"
    const doKeyCompact = doKeySource.length > 80 ? `${doKeySource.slice(0, 80)}#${doKeySource.length}` : doKeySource
    const routeKey = `do.waves.create:${payload.warehouse_id}:${payload.client_id || "all"}:${payload.strategy}:${doKeyCompact}`
    if (idempotencyKey) {
      const cached = await getIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
      })
      if (cached) return ok(cached.body as Record<string, unknown>, "Idempotent replay")
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const year = new Date().getFullYear()
    const seq = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(wave_number FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
       FROM do_wave_header
       WHERE company_id = $1
         AND wave_number LIKE 'WAVE-${year}-%'`,
      [session.companyId]
    )
    const waveNumber = `WAVE-${year}-${String(seq.rows[0]?.next_seq || 1).padStart(6, "0")}`

    const eligibleParams: Array<number | number[]> = [session.companyId, payload.warehouse_id]
    let sql = `
      SELECT dh.id, dh.do_number, dh.warehouse_id, dh.client_id
      FROM do_header dh
      WHERE dh.company_id = $1
        AND dh.warehouse_id = $2
        AND dh.status IN ('DRAFT','PENDING','PICKED')
        AND EXISTS (
          SELECT 1
          FROM do_line_items dli
          WHERE dli.company_id = dh.company_id
            AND dli.do_header_id = dh.id
            AND (dli.quantity_requested - dli.quantity_dispatched) > 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM do_wave_orders wo
          JOIN do_wave_header wh ON wh.id = wo.wave_id AND wh.company_id = wo.company_id
          WHERE wo.company_id = dh.company_id
            AND wo.do_header_id = dh.id
            AND wh.status IN ('DRAFT','RELEASED','IN_PROGRESS')
        )
    `

    if (payload.client_id) {
      sql += ` AND dh.client_id = $3`
      eligibleParams.push(payload.client_id)
    }
    if (payload.do_ids?.length) {
      sql += ` AND dh.id = ANY($${eligibleParams.length + 1}::int[])`
      eligibleParams.push(payload.do_ids)
    }
    sql += ` ORDER BY dh.request_date ASC, dh.id ASC LIMIT ${payload.max_orders}`

    const eligible = await db.query(sql, eligibleParams)
    const rows = eligible.rows as EligibleRow[]
    if (!rows.length) {
      await db.query("ROLLBACK")
      return fail("NO_ELIGIBLE_ORDERS", "No eligible delivery orders available to create wave", 400)
    }

    const header = await db.query(
      `INSERT INTO do_wave_header (
         company_id, wave_number, warehouse_id, client_id, strategy, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6)
       RETURNING id, wave_number, status`,
      [
        session.companyId,
        waveNumber,
        payload.warehouse_id,
        payload.client_id ?? null,
        payload.strategy,
        session.userId,
      ]
    )

    const waveId = Number(header.rows[0].id)
    let taskCount = 0

    for (let i = 0; i < rows.length; i += 1) {
      const doRow = rows[i]
      await db.query(
        `INSERT INTO do_wave_orders (
           company_id, wave_id, do_header_id, pick_sequence, status
         ) VALUES ($1, $2, $3, $4, 'QUEUED')`,
        [session.companyId, waveId, doRow.id, i + 1]
      )

      const lines = await db.query(
        `SELECT id, item_id, (quantity_requested - quantity_dispatched) AS remaining_qty
         FROM do_line_items
         WHERE company_id = $1
           AND do_header_id = $2
           AND (quantity_requested - quantity_dispatched) > 0
         ORDER BY line_number ASC, id ASC`,
        [session.companyId, doRow.id]
      )

      for (const line of lines.rows as Array<{ id: number; item_id: number; remaining_qty: number }>) {
        await db.query(
          `INSERT INTO do_pick_tasks (
             company_id, wave_id, do_header_id, do_line_item_id, item_id, warehouse_id, client_id,
             task_type, status, required_quantity, picked_quantity
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PICK', 'QUEUED', $8, 0)`,
          [
            session.companyId,
            waveId,
            doRow.id,
            line.id,
            line.item_id,
            doRow.warehouse_id,
            doRow.client_id,
            Number(line.remaining_qty),
          ]
        )
        taskCount += 1
      }

      await db.query(
        `UPDATE do_header
         SET status = CASE WHEN status = 'DRAFT' THEN 'PENDING' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $1
           AND id = $2`,
        [session.companyId, doRow.id]
      )
    }

    await db.query(
      `UPDATE do_wave_header
       SET total_orders = $1,
           total_tasks = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $3
         AND id = $4`,
      [rows.length, taskCount, session.companyId, waveId]
    )

    const responseBody = {
      id: waveId,
      wave_number: String(header.rows[0].wave_number),
      status: String(header.rows[0].status),
      total_orders: rows.length,
      total_tasks: taskCount,
    }
    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.wave.create",
        entityType: "do_wave_header",
        entityId: String(waveId),
        after: responseBody,
        req: request,
      },
      db
    )
    await db.query("COMMIT")
    if (idempotencyKey) {
      await saveIdempotentResponse({
        companyId: session.companyId,
        key: idempotencyKey,
        routeKey,
        responseBody,
      })
    }
    return ok(responseBody, "Wave created successfully")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to create wave"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
