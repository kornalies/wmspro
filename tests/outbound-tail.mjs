/**
 * Track A acceptance: walk a DO through the full outbound tail over HTTP and
 * assert stock only moves at delivery-note finalize.
 *
 *   PICKED -> pack unit -> close -> goods issue -> load -> complete -> finalize
 *
 * Also asserts the A5 billing rule: OUTBOUND_HANDLING stages exactly once,
 * whichever trigger the tenant is on.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import { BASE_URL, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const QTY = 4
let scenarioSeq = 0

let failures = 0
function check(label, condition, extra = "") {
  const status = condition ? "PASS" : "FAIL"
  console.log(`${status}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

function must(label, result) {
  if (!result.res.ok) {
    throw new Error(`${label} failed: ${result.res.status} ${JSON.stringify(result.json)}`)
  }
  return result.json?.data ?? result.json
}

/** Seed a PICKED DO with QTY units of in-stock serials. */
async function seedScenario(fixtures) {
  const tag = `${SUFFIX}-${++scenarioSeq}`
  const DO_NUMBER = `DO-TAIL-${tag}`
  const SERIAL_PREFIX = `SER-TAIL-${tag}`
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId, itemId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      // Session-scoped (is_local = false): withDb hands out a dedicated client, and
    // a transaction-local setting would be discarded before the next statement.
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      const grnLine = await db.query(
        `SELECT gl.id
         FROM grn_line_items gl
         JOIN grn_header g ON g.id = gl.grn_header_id AND g.company_id = gl.company_id
         WHERE gl.company_id = $1 AND gl.item_id = $2
         ORDER BY gl.id DESC LIMIT 1`,
        [companyId, itemId]
      )
      const grnLineId = Number(grnLine.rows[0]?.id)
      if (!grnLineId) throw new Error("No GRN line fixture to hang stock off")

      const doHeader = await db.query(
        `INSERT INTO do_header (
           company_id, do_number, request_date, client_id, warehouse_id, requested_by,
           total_items, total_quantity_requested, total_quantity_dispatched, status
         )
         VALUES ($1, $2, CURRENT_DATE, $3, $4, 'Track A test', 1, $5, 0, 'PICKED')
         RETURNING id`,
        [companyId, DO_NUMBER, clientId, warehouseId, QTY]
      )
      const doId = Number(doHeader.rows[0].id)

      const doLine = await db.query(
        `INSERT INTO do_line_items (
           company_id, do_header_id, line_number, item_id, quantity_requested,
           quantity_dispatched, uom
         )
         VALUES ($1, $2, 1, $3, $4, 0, 'PCS')
         RETURNING id`,
        [companyId, doId, itemId, QTY]
      )
      const doLineId = Number(doLine.rows[0].id)

      // The line-item insert fires update_do_totals, which rewrites status.
      // PICKED is in the preserve list (migration 062) -- re-assert anyway so a
      // regression there surfaces as a failed assertion below, not a silent skip.
      await db.query(`UPDATE do_header SET status = 'PICKED' WHERE id = $1 AND company_id = $2`, [
        doId,
        companyId,
      ])

      const serialIds = []
      for (let i = 0; i < QTY; i++) {
        const row = await db.query(
          `INSERT INTO stock_serial_numbers (
             company_id, serial_number, item_id, client_id, warehouse_id,
             status, received_date, grn_line_item_id
           )
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6)
           RETURNING id`,
          [companyId, `${SERIAL_PREFIX}-${i}`, itemId, clientId, warehouseId, grnLineId]
        )
        serialIds.push(Number(row.rows[0].id))
      }

      await db.query("COMMIT")
      return { companyId, doId, doLineId, serialIds }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

async function readState(companyId, doId, serialIds) {
  return withDb(async (db) => {
    // Session-scoped (is_local = false): withDb hands out a dedicated client, and
    // a transaction-local setting would be discarded before the next statement.
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const header = await db.query(
      `SELECT status, total_quantity_dispatched FROM do_header WHERE id = $1`,
      [doId]
    )
    const stock = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM stock_serial_numbers
       WHERE id = ANY($1::int[]) GROUP BY status`,
      [serialIds]
    )
    const charges = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity), 0)::int AS qty
       FROM billing_transactions
       WHERE company_id = $1 AND source_doc_id = $2 AND charge_type = 'OUTBOUND_HANDLING'`,
      [companyId, doId]
    )
    return {
      status: String(header.rows[0]?.status),
      dispatched: Number(header.rows[0]?.total_quantity_dispatched),
      stock: Object.fromEntries(stock.rows.map((r) => [String(r.status), Number(r.n)])),
      chargeCount: Number(charges.rows[0].n),
      chargeQty: Number(charges.rows[0].qty),
    }
  })
}

