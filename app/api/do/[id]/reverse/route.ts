import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getDOStatusErrorMessage, normalizeDOStatus } from "@/lib/do-status"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

const reverseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")

    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { id } = await context.params
    const rawRef = decodeURIComponent(id).trim()
    const numericId = /^\d+$/.test(rawRef) ? Number(rawRef) : null
    const doNumber = numericId ? null : rawRef
    if (!numericId && !doNumber) return fail("VALIDATION_ERROR", "Invalid delivery order reference", 400)

    const payload = reverseSchema.parse(await request.json().catch(() => ({})))

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const doRes = await db.query(
      `SELECT id, do_number, client_id, warehouse_id, status, total_quantity_dispatched
       FROM do_header
       WHERE company_id = $1
         AND (
           ($2::int IS NOT NULL AND id = $2)
           OR ($3::text IS NOT NULL AND do_number ILIKE $3)
         )
       FOR UPDATE`,
      [session.companyId, numericId, doNumber]
    )
    if (!doRes.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Delivery Order not found", 404)
    }

    const doHeader = doRes.rows[0]
    const doId = Number(doHeader.id)
    const currentStatus = normalizeDOStatus(doHeader.status)
    if (!currentStatus) {
      await db.query("ROLLBACK")
      return fail("DO_STATUS_INVALID", getDOStatusErrorMessage(doHeader.status), 409)
    }
    requireScope(policy, "warehouse", doHeader.warehouse_id)
    requireScope(policy, "client", doHeader.client_id)

    if (currentStatus === "CANCELLED") {
      await db.query("ROLLBACK")
      return ok(
        {
          id: doId,
          status: "CANCELLED",
          restored_stock_count: 0,
          voided_billing_tx_count: 0,
        },
        "DO is already cancelled"
      )
    }

    const billedRes = await db.query(
      `SELECT DISTINCT
         ih.id AS invoice_id,
         ih.invoice_number
       FROM billing_transactions bt
       LEFT JOIN invoice_header ih
         ON ih.id = bt.invoice_id
        AND ih.company_id = bt.company_id
       WHERE bt.company_id = $1
         AND bt.source_type = 'DO'
         AND bt.source_doc_id = $2
         AND bt.status = 'BILLED'
       ORDER BY ih.id DESC`,
      [session.companyId, doId]
    )

    if (billedRes.rows.length > 0) {
      const billedRows = billedRes.rows as Array<{ invoice_id: number | null; invoice_number: string | null }>
      const invoiceNumbers = billedRes.rows
        .map((row: { invoice_id: number | null; invoice_number: string | null }) =>
          String(row.invoice_number || row.invoice_id)
        )
        .filter(Boolean)
      await db.query("ROLLBACK")
      return fail(
        "DO_BILLED",
        `DO ${doHeader.do_number} is already billed in invoice(s): ${invoiceNumbers.join(", ")}. Please reverse the invoice first (credit note/unbill) and then retry DO reversal.`,
        409,
        {
          invoice_ids: billedRows.map((row) => Number(row.invoice_id)).filter(Boolean),
          invoice_numbers: invoiceNumbers,
        }
      )
    }

    const linesRes = await db.query(
      `SELECT id, quantity_dispatched
       FROM do_line_items
       WHERE company_id = $1
         AND do_header_id = $2
       FOR UPDATE`,
      [session.companyId, doId]
    )
    const lineRows = linesRes.rows as Array<{ id: number; quantity_dispatched: number }>
    const lineIds = lineRows.map((row) => Number(row.id)).filter(Boolean)

    let restoredStockCount = 0
    if (lineIds.length > 0) {
      const restoredRes = await db.query(
        `UPDATE stock_serial_numbers
         SET status = 'IN_STOCK',
             do_line_item_id = NULL,
             dispatched_date = NULL
         WHERE company_id = $1
           AND do_line_item_id = ANY($2::int[])
           AND status IN ('DISPATCHED', 'RESERVED')
         RETURNING id`,
        [session.companyId, lineIds]
      )
      restoredStockCount = restoredRes.rowCount || 0
    }

    await db.query(
      `UPDATE do_line_items
       SET quantity_dispatched = 0
       WHERE company_id = $1
         AND do_header_id = $2`,
      [session.companyId, doId]
    )

    const voidBillingRes = await db.query(
      `UPDATE billing_transactions
       SET status = 'VOID',
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND source_type = 'DO'
         AND source_doc_id = $3
         AND status = 'UNBILLED'
       RETURNING id`,
      [session.userId ?? null, session.companyId, doId]
    )
    const voidedBillingCount = voidBillingRes.rowCount || 0

    await db.query(
      `UPDATE do_header
       SET status = 'CANCELLED',
           total_quantity_dispatched = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND id = $2`,
      [session.companyId, doId]
    )

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.reverse",
        entityType: "do_header",
        entityId: String(doId),
        before: {
          status: doHeader.status,
          total_quantity_dispatched: doHeader.total_quantity_dispatched,
        },
        after: {
          status: "CANCELLED",
          total_quantity_dispatched: 0,
          restored_stock_count: restoredStockCount,
          voided_billing_tx_count: voidedBillingCount,
          reason: payload.reason || null,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: doId,
        status: "CANCELLED",
        restored_stock_count: restoredStockCount,
        voided_billing_tx_count: voidedBillingCount,
      },
      "DO reversed successfully"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to reverse DO"
    return fail("DO_REVERSE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
