import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

const upsertSchema = z.object({
  client_id: z.number().positive(),
  billing_cycle: z.enum(["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  billing_day_of_week: z.number().int().min(1).max(7).optional().nullable(),
  billing_day_of_month: z.number().int().min(1).max(28).optional(),
  storage_billing_method: z.enum(["SNAPSHOT", "DURATION"]).optional(),
  storage_grace_days: z.number().int().min(0).optional(),
  credit_days: z.number().int().min(0).optional(),
  currency: z.string().min(3).max(10).optional(),
  invoice_prefix: z.string().min(2).max(20).optional(),
  minimum_billing_enabled: z.boolean().optional(),
  minimum_billing_amount: z.number().min(0).optional(),
  auto_finalize: z.boolean().optional(),
  is_active: z.boolean().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const clientId = Number(request.nextUrl.searchParams.get("client_id") || 0)
    const params: Array<number> = [session.companyId]
    const filter = clientId ? "AND cbp.client_id = $2" : ""
    if (clientId) params.push(clientId)

    const res = await query(
      `SELECT cbp.*, c.client_name, c.client_code
       FROM client_billing_profile cbp
       JOIN clients c
         ON c.id = cbp.client_id
        AND c.company_id = cbp.company_id
       WHERE cbp.company_id = $1
       ${filter}
       ORDER BY c.client_name`,
      params
    )
    return ok(res.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch billing profiles"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const payload = upsertSchema.parse(await request.json())

    const result = await query(
      `INSERT INTO client_billing_profile (
         company_id, client_id, billing_cycle, billing_day_of_week, billing_day_of_month,
         storage_billing_method, storage_grace_days, credit_days, currency, invoice_prefix,
         minimum_billing_enabled, minimum_billing_amount, auto_finalize, is_active, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15
       )
       ON CONFLICT (company_id, client_id)
       DO UPDATE SET
         billing_cycle = EXCLUDED.billing_cycle,
         billing_day_of_week = EXCLUDED.billing_day_of_week,
         billing_day_of_month = EXCLUDED.billing_day_of_month,
         storage_billing_method = EXCLUDED.storage_billing_method,
         storage_grace_days = EXCLUDED.storage_grace_days,
         credit_days = EXCLUDED.credit_days,
         currency = EXCLUDED.currency,
         invoice_prefix = EXCLUDED.invoice_prefix,
         minimum_billing_enabled = EXCLUDED.minimum_billing_enabled,
         minimum_billing_amount = EXCLUDED.minimum_billing_amount,
         auto_finalize = EXCLUDED.auto_finalize,
         is_active = EXCLUDED.is_active,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        session.companyId,
        payload.client_id,
        payload.billing_cycle || "MONTHLY",
        payload.billing_day_of_week ?? null,
        payload.billing_day_of_month ?? 1,
        payload.storage_billing_method || "SNAPSHOT",
        payload.storage_grace_days ?? 0,
        payload.credit_days ?? 30,
        (payload.currency || "INR").toUpperCase(),
        (payload.invoice_prefix || "INV").toUpperCase(),
        payload.minimum_billing_enabled ?? false,
        payload.minimum_billing_amount ?? 0,
        payload.auto_finalize ?? false,
        payload.is_active ?? true,
        session.userId,
      ]
    )

    return ok(result.rows[0], "Billing profile saved")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to save billing profile"
    return fail("UPDATE_FAILED", message, 400)
  }
}
