import { NextRequest } from "next/server"

import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { resolveAdapter } from "@/lib/wes/adapters"
import { assertTransition } from "@/lib/wes/state-machine"
import { getWesAccess } from "@/app/api/wes/_utils"

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getWesAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const queued = await db.query(
      `SELECT
         c.id,
         c.equipment_id,
         c.command_type,
         c.command_payload,
         c.attempt_count,
         c.max_attempts,
         e.equipment_code,
         e.adapter_type,
         e.status AS equipment_status,
         e.safety_mode
       FROM wes_command_queue c
       JOIN wes_equipment e ON e.id = c.equipment_id AND e.company_id = c.company_id
       WHERE c.company_id = $1
         AND c.status IN ('QUEUED', 'RETRY')
         AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= NOW())
       ORDER BY c.priority ASC, c.created_at ASC
       LIMIT 100`,
      [access.companyId]
    )

    let done = 0
    let retried = 0
    let deadLetter = 0
    let blocked = 0

    for (const row of queued.rows as Array<{
      id: number
      equipment_id: number
      command_type: string
      command_payload: Record<string, unknown>
      attempt_count: number
      max_attempts: number
      equipment_code: string
      adapter_type: string
      equipment_status: string
      safety_mode: boolean
    }>) {
      if (row.safety_mode) {
        blocked += 1
        continue
      }

      if (["FAULT", "ESTOP", "OFFLINE"].includes(String(row.equipment_status))) {
        await db.query(
          `UPDATE wes_command_queue
           SET status = 'DEAD_LETTER',
               last_error = $1,
               updated_at = NOW()
           WHERE company_id = $2 AND id = $3`,
          [`Equipment state ${row.equipment_status} blocks execution`, access.companyId, row.id]
        )
        await db.query(
          `INSERT INTO wes_failover_incidents (
             company_id, equipment_id, command_id, incident_type, severity, status, reason, context
           ) VALUES ($1,$2,$3,'STATE_MACHINE_GUARD','HIGH','OPEN',$4,$5::jsonb)`,
          [
            access.companyId,
            row.equipment_id,
            row.id,
            `Command blocked in equipment state ${row.equipment_status}`,
            JSON.stringify({ equipment_status: row.equipment_status }),
          ]
        )
        deadLetter += 1
        continue
      }

      const adapter = resolveAdapter(row.adapter_type)
      const result = await adapter.dispatch({
        commandType: row.command_type,
        payload: row.command_payload || {},
        equipmentCode: row.equipment_code,
      })

      const nextAttempt = Number(row.attempt_count || 0) + 1
      if (result.accepted) {
        const nextState = row.command_type === "CHARGE" ? "CHARGING" : "BUSY"
        const transition = assertTransition(row.equipment_status as never, nextState as never)
        const targetState = transition.ok ? nextState : "FAULT"
        await db.query(
          `UPDATE wes_command_queue
           SET status = 'DONE',
               attempt_count = $1,
               dispatched_at = NOW(),
               acknowledged_at = NOW(),
               completed_at = NOW(),
               last_error = NULL,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [nextAttempt, access.companyId, row.id]
        )
        await db.query(
          `UPDATE wes_equipment
           SET status = $1,
               last_error = NULL,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [targetState, access.companyId, row.equipment_id]
        )
        await db.query(
          `INSERT INTO wes_event_log (company_id, equipment_id, command_id, event_type, event_payload, source_type, source_ref)
           VALUES ($1,$2,$3,'COMMAND_DONE',$4::jsonb,'ADAPTER',$5)`,
          [
            access.companyId,
            row.equipment_id,
            row.id,
            JSON.stringify({ adapter_ref: result.adapterRef || null }),
            result.adapterRef || "adapter.ok",
          ]
        )
        done += 1
      } else if (nextAttempt >= Number(row.max_attempts || 3)) {
        await db.query(
          `UPDATE wes_command_queue
           SET status = 'DEAD_LETTER',
               attempt_count = $1,
               last_error = $2,
               updated_at = NOW()
           WHERE company_id = $3
             AND id = $4`,
          [nextAttempt, result.error || "Adapter failed", access.companyId, row.id]
        )
        await db.query(
          `UPDATE wes_equipment
           SET status = 'FAULT',
               safety_mode = true,
               last_error = $1,
               updated_at = NOW()
           WHERE company_id = $2
             AND id = $3`,
          [result.error || "Command retry exhausted", access.companyId, row.equipment_id]
        )
        await db.query(
          `INSERT INTO wes_failover_incidents (
             company_id, equipment_id, command_id, incident_type, severity, status, reason, context
           ) VALUES ($1,$2,$3,'COMMAND_RETRY_EXHAUSTED','CRITICAL','OPEN',$4,$5::jsonb)`,
          [
            access.companyId,
            row.equipment_id,
            row.id,
            result.error || "Adapter dispatch failed repeatedly",
            JSON.stringify({ attempt_count: nextAttempt, max_attempts: row.max_attempts }),
          ]
        )
        await db.query(
          `INSERT INTO wes_event_log (company_id, equipment_id, command_id, event_type, event_payload, source_type, source_ref)
           VALUES ($1,$2,$3,'FAILOVER',$4::jsonb,'SYSTEM','command.retry.exhausted')`,
          [
            access.companyId,
            row.equipment_id,
            row.id,
            JSON.stringify({ reason: result.error || "retry exhausted" }),
          ]
        )
        deadLetter += 1
      } else {
        await db.query(
          `UPDATE wes_command_queue
           SET status = 'RETRY',
               attempt_count = $1,
               next_attempt_at = NOW() + (($4::text || ' seconds')::interval),
               last_error = $2,
               updated_at = NOW()
           WHERE company_id = $3
             AND id = $5`,
          [nextAttempt, result.error || "Adapter failed", access.companyId, String(15 * nextAttempt), row.id]
        )
        await db.query(
          `INSERT INTO wes_event_log (company_id, equipment_id, command_id, event_type, event_payload, source_type, source_ref)
           VALUES ($1,$2,$3,'COMMAND_FAILED',$4::jsonb,'ADAPTER','command.retry')`,
          [
            access.companyId,
            row.equipment_id,
            row.id,
            JSON.stringify({ reason: result.error || "adapter failed", attempt_count: nextAttempt }),
          ]
        )
        retried += 1
      }
    }

    await db.query(
      `WITH stale AS (
         SELECT id, equipment_code
         FROM wes_equipment
         WHERE company_id = $1
           AND COALESCE(safety_mode, false) = false
           AND (last_heartbeat_at IS NULL OR last_heartbeat_at < NOW() - ((heartbeat_timeout_seconds || ' seconds')::interval))
       )
       UPDATE wes_equipment e
       SET status = 'OFFLINE',
           last_error = 'Heartbeat timeout',
           updated_at = NOW()
       FROM stale s
       WHERE e.id = s.id
         AND e.company_id = $1`,
      [access.companyId]
    )

    await db.query(
      `INSERT INTO wes_failover_incidents (
         company_id, equipment_id, incident_type, severity, status, reason, context
       )
       SELECT
         $1,
         e.id,
         'HEARTBEAT_TIMEOUT',
         'HIGH',
         'OPEN',
         'Heartbeat timeout detected by safety scan',
         jsonb_build_object('equipment_code', e.equipment_code, 'last_heartbeat_at', e.last_heartbeat_at)
       FROM wes_equipment e
       WHERE e.company_id = $1
         AND e.status = 'OFFLINE'
         AND (e.last_heartbeat_at IS NULL OR e.last_heartbeat_at < NOW() - ((e.heartbeat_timeout_seconds || ' seconds')::interval))
         AND NOT EXISTS (
           SELECT 1
           FROM wes_failover_incidents i
           WHERE i.company_id = e.company_id
             AND i.equipment_id = e.id
             AND i.incident_type = 'HEARTBEAT_TIMEOUT'
             AND i.status IN ('OPEN', 'ACKNOWLEDGED')
         )`,
      [access.companyId]
    )

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "wes.processor.run",
        entityType: "wes_command_queue",
        after: {
          processed: queued.rows.length,
          done,
          retried,
          dead_letter: deadLetter,
          blocked,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({
      processed: queued.rows.length,
      done,
      retried,
      dead_letter: deadLetter,
      blocked,
    })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to process WES queue"
    return fail("PROCESS_FAILED", message, 400)
  } finally {
    db.release()
  }
}
