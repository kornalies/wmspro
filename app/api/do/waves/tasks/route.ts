import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireFeature, requirePolicyPermission } from "@/lib/policy/guards"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(session.companyId, session.userId, resolvePolicyActorType(session))
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { searchParams } = new URL(request.url)
    const waveId = Number(searchParams.get("wave_id") || 0)
    const status = searchParams.get("status")
    const mine = searchParams.get("mine") === "true"

    const where: string[] = ["t.company_id = $1"]
    const params: Array<string | number> = [session.companyId]
    let idx = 2
    if (waveId) {
      where.push(`t.wave_id = $${idx++}`)
      params.push(waveId)
    }
    if (status && ["QUEUED", "ASSIGNED", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) {
      where.push(`t.status = $${idx++}`)
      params.push(status)
    }
    if (mine) {
      where.push(`t.assigned_to = $${idx++}`)
      params.push(session.userId)
    }

    const result = await query(
      `SELECT
         t.id,
         t.wave_id,
         w.wave_number,
         t.do_header_id,
         dh.do_number,
         t.do_line_item_id,
         t.item_id,
         i.item_code,
         i.item_name,
         t.required_quantity,
         t.picked_quantity,
         t.status,
         t.assigned_to,
         u.full_name AS assigned_to_name,
         t.assigned_at,
         t.started_at,
         t.completed_at,
         t.created_at
       FROM do_pick_tasks t
       JOIN do_wave_header w ON w.id = t.wave_id AND w.company_id = t.company_id
       JOIN do_header dh ON dh.id = t.do_header_id AND dh.company_id = t.company_id
       JOIN items i ON i.id = t.item_id AND i.company_id = t.company_id
       LEFT JOIN users u ON u.id = t.assigned_to AND u.company_id = t.company_id
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE t.status
           WHEN 'IN_PROGRESS' THEN 1
           WHEN 'ASSIGNED' THEN 2
           WHEN 'QUEUED' THEN 3
           WHEN 'DONE' THEN 4
           ELSE 5
         END,
         t.id ASC
       LIMIT 500`,
      params
    )
    return ok(result.rows)
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch wave tasks"
    return fail("SERVER_ERROR", message, 500)
  }
}
