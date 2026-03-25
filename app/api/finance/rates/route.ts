import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"

const detailSchema = z.object({
  id: z.number().positive().optional(),
  charge_type: z.enum(["INBOUND_HANDLING", "OUTBOUND_HANDLING", "STORAGE", "VAS", "FIXED", "MINIMUM"]),
  calc_method: z.enum(["FLAT", "PER_UNIT", "SLAB", "PERCENT"]).optional(),
  slab_mode: z.enum(["ABSOLUTE", "MARGINAL"]).optional(),
  item_id: z.number().int().positive().optional().nullable(),
  uom: z.string().min(1).max(20).optional(),
  min_qty: z.number().min(0).optional().nullable(),
  max_qty: z.number().min(0).optional().nullable(),
  free_qty: z.number().min(0).optional(),
  unit_rate: z.number().min(0),
  min_charge: z.number().min(0).optional(),
  max_charge: z.number().min(0).optional().nullable(),
  tax_code: z.string().min(1).max(30).optional(),
  gst_rate: z.number().min(0).optional(),
  is_active: z.boolean().optional(),
})

const payloadSchema = z.object({
  id: z.number().positive().optional(),
  client_id: z.number().positive(),
  rate_card_code: z.string().min(2).max(50),
  rate_card_name: z.string().min(2).max(120),
  effective_from: z.string().min(10),
  effective_to: z.string().optional().nullable(),
  billing_cycle: z.enum(["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  currency: z.string().min(3).max(10).optional(),
  tax_inclusive: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
  details: z.array(detailSchema).min(1),
})

type RateMasterRow = Record<string, unknown> & { id: number }

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const clientId = Number(request.nextUrl.searchParams.get("client_id") || 0)
    const params: Array<number> = [session.companyId]
    const where = clientId ? "AND crm.client_id = $2" : ""
    if (clientId) params.push(clientId)

    const result = await getClient()
    try {
      await result.query("BEGIN")
      await setTenantContext(result, session.companyId)
      const masters = await result.query(
        `SELECT crm.*, c.client_name, c.client_code
         FROM client_rate_master crm
         JOIN clients c
           ON c.id = crm.client_id
          AND c.company_id = crm.company_id
         WHERE crm.company_id = $1
         ${where}
         ORDER BY crm.client_id, crm.priority ASC, crm.effective_from DESC`,
        params
      )

      const data: Array<Record<string, unknown>> = []
      for (const master of masters.rows as RateMasterRow[]) {
        const details = await result.query(
          `SELECT *
           FROM client_rate_details
           WHERE company_id = $1
             AND rate_master_id = $2
           ORDER BY charge_type, min_qty NULLS FIRST, id`,
          [session.companyId, master.id]
        )
        data.push({
          ...master,
          details: details.rows,
        })
      }
      await result.query("COMMIT")
      return ok(data)
    } catch (error) {
      await result.query("ROLLBACK")
      throw error
    } finally {
      result.release()
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch rates"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const payload = payloadSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const masterRes = await db.query(
      `INSERT INTO client_rate_master (
         company_id, client_id, rate_card_code, rate_card_name, effective_from, effective_to, billing_cycle,
         currency, tax_inclusive, priority, is_active, notes, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$13
       ) RETURNING *`,
      [
        session.companyId,
        payload.client_id,
        payload.rate_card_code.toUpperCase(),
        payload.rate_card_name,
        payload.effective_from,
        payload.effective_to || null,
        payload.billing_cycle || "MONTHLY",
        (payload.currency || "INR").toUpperCase(),
        payload.tax_inclusive ?? false,
        payload.priority ?? 100,
        payload.is_active ?? true,
        payload.notes || null,
        session.userId,
      ]
    )
    const master = masterRes.rows[0] as RateMasterRow

    for (const detail of payload.details) {
      await db.query(
        `INSERT INTO client_rate_details (
           company_id, rate_master_id, charge_type, calc_method, slab_mode, item_id, uom, min_qty, max_qty, free_qty, unit_rate,
           min_charge, max_charge, tax_code, gst_rate, is_active, created_by, updated_by
           ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17
           )`,
        [
          session.companyId,
          master.id,
          detail.charge_type,
          detail.calc_method || "PER_UNIT",
          detail.slab_mode || "ABSOLUTE",
          detail.item_id ?? null,
          detail.uom || "UNIT",
          detail.min_qty ?? null,
          detail.max_qty ?? null,
          detail.free_qty ?? 0,
          detail.unit_rate,
          detail.min_charge ?? 0,
          detail.max_charge ?? null,
          detail.tax_code || "GST",
          detail.gst_rate ?? 18,
          detail.is_active ?? true,
          session.userId,
        ]
      )
    }

    await db.query("COMMIT")
    return ok(master, "Rate card created")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to create rate card"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function PUT(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const payload = payloadSchema.parse(await request.json())
    if (!payload.id) return fail("VALIDATION_ERROR", "Rate card id is required", 400)

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const masterRes = await db.query(
      `UPDATE client_rate_master
       SET client_id = $1,
           rate_card_code = $2,
           rate_card_name = $3,
           effective_from = $4::date,
           effective_to = $5::date,
           billing_cycle = $6,
           currency = $7,
           tax_inclusive = $8,
           priority = $9,
           is_active = $10,
           notes = $11,
           updated_by = $12,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $13
         AND id = $14
       RETURNING *`,
      [
        payload.client_id,
        payload.rate_card_code.toUpperCase(),
        payload.rate_card_name,
        payload.effective_from,
        payload.effective_to || null,
        payload.billing_cycle || "MONTHLY",
        (payload.currency || "INR").toUpperCase(),
        payload.tax_inclusive ?? false,
        payload.priority ?? 100,
        payload.is_active ?? true,
        payload.notes || null,
        session.userId,
        session.companyId,
        payload.id,
      ]
    )
    if (!masterRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Rate card not found", 404)
    }

    const existingDetailsRes = await db.query(
      `SELECT id
       FROM client_rate_details
       WHERE company_id = $1
         AND rate_master_id = $2`,
      [session.companyId, payload.id]
    )
    const existingIds = (existingDetailsRes.rows as Array<{ id: number | string }>)
      .map((row) => Number(row.id))
      .filter((id) => id > 0)
    const existingIdSet = new Set(existingIds)

    const payloadDetailIds = payload.details
      .map((detail) => Number(detail.id || 0))
      .filter((id) => id > 0)
    const payloadDetailIdSet = new Set(payloadDetailIds)
    if (payloadDetailIdSet.size !== payloadDetailIds.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Duplicate detail id in payload", 400)
    }

    for (const detailId of payloadDetailIdSet) {
      if (!existingIdSet.has(detailId)) {
        await db.query("ROLLBACK")
        return fail("VALIDATION_ERROR", `Invalid detail id ${detailId} for this rate card`, 400)
      }
    }

    const referencedIdSet = new Set<number>()
    if (existingIds.length > 0) {
      const referencedRes = await db.query(
        `SELECT DISTINCT rate_detail_id
         FROM billing_transactions
         WHERE company_id = $1
           AND rate_detail_id = ANY($2::int[])`,
        [session.companyId, existingIds]
      )
      for (const row of referencedRes.rows as Array<{ rate_detail_id: number | string }>) {
        const id = Number(row.rate_detail_id)
        if (id > 0) referencedIdSet.add(id)
      }
    }

    for (const detail of payload.details) {
      if (detail.id && detail.id > 0) {
        await db.query(
          `UPDATE client_rate_details
           SET charge_type = $1,
               calc_method = $2,
               slab_mode = $3,
               item_id = $4,
               uom = $5,
               min_qty = $6,
               max_qty = $7,
               free_qty = $8,
               unit_rate = $9,
               min_charge = $10,
               max_charge = $11,
               tax_code = $12,
               gst_rate = $13,
               is_active = $14,
               updated_by = $15,
               updated_at = CURRENT_TIMESTAMP
           WHERE company_id = $16
             AND rate_master_id = $17
             AND id = $18`,
          [
            detail.charge_type,
            detail.calc_method || "PER_UNIT",
            detail.slab_mode || "ABSOLUTE",
            detail.item_id ?? null,
            detail.uom || "UNIT",
            detail.min_qty ?? null,
            detail.max_qty ?? null,
            detail.free_qty ?? 0,
            detail.unit_rate,
            detail.min_charge ?? 0,
            detail.max_charge ?? null,
            detail.tax_code || "GST",
            detail.gst_rate ?? 18,
            detail.is_active ?? true,
            session.userId,
            session.companyId,
            payload.id,
            detail.id,
          ]
        )
      } else {
        await db.query(
          `INSERT INTO client_rate_details (
             company_id, rate_master_id, charge_type, calc_method, slab_mode, item_id, uom, min_qty, max_qty, free_qty, unit_rate,
             min_charge, max_charge, tax_code, gst_rate, is_active, created_by, updated_by
             ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17
             )`,
          [
            session.companyId,
            payload.id,
            detail.charge_type,
            detail.calc_method || "PER_UNIT",
            detail.slab_mode || "ABSOLUTE",
            detail.item_id ?? null,
            detail.uom || "UNIT",
            detail.min_qty ?? null,
            detail.max_qty ?? null,
            detail.free_qty ?? 0,
            detail.unit_rate,
            detail.min_charge ?? 0,
            detail.max_charge ?? null,
            detail.tax_code || "GST",
            detail.gst_rate ?? 18,
            detail.is_active ?? true,
            session.userId,
          ]
        )
      }
    }

    const staleIds = existingIds.filter((id) => !payloadDetailIdSet.has(id))
    const staleReferencedIds = staleIds.filter((id) => referencedIdSet.has(id))
    const staleUnreferencedIds = staleIds.filter((id) => !referencedIdSet.has(id))

    if (staleUnreferencedIds.length > 0) {
      await db.query(
        `DELETE FROM client_rate_details
         WHERE company_id = $1
           AND rate_master_id = $2
           AND id = ANY($3::int[])`,
        [session.companyId, payload.id, staleUnreferencedIds]
      )
    }

    if (staleReferencedIds.length > 0) {
      await db.query(
        `UPDATE client_rate_details
         SET is_active = false,
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $2
           AND rate_master_id = $3
           AND id = ANY($4::int[])`,
        [session.userId, session.companyId, payload.id, staleReferencedIds]
      )
    }

    await db.query("COMMIT")
    return ok(masterRes.rows[0], "Rate card updated")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to update rate card"
    return fail("UPDATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const id = Number(request.nextUrl.searchParams.get("id") || 0)
    if (!id) return fail("VALIDATION_ERROR", "Rate card id is required", 400)

    const res = await getClient()
    try {
      await res.query("BEGIN")
      await setTenantContext(res, session.companyId)
      await res.query(
        `UPDATE client_rate_master
         SET is_active = false,
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE company_id = $2
           AND id = $3`,
        [session.userId, session.companyId, id]
      )
      await res.query("COMMIT")
      return ok({ id }, "Rate card deactivated")
    } catch (error) {
      await res.query("ROLLBACK")
      throw error
    } finally {
      res.release()
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to deactivate rate card"
    return fail("DELETE_FAILED", message, 400)
  }
}