async function countDispatchedForLine(companyId, doLineId) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM stock_serial_numbers
       WHERE company_id = $1 AND do_line_item_id = $2 AND status = 'DISPATCHED'`,
      [companyId, doLineId]
    )
    return Number(r.rows[0].n)
  })
}

async function cleanup(companyId, doId, serialIds) {
  await withDb(async (db) => {
    // Session-scoped (is_local = false): withDb hands out a dedicated client, and
    // a transaction-local setting would be discarded before the next statement.
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query(`DELETE FROM billing_transactions WHERE company_id = $1 AND source_doc_id = $2`, [
      companyId,
      doId,
    ])
    await db.query(`DELETE FROM gate_out WHERE company_id = $1 AND do_header_id = $2`, [
      companyId,
      doId,
    ])
    // Release every serial this DO touched -- the ones seeded here plus any
    // older fixture stock the FIFO dispatch legitimately consumed instead.
    //
    // Order matters: restoring status fires fn_track_serial_movements and writes
    // NEW stock_movements rows, so the movement purge has to come after it, not
    // before. fk_stock_do_line (correctly) blocks deleting a DO line while
    // dispatched stock points at it, so the reference is released rather than
    // the constraint weakened.
    const touched = await db.query(
      `UPDATE stock_serial_numbers SET do_line_item_id = NULL, status = 'IN_STOCK'
       WHERE company_id = $1
         AND (
           id = ANY($2::int[])
           OR do_line_item_id IN (SELECT id FROM do_line_items WHERE do_header_id = $3)
         )
       RETURNING id`,
      [companyId, serialIds, doId]
    )
    const touchedIds = touched.rows.map((r) => Number(r.id))
    await db.query(
      `DELETE FROM stock_movements
       WHERE company_id = $1 AND (serial_number_id = ANY($2::int[]) OR do_header_id = $3)`,
      [companyId, touchedIds, doId]
    )
    // do_header cascades to line items, pack units, goods issue, loads and notes.
    await db.query(`DELETE FROM do_header WHERE company_id = $1 AND id = $2`, [companyId, doId])
    await db.query(`DELETE FROM stock_serial_numbers WHERE company_id = $1 AND id = ANY($2::int[])`, [
      companyId,
      serialIds,
    ])
  })
}

async function setBillingTrigger(companyId, trigger) {
  await withDb(async (db) => {
    if (trigger === null) {
      await db.query(`UPDATE companies SET settings = settings - 'outbound_billing_trigger' WHERE id = $1`, [
        companyId,
      ])
      return
    }
    await db.query(
      `UPDATE companies
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{outbound_billing_trigger}', to_jsonb($2::text))
       WHERE id = $1`,
      [companyId, trigger]
    )
  })
}

/**
 * A5: on the GOODS_ISSUE trigger the charge must stage at the goods issue and
 * NOT again at finalize. Without this case the interesting half of A5 is untested.
 */
async function runGoodsIssueTriggerCase(fixtures, token) {
  const scenario = await seedScenario(fixtures)
  const { companyId, doId, doLineId, serialIds } = scenario
  try {
    await setBillingTrigger(companyId, "GOODS_ISSUE")

    const packed = must(
      "gi-trigger: create pack unit",
      await api(`/do/${doId}/pack-units`, {
        method: "POST",
        token,
        body: {
          pack_type: "PALLET",
          close: true,
          lines: [{ do_line_item_id: doLineId, serial_ids: serialIds }],
        },
      })
    )

    const gi = must(
      "gi-trigger: goods issue",
      await api(`/do/${doId}/goods-issue`, { method: "POST", token })
    )
    check("gi-trigger: charge staged at goods issue", gi.staged_outbound_handling === true)

    let state = await readState(companyId, doId, serialIds)
    check(
      "gi-trigger: exactly one charge after goods issue",
      state.chargeCount === 1 && state.chargeQty === QTY,
      `count=${state.chargeCount} qty=${state.chargeQty}`
    )
    check("gi-trigger: stock still in building", (state.stock.IN_STOCK ?? 0) === QTY, JSON.stringify(state.stock))

    const load = must(
      "gi-trigger: create load",
      await api(`/do/${doId}/loads`, {
        method: "POST",
        token,
        body: {
          vehicle_number: "KA01GITRIG",
          driver_name: "GI Driver",
          driver_phone: "8888888888",
          pack_unit_ids: [packed.id],
        },
      })
    )
    const loadDone = must(
      "gi-trigger: complete load",
      await api(`/do/loads/${load.id}/complete`, { method: "POST", token })
    )
    const finalized = must(
      "gi-trigger: finalize",
      await api(`/do/delivery-notes/${loadDone.delivery_note_id}/finalize`, { method: "POST", token })
    )
    check("gi-trigger: finalize did not stage again", finalized.staged_outbound_handling === false)

    state = await readState(companyId, doId, serialIds)
    check(
      "gi-trigger: still exactly one charge after finalize",
      state.chargeCount === 1 && state.chargeQty === QTY,
      `count=${state.chargeCount} qty=${state.chargeQty}`
    )
    check("gi-trigger: stock dispatched", (state.stock.DISPATCHED ?? 0) === QTY, JSON.stringify(state.stock))
  } finally {
    await setBillingTrigger(companyId, null)
    await cleanup(companyId, doId, serialIds)
  }
}

/**
 * Regression guard for the legacy one-step dispatch route, whose inline stock
 * selection was extracted into commitDoLineStockFifo. Behaviour must be
 * unchanged: STAGED gate, FIFO commit, OUTBOUND_HANDLING staged once, and
 * insufficient stock still a 409 INVENTORY_VALIDATION_FAILED.
 */
async function runLegacyDispatchCase(fixtures, token) {
  const scenario = await seedScenario(fixtures)
  const { companyId, doId, doLineId, serialIds } = scenario
  try {
    const itemId = fixtures.ids.a.itemId

    // Dispatch is gated on STAGED; a PICKED DO must be refused.
    const tooEarly = await api(`/do/${doId}/dispatch`, {
      method: "POST",
      token,
      body: {
        vehicle_number: "KA01LEGACY",
        driver_name: "Legacy Driver",
        driver_phone: "7777777777",
        items: [{ item_id: itemId, quantity: 1 }],
      },
    })
    check("legacy: dispatch blocked before STAGED", tooEarly.res.status === 409, `status=${tooEarly.res.status}`)

    must(
      "legacy: move to STAGED",
      await api(`/do/${doId}/status`, { method: "POST", token, body: { status: "STAGED" } })
    )

    // Over-dispatch must still fail with the inventory error, now raised by the
    // shared helper rather than inline.
    const tooMany = await api(`/do/${doId}/dispatch`, {
      method: "POST",
      token,
      body: {
        vehicle_number: "KA01LEGACY",
        driver_name: "Legacy Driver",
        driver_phone: "7777777777",
        items: [{ item_id: itemId, quantity: QTY + 5 }],
      },
    })
    check("legacy: over-dispatch rejected with 409", tooMany.res.status === 409, `status=${tooMany.res.status}`)

    must(
      "legacy: dispatch",
      await api(`/do/${doId}/dispatch`, {
        method: "POST",
        token,
        body: {
          vehicle_number: "KA01LEGACY",
          driver_name: "Legacy Driver",
          driver_phone: "7777777777",
          items: [{ item_id: itemId, quantity: QTY }],
        },
      })
    )

    const state = await readState(companyId, doId, serialIds)
    check("legacy: DO COMPLETED", state.status === "COMPLETED", state.status)
    // Assert against serials bound to this DO line, NOT the ones this test
    // seeded: FIFO legitimately prefers older stock for the same
    // item/client/warehouse, so which physical serials ship is not fixed.
    const committed = await countDispatchedForLine(companyId, doLineId)
    check("legacy: committed serials bound to DO line", committed === QTY, `n=${committed}`)
    check("legacy: dispatched total", state.dispatched === QTY, `n=${state.dispatched}`)
    check(
      "legacy: OUTBOUND_HANDLING staged once",
      state.chargeCount === 1 && state.chargeQty === QTY,
      `count=${state.chargeCount} qty=${state.chargeQty}`
    )
    void doLineId
  } finally {
    await cleanup(companyId, doId, serialIds)
  }
}

/**
 * Per-DO outbound path exclusivity (lib/outbound-path.ts).
 *
 * Both paths stay open to every tenant; a single order may not use both, because
 * the billing dedupe key includes event_date, so a mixed order either double-bills
 * (different dates) or silently under-bills (same date, upsert replaces the
 * quantity rather than summing). Asserts both directions, that a capture-only
 * dispatch call is still allowed on a tail order, and that voiding the pack units
 * releases the order.
 */
async function runPathExclusivityCase(fixtures, token) {
  const itemId = fixtures.ids.a.itemId

  // Direction 1: tail claims the order -> dispatch with quantity is refused.
  {
    const scenario = await seedScenario(fixtures)
    const { companyId, doId, doLineId, serialIds } = scenario
    try {
      const packed = must(
        "exclusivity: create pack unit",
        await api(`/do/${doId}/pack-units`, {
          method: "POST",
          token,
          body: {
            pack_type: "PALLET",
            lines: [{ do_line_item_id: doLineId, serial_ids: serialIds }],
          },
        })
      )
      must(
        "exclusivity: move to STAGED",
        await api(`/do/${doId}/status`, { method: "POST", token, body: { status: "STAGED" } })
      )

      const blocked = await api(`/do/${doId}/dispatch`, {
        method: "POST",
        token,
        body: {
          vehicle_number: "KA01MIXED",
          driver_name: "Mixed Driver",
          driver_phone: "7777700001",
          items: [{ item_id: itemId, quantity: 1 }],
        },
      })
      check(
        "exclusivity: dispatch blocked on a packed DO",
        blocked.res.status === 409 && blocked.json?.error?.code === "OUTBOUND_PATH_CONFLICT",
        `status=${blocked.res.status} code=${blocked.json?.error?.code}`
      )

      const state = await readState(companyId, doId, serialIds)
      check(
        "exclusivity: blocked dispatch moved no stock and staged no charge",
        (state.stock.IN_STOCK ?? 0) === QTY && state.chargeCount === 0 && state.dispatched === 0,
        `stock=${JSON.stringify(state.stock)} charges=${state.chargeCount} dispatched=${state.dispatched}`
      )

      // Capture-only must still pass: this route is the mobile capture endpoint
      // (/do/[id]/capture aliases it) and is the ONLY writer of the outward
      // register the Job Card bills handling time from. Blocking it would leave
      // tail orders unbillable for machine handling.
      const capture = await api(`/do/${doId}/dispatch`, {
        method: "POST",
        token,
        body: {
          items: [],
          handlingType: "MACHINE HANDLING",
          machineType: "FORKLIFT",
          noOfCases: 2,
          weight: 120.5,
          outwardRemarks: "captured on a tail order",
        },
      })
      check(
        "exclusivity: capture-only dispatch still allowed on a packed DO",
        capture.res.ok,
        `status=${capture.res.status} ${JSON.stringify(capture.json?.error ?? "")}`
      )

      const captured = await withDb(async (db) => {
        await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
        const row = await db.query(
          `SELECT handling_type, machine_type, no_of_cases, weight_kg,
                  total_quantity_dispatched
             FROM do_header WHERE id = $1`,
          [doId]
        )
        return row.rows[0]
      })
      check(
        "exclusivity: capture wrote the outward register without dispatching",
        String(captured?.handling_type) === "MACHINE" &&
          Number(captured?.no_of_cases) === 2 &&
          Number(captured?.total_quantity_dispatched) === 0,
        JSON.stringify(captured)
      )

      // Voiding the pack unit releases the order to the other path.
      must(
        "exclusivity: void pack unit",
        await api(`/do/pack-units/${packed.id}/cancel`, {
          method: "POST",
          token,
          body: { reason: "path switch" },
        })
      )
      must(
        "exclusivity: re-stage after void",
        await api(`/do/${doId}/status`, { method: "POST", token, body: { status: "STAGED" } })
      )
      const released = await api(`/do/${doId}/dispatch`, {
        method: "POST",
        token,
        body: {
          vehicle_number: "KA01MIXED",
          driver_name: "Mixed Driver",
          driver_phone: "7777700001",
          items: [{ item_id: itemId, quantity: 1 }],
        },
      })
      check(
        "exclusivity: dispatch allowed once pack units are voided",
        released.res.ok,
        `status=${released.res.status} ${JSON.stringify(released.json?.error ?? "")}`
      )
    } finally {
      await cleanup(companyId, doId, serialIds)
    }
  }

  // Direction 2: dispatch claims the order -> entering the tail is refused.
  {
    const scenario = await seedScenario(fixtures)
    const { companyId, doId, doLineId, serialIds } = scenario
    try {
      must(
        "exclusivity: move to STAGED for partial dispatch",
        await api(`/do/${doId}/status`, { method: "POST", token, body: { status: "STAGED" } })
      )
      must(
        "exclusivity: partial dispatch",
        await api(`/do/${doId}/dispatch`, {
          method: "POST",
          token,
          body: {
            vehicle_number: "KA01PARTIAL",
            driver_name: "Partial Driver",
            driver_phone: "7777700002",
            items: [{ item_id: itemId, quantity: 1 }],
          },
        })
      )

      const state = await readState(companyId, doId, serialIds)
      check(
        "exclusivity: partial dispatch left the DO open",
        state.status === "PARTIALLY_FULFILLED" && state.chargeCount === 1,
        `status=${state.status} charges=${state.chargeCount}`
      )

      // First line of defence, and the reason this direction was never actually
      // exploitable over the API: dispatching any quantity lands the DO in
      // PARTIALLY_FULFILLED or COMPLETED, and neither can transition back to the
      // PICKED / PACKED that pack-unit creation requires.
      const noWayBack = await api(`/do/${doId}/status`, {
        method: "POST",
        token,
        body: { status: "PICKED" },
      })
      check(
        "exclusivity: status machine refuses PARTIALLY_FULFILLED -> PICKED",
        noWayBack.res.status === 409,
        `status=${noWayBack.res.status} code=${noWayBack.json?.error?.code}`
      )

      const remaining = serialIds.filter((_, index) => index > 0)
      const blockedByStatus = await api(`/do/${doId}/pack-units`, {
        method: "POST",
        token,
        body: {
          pack_type: "PALLET",
          lines: [{ do_line_item_id: doLineId, serial_ids: remaining }],
        },
      })
      check(
        "exclusivity: pack unit refused on a PARTIALLY_FULFILLED DO",
        blockedByStatus.res.status === 409,
        `status=${blockedByStatus.res.status} code=${blockedByStatus.json?.error?.code}`
      )

      const after = await readState(companyId, doId, serialIds)
      check(
        "exclusivity: still exactly one charge after the blocked pack",
        after.chargeCount === 1,
        `charges=${after.chargeCount}`
      )
    } finally {
      await cleanup(companyId, doId, serialIds)
    }
  }

  // Direction 2, backstop: the pack-units guard fires on state the status machine
  // cannot produce but direct SQL can -- legacy rows, repair scripts such as
  // scripts/db/reconcile-do-quantities.mjs, or a future status-table change. The
  // audit found 27 pre-tail dispatch DOs, so such rows exist in the wild.
  {
    const scenario = await seedScenario(fixtures)
    const { companyId, doId, doLineId, serialIds } = scenario
    try {
      await withDb(async (db) => {
        await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
        await db.query(
          `UPDATE do_line_items SET quantity_dispatched = 1
            WHERE company_id = $1 AND id = $2`,
          [companyId, doLineId]
        )
        // update_do_totals rewrites the header on that write, so force the
        // otherwise-unreachable combination the guard has to cope with.
        await db.query(
          `UPDATE do_header
              SET total_quantity_dispatched = 1, status = 'PICKED'
            WHERE company_id = $1 AND id = $2`,
          [companyId, doId]
        )
      })

      const blocked = await api(`/do/${doId}/pack-units`, {
        method: "POST",
        token,
        body: {
          pack_type: "PALLET",
          lines: [{ do_line_item_id: doLineId, serial_ids: serialIds.slice(1) }],
        },
      })
      check(
        "exclusivity: pack unit blocked on a PICKED DO carrying dispatched qty",
        blocked.res.status === 409 && blocked.json?.error?.code === "OUTBOUND_PATH_CONFLICT",
        `status=${blocked.res.status} code=${blocked.json?.error?.code}`
      )
    } finally {
      await cleanup(companyId, doId, serialIds)
    }
  }
}

async function run() {
  const fixtures = await ensureChaosFixtures()
  const scenario = await seedScenario(fixtures)
  const { companyId, doId, doLineId, serialIds } = scenario

  try {
    const login = await api("/mobile/auth/login", {
      method: "POST",
      body: {
        company_code: fixtures.tenantA.code,
        username: fixtures.tenantA.username,
        password: fixtures.tenantA.password,
      },
    })
    const token = must("login", login)?.access_token
    if (!token) throw new Error("no access token")

    let state = await readState(companyId, doId, serialIds)
    check("seeded DO is PICKED", state.status === "PICKED", state.status)

    // 1. Pack
    const packed = must(
      "create pack unit",
      await api(`/do/${doId}/pack-units`, {
        method: "POST",
        token,
        body: {
          pack_type: "PALLET",
          lines: [{ do_line_item_id: doLineId, serial_ids: serialIds }],
        },
      })
    )
    check("pack unit created with all serials", packed.total_quantity === QTY, `qty=${packed.total_quantity}`)

    state = await readState(companyId, doId, serialIds)
    check("DO advanced to PACKED", state.status === "PACKED", state.status)
    check("packing did not move stock", (state.stock.IN_STOCK ?? 0) === QTY, JSON.stringify(state.stock))

    // A serial may not be packed twice.
    const dup = await api(`/do/${doId}/pack-units`, {
      method: "POST",
      token,
      body: { pack_type: "PALLET", lines: [{ do_line_item_id: doLineId, serial_ids: [serialIds[0]] }] },
    })
    check("re-packing a packed serial is rejected", !dup.res.ok, `status=${dup.res.status}`)

    // 2. Close
    must("close pack unit", await api(`/do/pack-units/${packed.id}/close`, { method: "POST", token }))

    // 3. Goods issue
    const gi = must("generate goods issue", await api(`/do/${doId}/goods-issue`, { method: "POST", token }))
    check("goods issue covers the pack unit", gi.total_pack_units === 1, `packs=${gi.total_pack_units}`)

    state = await readState(companyId, doId, serialIds)
    check("DO advanced to ISSUED", state.status === "ISSUED", state.status)
    check("goods issue did not move stock", (state.stock.IN_STOCK ?? 0) === QTY, JSON.stringify(state.stock))
    check(
      "no charge staged yet on DISPATCH trigger",
      state.chargeCount === 0,
      `charges=${state.chargeCount}`
    )

    // 4. Load
    const load = must(
      "create load",
      await api(`/do/${doId}/loads`, {
        method: "POST",
        token,
        body: {
          vehicle_number: "KA01TRACKA",
          driver_name: "Track A Driver",
          driver_phone: "9999999999",
          seal_number: "SEAL-1",
          pack_unit_ids: [packed.id],
        },
      })
    )

    const loadDone = must(
      "complete load",
      await api(`/do/loads/${load.id}/complete`, { method: "POST", token })
    )
    check("delivery note raised", Boolean(loadDone.delivery_note_id), loadDone.delivery_note_number)

    state = await readState(companyId, doId, serialIds)
    check("DO advanced to LOADED", state.status === "LOADED", state.status)
    check("loading did not move stock", (state.stock.IN_STOCK ?? 0) === QTY, JSON.stringify(state.stock))

    // 5. Finalize -- the only step that moves stock.
    const finalized = must(
      "finalize delivery note",
      await api(`/do/delivery-notes/${loadDone.delivery_note_id}/finalize`, {
        method: "POST",
        token,
      })
    )
    check("finalize committed all serials", finalized.serials_committed === QTY, `n=${finalized.serials_committed}`)

    state = await readState(companyId, doId, serialIds)
    check("DO COMPLETED", state.status === "COMPLETED", state.status)
    check("stock now DISPATCHED", (state.stock.DISPATCHED ?? 0) === QTY, JSON.stringify(state.stock))
    check("dispatched total updated", state.dispatched === QTY, `n=${state.dispatched}`)
    check(
      "OUTBOUND_HANDLING staged exactly once",
      state.chargeCount === 1 && state.chargeQty === QTY,
      `count=${state.chargeCount} qty=${state.chargeQty}`
    )

    // Finalize is idempotent, not double-committing.
    const replay = await api(`/do/delivery-notes/${loadDone.delivery_note_id}/finalize`, {
      method: "POST",
      token,
    })
    const after = await readState(companyId, doId, serialIds)
    check("re-finalize is idempotent", replay.res.ok, `status=${replay.res.status}`)
    check(
      "re-finalize did not double-bill",
      after.chargeCount === 1 && after.dispatched === QTY,
      `count=${after.chargeCount} dispatched=${after.dispatched}`
    )
    await runGoodsIssueTriggerCase(fixtures, token)
    await runLegacyDispatchCase(fixtures, token)
    await runPathExclusivityCase(fixtures, token)
  } finally {
    await cleanup(companyId, doId, serialIds)
  }

  console.log(failures === 0 ? "\nOutbound tail: all checks passed." : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error("\nOutbound tail test error:", error.message)
  process.exit(1)
})