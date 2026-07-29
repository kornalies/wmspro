import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { ensureAccountingSchema } from "@/lib/db-bootstrap"
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

    // An already-cancelled DO is not short-circuited. Every step below is
    // written to be a no-op when there is nothing left to undo, and DOs reversed
    // before the tail unwind existed still have live pack units and delivery
    // notes hanging off them. Re-running the reversal is how those get cleaned
    // up; returning early here would leave them stranded with no way back.
    const alreadyCancelled = currentStatus === "CANCELLED"

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
        `DO ${doHeader.do_number} is already billed in invoice(s): ${invoiceNumbers.join(", ")}. Void the invoice first (Finance → invoice → Void releases the charge back to unbilled) and then retry DO reversal.`,
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

    // Unwind the outbound tail as well. Restoring the stock without this left a
    // cancelled DO carrying a delivery note that still read COMPLETED, and left
    // its serials sitting inside pack units: the packable pool excludes anything
    // with a do_pack_unit_serials row regardless of the parent DO's status, so
    // reversal handed the units back to inventory and then hid them from the one
    // screen that packs them. The legacy dispatch path ignores pack units and
    // would still allocate the same serials, so the two disagreed about what was
    // available.
    //
    // The serial links are deleted rather than flagged, matching the pack-unit
    // void endpoint: every consumer derives availability from that table, so
    // removing the rows releases the stock everywhere at once. The pack unit,
    // goods issue, load and delivery note rows all survive as CANCELLED, so the
    // reversal stays auditable.
    const releasedFromPackUnits = await db.query(
      `DELETE FROM do_pack_unit_serials pus
       USING do_pack_units u
       WHERE pus.company_id = $1
         AND u.id = pus.pack_unit_id
         AND u.company_id = pus.company_id
         AND u.do_header_id = $2
       RETURNING pus.serial_id`,
      [session.companyId, doId]
    )
    const releasedPackedSerialCount = releasedFromPackUnits.rowCount || 0

    const voidedPackUnits = await db.query(
      `UPDATE do_pack_units
       SET status = 'CANCELLED',
           total_quantity = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND do_header_id = $2
         AND status <> 'CANCELLED'
       RETURNING id`,
      [session.companyId, doId]
    )

    const cancelledNotes = await db.query(
      `UPDATE delivery_note_header
       SET status = 'CANCELLED',
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND do_header_id = $2
         AND status <> 'CANCELLED'
       RETURNING id`,
      [session.companyId, doId]
    )

    const cancelledLoads = await db.query(
      `UPDATE outbound_loads
       SET status = 'CANCELLED',
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $1
         AND do_header_id = $2
         AND status <> 'CANCELLED'
       RETURNING id`,
      [session.companyId, doId]
    )

    const cancelledIssues = await db.query(
      `UPDATE goods_issue_header
       SET status = 'CANCELLED',
           cancelled_at = CURRENT_TIMESTAMP,
           cancelled_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND do_header_id = $3
         AND status <> 'CANCELLED'
       RETURNING id`,
      [session.userId ?? null, session.companyId, doId]
    )

    const tailUnwind = {
      released_packed_serial_count: releasedPackedSerialCount,
      voided_pack_unit_count: voidedPackUnits.rowCount || 0,
      cancelled_goods_issue_count: cancelledIssues.rowCount || 0,
      cancelled_load_count: cancelledLoads.rowCount || 0,
      cancelled_delivery_note_count: cancelledNotes.rowCount || 0,
    }

    const voidBillingRes = await db.query(
      `UPDATE billing_transactions
       SET status = 'VOID',
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = $2
         AND source_type = 'DO'
         AND source_doc_id = $3
         AND status IN ('UNBILLED', 'UNRATED')
       RETURNING id`,
      [session.userId ?? null, session.companyId, doId]
    )
    const voidedBillingCount = voidBillingRes.rowCount || 0

    await ensureAccountingSchema(db)
    const ledgerCleanupRes = await db.query(
      `DELETE FROM journal_entries
       WHERE company_id = $1
         AND source_module = 'DO'
         AND entry_type = 'DO_DISPATCH'
         AND external_ref = $2`,
      [session.companyId, `DO-${doId}-DISPATCH`]
    )
    const removedLedgerEntryCount = ledgerCleanupRes.rowCount || 0

    await db.query(
      `UPDATE do_header
       SET status = 'CANCELLED',
           total_quantity_dispatched = 0,
           dispatched_qty = 0,
           quantity_difference = CASE
             WHEN invoice_qty IS NULL THEN NULL
             ELSE invoice_qty
           END,
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
          removed_ledger_entry_count: removedLedgerEntryCount,
          ...tailUnwind,
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
        removed_ledger_entry_count: removedLedgerEntryCount,
        ...tailUnwind,
      },
      alreadyCancelled
        ? `DO was already cancelled. Cleaned up ${releasedPackedSerialCount} stranded serial(s) and ${tailUnwind.voided_pack_unit_count} pack unit(s).`
        : `DO reversed successfully. ${restoredStockCount + releasedPackedSerialCount} serial(s) returned to stock, ${tailUnwind.voided_pack_unit_count} pack unit(s) voided.`
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
