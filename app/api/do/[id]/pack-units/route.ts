import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { writeAudit } from "@/lib/audit"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import {
  OutboundTailError,
  assertDOStatusIn,
  lockDO,
  nextDocumentNumber,
  setDOStatus,
} from "@/lib/outbound-tail"
import { getOutboundPathClaim, outboundPathConflictMessage } from "@/lib/outbound-path"
import { allocatableStockPredicate } from "@/lib/allocation"

type RouteContext = {
  params: Promise<{ id: string }>
}

const createPackUnitSchema = z.object({
  pack_type: z.enum(["PALLET", "CARTON", "BULK"]).default("PALLET"),
  pack_code: z.string().trim().min(3).max(64).optional(),
  source_lp_record_id: z.string().trim().optional(),
  gross_weight_kg: z.number().nonnegative().optional(),
  volume_cbm: z.number().nonnegative().optional(),
  close: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        do_line_item_id: z.number().positive(),
        serial_ids: z.array(z.number().positive()).min(1),
      })
    )
    .min(1),
})

export async function GET(_: NextRequest, context: RouteContext) {
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
    // setTenantContext sets app.company_id with is_local = true, so it survives
    // only to the end of the current transaction. Without this BEGIN the setting
    // reverted after its own statement, RLS filtered every following query to
    // zero rows, and this route answered 404 for delivery orders that exist.
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)
    const doRow = await lockDO(db, session.companyId, id)
    requireScope(policy, "warehouse", doRow.warehouseId)
    requireScope(policy, "client", doRow.clientId)

    const units = await db.query(
      `SELECT u.id, u.pack_code, u.pack_type, u.status, u.total_quantity,
              u.gross_weight_kg, u.volume_cbm, u.closed_at,
              (gi.pack_unit_id IS NOT NULL) AS is_issued,
              (lp.pack_unit_id IS NOT NULL) AS is_loaded
       FROM do_pack_units u
       LEFT JOIN goods_issue_pack_units gi
         ON gi.pack_unit_id = u.id AND gi.company_id = u.company_id
       LEFT JOIN outbound_load_pack_units lp
         ON lp.pack_unit_id = u.id AND lp.company_id = u.company_id
       WHERE u.company_id = $1
         AND u.do_header_id = $2
       ORDER BY u.id ASC`,
      [session.companyId, doRow.id]
    )

    await db.query("COMMIT")
    return ok({ do_id: doRow.id, do_number: doRow.doNumber, pack_units: units.rows })
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundTailError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to list pack units"
    return fail("PACK_UNIT_LIST_FAILED", message, 400)
  } finally {
    db.release()
  }
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
    const payload = createPackUnitSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const doRow = await lockDO(db, session.companyId, id)
    requireScope(policy, "warehouse", doRow.warehouseId)
    requireScope(policy, "client", doRow.clientId)
    assertDOStatusIn(doRow, ["PICKED", "PACKED"], "build a pack unit for")

    // Entry point to the whole tail: goods issue, loads and the delivery note all
    // refuse to run without closed pack units, so blocking here blocks the tail.
    // An order already dispatched directly cannot enter it -- see
    // lib/outbound-path.ts for why mixing the two corrupts the order's billing.
    const claim = await getOutboundPathClaim(db, session.companyId, doRow.id)
    if (claim?.path === "DISPATCH") {
      await db.query("ROLLBACK")
      return fail("OUTBOUND_PATH_CONFLICT", outboundPathConflictMessage(claim, "TAIL"), 409)
    }

    // Validate every referenced line belongs to this DO, and every serial is
    // real, belongs to that line's item, and is still in the building.
    const lineIds = payload.lines.map((line) => line.do_line_item_id)
    const lineRows = await db.query(
      `SELECT dli.id,
              dli.item_id,
              dli.line_number,
              GREATEST(
                dli.quantity_requested - GREATEST(
                  dli.quantity_dispatched,
                  (SELECT COUNT(*)::int
                     FROM do_pack_unit_serials pus
                    WHERE pus.company_id = dli.company_id
                      AND pus.do_line_item_id = dli.id)
                ),
                0
              ) AS outstanding
       FROM do_line_items dli
       WHERE dli.company_id = $1
         AND dli.do_header_id = $2
         AND dli.id = ANY($3::int[])`,
      [session.companyId, doRow.id, lineIds]
    )
    if (lineRows.rows.length !== new Set(lineIds).size) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "One or more line items do not belong to this DO", 400)
    }
    const itemByLine = new Map<number, number>(
      lineRows.rows.map((row: { id: unknown; item_id: unknown }) => [
        Number(row.id),
        Number(row.item_id),
      ])
    )
    const outstandingByLine = new Map<number, number>(
      lineRows.rows.map((row: { id: unknown; outstanding: unknown }) => [
        Number(row.id),
        Number(row.outstanding),
      ])
    )
    const lineNumberByLine = new Map<number, number>(
      lineRows.rows.map((row: { id: unknown; line_number: unknown }) => [
        Number(row.id),
        Number(row.line_number),
      ])
    )

    // Never pack more than the line still owes. The pack pool in the tail read
    // enforces the same ceiling, but the UI is not the authority: without this
    // the endpoint would happily ship five units against an order for two.
    for (const line of payload.lines) {
      const outstanding = outstandingByLine.get(line.do_line_item_id) ?? 0
      if (line.serial_ids.length > outstanding) {
        await db.query("ROLLBACK")
        return fail(
          "WORKFLOW_BLOCKED",
          outstanding === 0
            ? `DO line ${lineNumberByLine.get(line.do_line_item_id)} is already fully packed.`
            : `DO line ${lineNumberByLine.get(line.do_line_item_id)} has ${outstanding} unit(s) outstanding but ${line.serial_ids.length} serial(s) were submitted.`,
          409
        )
      }
    }

    const allSerialIds = payload.lines.flatMap((line) => line.serial_ids)
    if (new Set(allSerialIds).size !== allSerialIds.length) {
      await db.query("ROLLBACK")
      return fail("VALIDATION_ERROR", "Duplicate serial in pack unit payload", 400)
    }

    // is_allocatable mirrors the exclusion the packable pool applies. The pool is
    // advisory -- it only shapes what the screen offers -- so without re-checking
    // it here a caller posting serial ids directly could pack expired stock, and
    // the tail would ship it: finalize commits the exact serials that were packed
    // and never re-tests them. The dispatch path has always refused such stock
    // (commitDoLineStock applies the same predicate), so the two paths disagreed.
    const serialRows = await db.query(
      `SELECT s.id, s.item_id, s.status, s.do_line_item_id,
              to_char(s.expiry_date, 'YYYY-MM-DD') AS expiry_date_text,
              (s.expiry_date IS NOT NULL AND s.expiry_date < CURRENT_DATE) AS is_expired,
              i.min_shelf_life_days,
              (${allocatableStockPredicate("s", "i")}) AS is_allocatable
       FROM stock_serial_numbers s
       JOIN items i ON i.id = s.item_id AND i.company_id = s.company_id
       WHERE s.company_id = $1
         AND s.id = ANY($2::int[])
         AND s.warehouse_id = $3
         AND s.client_id = $4
       FOR UPDATE OF s`,
      [session.companyId, allSerialIds, doRow.warehouseId, doRow.clientId]
    )
    if (serialRows.rows.length !== allSerialIds.length) {
      await db.query("ROLLBACK")
      return fail(
        "VALIDATION_ERROR",
        "One or more serials do not exist in this warehouse/client scope",
        400
      )
    }
    type SerialRow = {
      id: unknown
      item_id: unknown
      status: unknown
      do_line_item_id: unknown
      expiry_date_text: unknown
      is_expired: unknown
      min_shelf_life_days: unknown
      is_allocatable: unknown
    }
    const serialById = new Map<number, SerialRow>(
      serialRows.rows.map((row: SerialRow) => [Number(row.id), row])
    )
    for (const line of payload.lines) {
      const expectedItem = itemByLine.get(line.do_line_item_id)
      for (const serialId of line.serial_ids) {
        const serial = serialById.get(serialId)
        if (Number(serial?.item_id) !== expectedItem) {
          await db.query("ROLLBACK")
          return fail(
            "VALIDATION_ERROR",
            `Serial ${serialId} is not the item on DO line ${line.do_line_item_id}`,
            400
          )
        }
        const status = String(serial?.status)
        if (status !== "IN_STOCK" && status !== "RESERVED") {
          await db.query("ROLLBACK")
          return fail(
            "WORKFLOW_BLOCKED",
            `Serial ${serialId} is ${status} and cannot be packed`,
            409
          )
        }
        // Free stock is unpinned; RESERVED stock may only be packed by the line
        // that holds it. Packing another line's reservation leaves that order
        // short at commit time through no fault of its own.
        const pinnedTo =
          serial?.do_line_item_id == null ? null : Number(serial.do_line_item_id)
        if (status === "RESERVED" && pinnedTo !== line.do_line_item_id) {
          await db.query("ROLLBACK")
          return fail(
            "WORKFLOW_BLOCKED",
            `Serial ${serialId} is reserved for another delivery order line and cannot be packed here`,
            409
          )
        }
        // Expired, or inside the item's contracted minimum remaining shelf life.
        // Distinguished in the message because they are different problems: one
        // is unsaleable, the other is saleable stock this customer will reject.
        if (serial?.is_allocatable === false) {
          // Both flags come from SQL: a date column arrives as a JS Date, so
          // formatting or comparing it here would depend on the server timezone.
          const expiry = serial.expiry_date_text ? String(serial.expiry_date_text) : "an unknown date"
          const minShelfLife =
            serial.min_shelf_life_days == null ? null : Number(serial.min_shelf_life_days)
          await db.query("ROLLBACK")
          return fail(
            "WORKFLOW_BLOCKED",
            serial.is_expired === true
              ? `Serial ${serialId} expired on ${expiry} and cannot be packed`
              : `Serial ${serialId} expires on ${expiry} and is inside the ${minShelfLife}-day minimum shelf life for this item, so it cannot be packed`,
            409
          )
        }
      }
    }

    const packCode =
      payload.pack_code ?? (await nextDocumentNumber(db, "pack_unit_code_seq", "PU"))
    const totalQuantity = allSerialIds.length
    const shouldClose = payload.close || payload.pack_type === "BULK"

    const unit = await db.query(
      `INSERT INTO do_pack_units (
         company_id, pack_code, do_header_id, warehouse_id, client_id,
         pack_type, status, source_lp_record_id, gross_weight_kg, volume_cbm,
         total_quantity, closed_at, closed_by, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamp, $13, $14)
       RETURNING id, pack_code, status`,
      [
        session.companyId,
        packCode,
        doRow.id,
        doRow.warehouseId,
        doRow.clientId,
        payload.pack_type,
        shouldClose ? "CLOSED" : "OPEN",
        payload.source_lp_record_id ?? null,
        payload.gross_weight_kg ?? null,
        payload.volume_cbm ?? null,
        totalQuantity,
        shouldClose ? new Date().toISOString() : null,
        shouldClose ? session.userId : null,
        session.userId,
      ]
    )
    const packUnitId = Number(unit.rows[0].id)

    for (const line of payload.lines) {
      const itemId = itemByLine.get(line.do_line_item_id)
      for (const serialId of line.serial_ids) {
        await db.query(
          `INSERT INTO do_pack_unit_serials (
             company_id, pack_unit_id, do_line_item_id, item_id, serial_id
           )
           VALUES ($1, $2, $3, $4, $5)`,
          [session.companyId, packUnitId, line.do_line_item_id, itemId, serialId]
        )
      }
    }

    if (doRow.status === "PICKED") {
      await setDOStatus(db, session.companyId, doRow.id, "PACKED")
    }

    await writeAudit(
      {
        companyId: session.companyId,
        actorUserId: session.userId,
        actorType: "web",
        action: "do.pack.unit.create",
        entityType: "do_pack_units",
        entityId: String(packUnitId),
        before: { do_status: doRow.status },
        after: {
          do_status: doRow.status === "PICKED" ? "PACKED" : doRow.status,
          pack_code: packCode,
          total_quantity: totalQuantity,
          status: shouldClose ? "CLOSED" : "OPEN",
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok(
      {
        id: packUnitId,
        pack_code: packCode,
        status: shouldClose ? "CLOSED" : "OPEN",
        total_quantity: totalQuantity,
        do_id: doRow.id,
      },
      "Pack unit created"
    )
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof OutboundTailError) return fail(error.code, error.message, error.status)
    const message = error instanceof Error ? error.message : "Failed to create pack unit"
    return fail("PACK_UNIT_CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}