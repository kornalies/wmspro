import { z } from "zod"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

import {
  hasPortalFeaturePermission,
  hasPortalPermission,
  parseAndAuthorizeClientId,
} from "@/app/api/portal/_utils"

const slaSchema = z.object({
  client_id: z.number().int().positive(),
  dispatch_target_hours: z.number().positive().max(720).default(48),
  invoice_approval_due_days: z.number().int().min(0).max(60).default(5),
  dispute_resolution_hours: z.number().positive().max(720).default(72),
  warning_threshold_pct: z.number().positive().max(200).default(90),
})

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.sla.view"))) {
      return fail("FORBIDDEN", "No portal SLA view permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }

    const [policy, kpi] = await Promise.all([
      query(
        `SELECT
           id,
           client_id,
           dispatch_target_hours::float8 AS dispatch_target_hours,
           invoice_approval_due_days,
           dispute_resolution_hours::float8 AS dispute_resolution_hours,
           warning_threshold_pct::float8 AS warning_threshold_pct,
           is_active,
           updated_at
         FROM portal_client_sla_policies
         WHERE company_id = $1
           AND client_id = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [session.companyId, clientIdCheck.clientId]
      ),
      query(
        `WITH cfg AS (
           SELECT
             COALESCE(dispatch_target_hours, 48)::numeric AS dispatch_target_hours,
             COALESCE(dispute_resolution_hours, 72)::numeric AS dispute_resolution_hours
           FROM portal_client_sla_policies
           WHERE company_id = $1
             AND client_id = $2
             AND is_active = true
           ORDER BY updated_at DESC
           LIMIT 1
         ),
         ord AS (
           SELECT
             COUNT(*)::int AS total_orders_90d,
             COUNT(*) FILTER (
               WHERE dispatch_date IS NOT NULL
                 AND dispatch_date <= request_date::timestamp + ((SELECT dispatch_target_hours FROM cfg) || ' hours')::interval
             )::int AS on_time_orders_90d
           FROM do_header
           WHERE company_id = $1
             AND client_id = $2
             AND request_date >= CURRENT_DATE - INTERVAL '90 days'
         ),
         dsp AS (
           SELECT
             COUNT(*)::int AS resolved_disputes_90d,
             COUNT(*) FILTER (
               WHERE resolved_at IS NOT NULL
                 AND resolved_at <= raised_at + ((SELECT dispute_resolution_hours FROM cfg) || ' hours')::interval
             )::int AS in_sla_disputes_90d
           FROM portal_invoice_disputes
           WHERE company_id = $1
             AND client_id = $2
             AND raised_at >= CURRENT_DATE - INTERVAL '90 days'
             AND status IN ('RESOLVED', 'CLOSED', 'REJECTED')
         )
         SELECT
           ord.total_orders_90d,
           ord.on_time_orders_90d,
           CASE
             WHEN ord.total_orders_90d = 0 THEN 100
             ELSE ROUND((ord.on_time_orders_90d::numeric / ord.total_orders_90d::numeric) * 100, 2)
           END::float8 AS order_on_time_pct,
           dsp.resolved_disputes_90d,
           dsp.in_sla_disputes_90d,
           CASE
             WHEN dsp.resolved_disputes_90d = 0 THEN 100
             ELSE ROUND((dsp.in_sla_disputes_90d::numeric / dsp.resolved_disputes_90d::numeric) * 100, 2)
           END::float8 AS dispute_sla_pct
         FROM ord, dsp`,
        [session.companyId, clientIdCheck.clientId]
      ),
    ])

    return ok({
      policy:
        policy.rows[0] || {
          client_id: clientIdCheck.clientId,
          dispatch_target_hours: 48,
          invoice_approval_due_days: 5,
          dispute_resolution_hours: 72,
          warning_threshold_pct: 90,
          is_active: true,
        },
      kpi: kpi.rows[0] || {},
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch SLA policy"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: Request) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!(await hasPortalFeaturePermission(session, "portal.sla.manage"))) {
      return fail("FORBIDDEN", "No portal SLA manage permission", 403)
    }

    const canManage =
      (await hasPortalPermission(session, "portal.sla.manage")) ||
      session.role === "ADMIN" ||
      session.role === "SUPER_ADMIN"
    if (!canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = slaSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const result = await db.query(
      `INSERT INTO portal_client_sla_policies (
         company_id,
         client_id,
         dispatch_target_hours,
         invoice_approval_due_days,
         dispute_resolution_hours,
         warning_threshold_pct,
         is_active,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)
       ON CONFLICT (company_id, client_id)
       DO UPDATE SET
         dispatch_target_hours = EXCLUDED.dispatch_target_hours,
         invoice_approval_due_days = EXCLUDED.invoice_approval_due_days,
         dispute_resolution_hours = EXCLUDED.dispute_resolution_hours,
         warning_threshold_pct = EXCLUDED.warning_threshold_pct,
         is_active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        session.companyId,
        payload.client_id,
        payload.dispatch_target_hours,
        payload.invoice_approval_due_days,
        payload.dispute_resolution_hours,
        payload.warning_threshold_pct,
        session.userId,
      ]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "portal.sla.upsert",
        entityType: "portal_client_sla_policies",
        entityId: String(result.rows[0].id),
        after: result.rows[0],
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(result.rows[0], "SLA policy saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save SLA policy"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
