/**
 * Track D remainder: lot master, genealogy and recall.
 *
 * The assertion that matters is not that the recall report renders. It is that a
 * held lot STOPS SHIPPING. A recall screen that lists affected stock while
 * allocation keeps handing it out is worse than none, because it looks like the
 * problem has been dealt with. So the centre of this suite is: dispatch works,
 * hold the batch, the same dispatch is refused and says why, release, dispatch
 * works again.
 *
 * Requires a running dev server and a migrated database.
 */

import process from "node:process"
import { BASE_URL, deleteTestFixtures, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const BATCH = `LOT-TRACE-${SUFFIX}`

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
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
  return { res, json, status: res.status }
}

function must(label, result) {
  if (!result.res.ok) {
    throw new Error(`${label} failed: ${result.status} ${JSON.stringify(result.json)}`)
  }
  return result.json?.data ?? result.json
}

async function login(fixtures) {
  const res = await fetch(`${BASE_URL}/mobile/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_code: fixtures.tenantA.code,
      username: fixtures.tenantA.username,
      password: fixtures.tenantA.password,
    }),
  })
  const json = await res.json()
  if (!json?.data?.access_token) throw new Error(`login failed: ${JSON.stringify(json)}`)
  return json.data.access_token
}

/**
 * One lot, deliberately split across both halves of a recall: some units already
 * dispatched (unrecoverable) and some still on hand (a hold can stop them). A
 * fixture with only on-hand stock would let a broken shipped/on-hand split pass.
 */
async function seed(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query("BEGIN")
    try {
      const itemCode = `ITM-LOT-${SUFFIX}`
      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active,
                            is_batch_tracked, is_expiry_tracked)
         VALUES ($1, $2, $3, 'PCS', true, true, true)
         RETURNING id`,
        [companyId, itemCode, `Lot trace ${itemCode}`]
      )
      const itemId = Number(item.rows[0].id)

      const grnLine = await db.query(
        `SELECT gl.id, gl.grn_header_id FROM grn_line_items gl
          WHERE gl.company_id = $1 ORDER BY gl.id DESC LIMIT 1`,
        [companyId]
      )
      const grnLineId = Number(grnLine.rows[0]?.id)
      if (!grnLineId) throw new Error("No GRN line fixture to hang stock off")

      const doHeader = await db.query(
        `INSERT INTO do_header (
           company_id, do_number, request_date, client_id, warehouse_id, requested_by,
           total_items, total_quantity_requested, total_quantity_dispatched, status, allocation_rule
         )
         VALUES ($1, $2, CURRENT_DATE, $3, $4, 'Recall test', 1, 2, 0, 'STAGED', 'FIFO')
         RETURNING id`,
        [companyId, `DO-LOT-${SUFFIX}`, clientId, warehouseId]
      )
      const doId = Number(doHeader.rows[0].id)
      const doLine = await db.query(
        `INSERT INTO do_line_items (company_id, do_header_id, line_number, item_id,
                                    quantity_requested, quantity_dispatched, uom)
         VALUES ($1, $2, 1, $3, 2, 0, 'PCS')
         RETURNING id`,
        [companyId, doId, itemId]
      )
      const doLineId = Number(doLine.rows[0].id)

      const serials = {}
      // Two units still on hand, one already gone out on an earlier DO line.
      for (const tag of ["ONHAND_1", "ONHAND_2"]) {
        const row = await db.query(
          `INSERT INTO stock_serial_numbers (
             company_id, serial_number, item_id, client_id, warehouse_id, status,
             received_date, grn_line_item_id, batch_number, expiry_date, bin_location
           )
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE - INTERVAL '10 days',
                   $6, $7, CURRENT_DATE + INTERVAL '200 days', 'A1-01')
           RETURNING id`,
          [companyId, `SER-LOT-${SUFFIX}-${tag}`, itemId, clientId, warehouseId, grnLineId, BATCH]
        )
        serials[tag] = Number(row.rows[0].id)
      }
      const shipped = await db.query(
        `INSERT INTO stock_serial_numbers (
           company_id, serial_number, item_id, client_id, warehouse_id, status,
           received_date, dispatched_date, grn_line_item_id, do_line_item_id,
           batch_number, expiry_date
         )
         VALUES ($1, $2, $3, $4, $5, 'DISPATCHED', CURRENT_DATE - INTERVAL '10 days',
                 CURRENT_DATE - INTERVAL '2 days', $6, $7, $8, CURRENT_DATE + INTERVAL '200 days')
         RETURNING id`,
        [
          companyId,
          `SER-LOT-${SUFFIX}-SHIPPED`,
          itemId,
          clientId,
          warehouseId,
          grnLineId,
          doLineId,
          BATCH,
        ]
      )
      serials.SHIPPED = Number(shipped.rows[0].id)

      await db.query("COMMIT")
      return { companyId, clientId, itemId, itemCode, doId, doLineId, serials }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

async function cleanup(seeded) {
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
    await db.query(`DELETE FROM stock_batch_status WHERE company_id = $1 AND batch_number = $2`, [
      seeded.companyId,
      BATCH,
    ])
    await deleteTestFixtures(db, {
      companyId: seeded.companyId,
      itemIds: [seeded.itemId],
      doIds: [seeded.doId],
    })
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const seeded = await seed(fixtures)
  const lotQuery = `client_id=${seeded.clientId}&item_id=${seeded.itemId}&batch=${BATCH}`

  try {
    console.log("== Lot master ==")
    const lots = must("lot list", await api(`/stock/lots?batch=${BATCH}`, { token }))
    const lot = lots.rows.find((r) => r.batch_number === BATCH)
    check("the lot appears in the master", Boolean(lot), `rows=${lots.rows.length}`)
    check("on-hand and dispatched are counted separately", lot?.on_hand_units === 2 && lot?.dispatched_units === 1,
      `on_hand=${lot?.on_hand_units} dispatched=${lot?.dispatched_units}`)
    check("an unheld lot reads as allocatable", lot?.batch_status === "ACTIVE" && lot?.disposition === "Allocatable",
      `${lot?.batch_status} / ${lot?.disposition}`)

    console.log("\n== Genealogy ==")
    const trace = must("lot trace", await api(`/stock/lots/trace?${lotQuery}`, { token }))
    check("the lot traces back to a GRN", trace.inbound.length > 0,
      `grns=${trace.inbound.map((r) => r.grn_number).join(",")}`)
    check("the lot traces forward to a DO", trace.outbound.length > 0,
      `dos=${trace.outbound.map((r) => r.do_number).join(",")}`)
    check("on-hand stock reports its location", trace.locations.some((r) => r.bin_location === "A1-01"),
      JSON.stringify(trace.locations[0] ?? null))

    const serialTrace = must(
      "serial trace",
      await api(`/stock/lots/trace?serial=SER-LOT-${SUFFIX}-ONHAND_1`, { token })
    )
    check("a serial trace names its batch", serialTrace.serial?.batch_number === BATCH, serialTrace.serial?.batch_number)
    check("a serial trace carries its inbound document", Boolean(serialTrace.serial?.grn_number),
      String(serialTrace.serial?.grn_number))
    check("an unknown serial is a 404", (await api("/stock/lots/trace?serial=NOPE-000", { token })).status === 404)

    console.log("\n== Recall impact ==")
    const impact = must("recall impact", await api(`/stock/lots/recall?${lotQuery}`, { token }))
    check("impact separates what is still here", Number(impact.totals.on_hand_units) === 2,
      String(impact.totals.on_hand_units))
    check("impact separates what already shipped", Number(impact.totals.dispatched_units) === 1,
      String(impact.totals.dispatched_units))
    check("shipped rows name the DO to call about", impact.shipped.some((r) => r.do_number === `DO-LOT-${SUFFIX}`),
      impact.shipped.map((r) => r.do_number).join(","))

    console.log("\n== Holding a lot ==")
    const noReason = await api("/stock/lots/recall", {
      method: "POST",
      token,
      body: { client_id: seeded.clientId, item_id: seeded.itemId, batch: BATCH, status: "ON_HOLD" },
    })
    check("a hold without a reason is rejected", noReason.status === 400, `status=${noReason.status}`)

    const badStatus = await api("/stock/lots/recall", {
      method: "POST",
      token,
      body: { client_id: seeded.clientId, item_id: seeded.itemId, batch: BATCH, status: "FROZEN", reason: "x" },
    })
    check("an unknown status is rejected", badStatus.status === 400, `status=${badStatus.status}`)

    const held = must(
      "hold",
      await api("/stock/lots/recall", {
        method: "POST",
        token,
        body: {
          client_id: seeded.clientId,
          item_id: seeded.itemId,
          batch: BATCH,
          status: "RECALLED",
          reason: "Supplier quality notification",
          reference_no: `RECALL-${SUFFIX}`,
        },
      })
    )
    check("the hold reports what it stopped", Number(held.blocked_units) === 2, String(held.blocked_units))
    check("the hold reports what it could not stop", Number(held.already_shipped_units) === 1,
      String(held.already_shipped_units))

    const afterHold = must("lot list after hold", await api(`/stock/lots?batch=${BATCH}`, { token }))
    const heldLot = afterHold.rows.find((r) => r.batch_number === BATCH)
    check("the lot master shows the recall", heldLot?.batch_status === "RECALLED", heldLot?.batch_status)
    check("the disposition explains the block", String(heldLot?.disposition).includes("blocked from allocation"),
      heldLot?.disposition)

    console.log("\n== The point: held stock stops shipping ==")
    const blockedDispatch = await api(`/do/${seeded.doId}/dispatch`, {
      method: "POST",
      token,
      body: {
        items: [{ item_id: seeded.itemId, quantity: 1 }],
        vehicle_number: `KA01LOT${SUFFIX.slice(-3)}`,
        driver_name: "Recall Driver",
        driver_phone: "9000000002",
      },
    })
    check("dispatch of a recalled lot is refused", blockedDispatch.status === 409,
      `status=${blockedDispatch.status}`)
    const blockedMessage = String(blockedDispatch.json?.error?.message || blockedDispatch.json?.message || "")
    check("the refusal names the hold rather than blaming stock levels",
      blockedMessage.includes("held or recalled batch"), blockedMessage)

    console.log("\n== Releasing ==")
    must(
      "release",
      await api("/stock/lots/recall", {
        method: "POST",
        token,
        body: { client_id: seeded.clientId, item_id: seeded.itemId, batch: BATCH, status: "ACTIVE" },
      })
    )
    const released = await api(`/do/${seeded.doId}/dispatch`, {
      method: "POST",
      token,
      body: {
        items: [{ item_id: seeded.itemId, quantity: 1 }],
        vehicle_number: `KA01LOT${SUFFIX.slice(-3)}`,
        driver_name: "Recall Driver",
        driver_phone: "9000000002",
      },
    })
    check("dispatch works once the lot is released", released.res.ok, `status=${released.status}`)

    console.log("\n== Access control ==")
    check("unauthenticated lot list rejected", (await api("/stock/lots")).status === 401)
    check("unauthenticated hold rejected",
      (await api("/stock/lots/recall", { method: "POST", body: { batch: BATCH } })).status === 401)
    check("trace without a lot key is rejected", (await api("/stock/lots/trace", { token })).status === 400)
    check("recall for an unknown batch is a 404",
      (await api(`/stock/lots/recall?client_id=${seeded.clientId}&item_id=${seeded.itemId}&batch=NOPE`, { token }))
        .status === 404)
  } finally {
    await cleanup(seeded)
  }

  console.log("")
  if (failures) {
    console.error(`Lots: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log("Lots: all checks passed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
