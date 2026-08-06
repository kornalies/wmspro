/**
 * Stock Transfer Note and Inventory Adjustment Report.
 *
 * Both were descoped from the document work because they were missing RECORDS,
 * not missing documents. So the assertions are about the records: that a
 * transfer's stock stops being allocatable the moment it leaves, that a short
 * receipt leaves the missing units in transit rather than quietly restoring
 * them, and that a draft adjustment changes nothing until someone approves it.
 *
 * The documents are checked last, and only for the things that make them
 * evidence rather than decoration — the serial numbers on an adjustment, the
 * shortfall on a transfer.
 *
 * Requires a running dev server and a migrated database.
 */

import process from "node:process"
import { BASE_URL, deleteTestFixtures, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)

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

const TEARDOWN = { companyId: 0, itemIds: [], doIds: [] }

/** A dedicated item, a second warehouse to transfer into, and three units. */
async function seed(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query("BEGIN")
    try {
      const itemCode = `ITM-TAIL-STN-${SUFFIX}`
      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active, is_batch_tracked)
         VALUES ($1, $2, $3, 'PCS', true, true) RETURNING id`,
        [companyId, itemCode, `Transfer test ${itemCode}`]
      )
      const itemId = Number(item.rows[0].id)

      // A destination warehouse of our own, so the test never depends on the
      // fixture tenant happening to have two.
      const dest = await db.query(
        `INSERT INTO warehouses (company_id, warehouse_code, warehouse_name, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [companyId, `WH-STN-${SUFFIX}`.slice(0, 20), `Transfer destination ${SUFFIX}`]
      )
      const destWarehouseId = Number(dest.rows[0].id)

      const grnLine = await db.query(
        `SELECT id FROM grn_line_items WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [companyId]
      )
      const grnLineId = Number(grnLine.rows[0]?.id)
      if (!grnLineId) throw new Error("No GRN line fixture to hang stock off")

      const serials = []
      for (let i = 1; i <= 3; i++) {
        const row = await db.query(
          `INSERT INTO stock_serial_numbers (
             company_id, serial_number, item_id, client_id, warehouse_id, status,
             received_date, grn_line_item_id, batch_number, expiry_date
           )
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE - INTERVAL '5 days',
                   $6, $7, CURRENT_DATE + INTERVAL '300 days')
           RETURNING id`,
          [
            companyId,
            `SER-STN-${SUFFIX}-${i}`,
            itemId,
            clientId,
            warehouseId,
            grnLineId,
            `BATCH-STN-${SUFFIX}`,
          ]
        )
        serials.push(Number(row.rows[0].id))
      }

      await db.query("COMMIT")
      TEARDOWN.companyId = companyId
      TEARDOWN.itemIds.push(itemId)
      return { companyId, clientId, warehouseId, destWarehouseId, itemId, serials, grnLineId }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

async function serialStatuses(companyId, itemId) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT status, warehouse_id, COUNT(*)::int AS n
         FROM stock_serial_numbers WHERE company_id = $1 AND item_id = $2
        GROUP BY status, warehouse_id ORDER BY status`,
      [companyId, itemId]
    )
    return r.rows
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const seeded = await seed(fixtures)

  try {
    console.log("== Stock transfer: the state machine ==")
    const created = must(
      "create transfer",
      await api("/stock/transfers", {
        method: "POST",
        token,
        body: {
          client_id: seeded.clientId,
          from_warehouse_id: seeded.warehouseId,
          to_warehouse_id: seeded.destWarehouseId,
          reason: "Rebalancing",
          lines: [{ item_id: seeded.itemId, quantity: 3 }],
        },
      })
    )
    const transferId = Number(created.id)
    check("a new transfer starts as a draft", created.status === "DRAFT", created.status)
    check("it gets a transfer number", /^STN-\d{4}-\d{6}$/.test(String(created.transfer_number)),
      String(created.transfer_number))

    const sameWarehouse = await api("/stock/transfers", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        from_warehouse_id: seeded.warehouseId,
        to_warehouse_id: seeded.warehouseId,
        lines: [{ item_id: seeded.itemId, quantity: 1 }],
      },
    })
    check("a transfer to the same warehouse is rejected", sameWarehouse.status === 400,
      `status=${sameWarehouse.status}`)

    // Dispatching before approval would make the approval decorative.
    const earlyDispatch = await api(`/stock/transfers/${transferId}`, {
      method: "POST",
      token,
      body: { action: "dispatch" },
    })
    check("dispatch before approval is blocked", earlyDispatch.status === 409,
      `status=${earlyDispatch.status} ${String(earlyDispatch.json?.error?.message ?? "").slice(0, 80)}`)

    must("approve", await api(`/stock/transfers/${transferId}`, {
      method: "POST", token, body: { action: "approve" },
    }))

    console.log("\n== Dispatch takes the stock out of circulation ==")
    const dispatched = must("dispatch", await api(`/stock/transfers/${transferId}`, {
      method: "POST", token, body: { action: "dispatch" },
    }))
    check("all three units went", Number(dispatched.sent) === 3, String(dispatched.sent))

    const afterDispatch = await serialStatuses(seeded.companyId, seeded.itemId)
    check("dispatched units are IN_TRANSIT",
      afterDispatch.some((r) => r.status === "IN_TRANSIT" && r.n === 3),
      JSON.stringify(afterDispatch))
    check("they are still at the source warehouse until received",
      afterDispatch.every((r) => Number(r.warehouse_id) === seeded.warehouseId),
      JSON.stringify(afterDispatch))

    // The point of a distinct IN_TRANSIT status: the source can no longer promise
    // this stock to anybody.
    const lots = must("lot master", await api(`/stock/lots?batch=BATCH-STN-${SUFFIX}`, { token }))
    const lot = lots.rows.find((r) => r.batch_number === `BATCH-STN-${SUFFIX}`)
    check("in-transit stock is still counted as ours", Number(lot?.on_hand_units) === 3,
      String(lot?.on_hand_units))

    console.log("\n== A short receipt leaves the difference in transit ==")
    const detail = must("transfer detail", await api(`/stock/transfers/${transferId}`, { token }))
    const onTruck = detail.serials.map((s) => Number(s.serial_id))
    const received = must("receive short", await api(`/stock/transfers/${transferId}`, {
      method: "POST",
      token,
      // Two of three arrive.
      body: { action: "receive", received_serial_ids: onTruck.slice(0, 2) },
    }))
    check("the receipt records the shortfall", Number(received.short) === 1, String(received.short))

    const afterReceipt = await serialStatuses(seeded.companyId, seeded.itemId)
    const atDestination = afterReceipt.find(
      (r) => r.status === "IN_STOCK" && Number(r.warehouse_id) === seeded.destWarehouseId
    )
    const stillInTransit = afterReceipt.find((r) => r.status === "IN_TRANSIT")
    check("received units moved to the destination", Number(atDestination?.n) === 2,
      JSON.stringify(afterReceipt))
    check("the missing unit stays in transit rather than reappearing",
      Number(stillInTransit?.n) === 1, JSON.stringify(afterReceipt))

    const late = await api(`/stock/transfers/${transferId}`, {
      method: "POST", token, body: { action: "cancel" },
    })
    check("a received transfer cannot be cancelled", late.status === 409, `status=${late.status}`)

    console.log("\n== Inventory adjustment: a draft changes nothing ==")
    const missingSerial = `SER-STN-${SUFFIX}-3`
    const adjustment = must("create adjustment", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "LOSS",
        reason: "Not received on transfer",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [missingSerial] }],
      },
    }))
    check("a new adjustment is a draft", adjustment.status === "DRAFT", adjustment.status)
    check("it gets an adjustment number", /^IAR-\d{4}-\d{6}$/.test(String(adjustment.adjustment_number)),
      String(adjustment.adjustment_number))

    const beforeApproval = await serialStatuses(seeded.companyId, seeded.itemId)
    check("raising the adjustment did not touch stock",
      beforeApproval.some((r) => r.status === "IN_TRANSIT" && r.n === 1),
      JSON.stringify(beforeApproval))

    const noSerials = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "LOSS",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [] }],
      },
    })
    check("an adjustment without serial numbers is refused", noSerials.status === 400,
      String(noSerials.json?.error?.message ?? "").slice(0, 90))

    const badReason = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "BECAUSE",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [missingSerial] }],
      },
    })
    check("an unknown reason code is refused", badReason.status === 400, `status=${badReason.status}`)

    console.log("\n== Approval is what moves stock ==")
    // The whole reason these two features shipped together: the unit lost in
    // transit is written off by an adjustment, which is what the transfer note's
    // discrepancy paragraph tells the reader to do.
    const lostApproved = must("approve loss", await api(`/stock/adjustments/${adjustment.id}`, {
      method: "POST", token, body: { action: "approve" },
    }))
    check("the unit lost in transit can be written off", Number(lostApproved.decreased) === 1,
      String(lostApproved.decreased))
    const afterLoss = await serialStatuses(seeded.companyId, seeded.itemId)
    check("nothing is left in transit afterwards",
      !afterLoss.some((r) => r.status === "IN_TRANSIT"), JSON.stringify(afterLoss))

    // Writing off the same unit twice would double-count the loss.
    const twice = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "LOSS",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [missingSerial] }],
      },
    })
    check("an already written-off unit cannot be written off again", twice.status === 400,
      String(twice.json?.error?.message ?? "").slice(0, 90))

    // A write-off of stock actually on hand: one of the two that did arrive.
    const arrived = must("adjustment on received stock", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.destWarehouseId,
        reason_code: "DAMAGE",
        reason: "Damaged in transit",
        lines: [
          {
            item_id: seeded.itemId,
            direction: "DECREASE",
            serials: [`SER-STN-${SUFFIX}-1`],
          },
        ],
      },
    }))
    const approved = must("approve adjustment", await api(`/stock/adjustments/${arrived.id}`, {
      method: "POST", token, body: { action: "approve" },
    }))
    check("approval reports what it wrote off", Number(approved.decreased) === 1,
      String(approved.decreased))

    const afterWriteOff = await serialStatuses(seeded.companyId, seeded.itemId)
    const cancelled = afterWriteOff
      .filter((r) => r.status === "CANCELLED")
      .reduce((sum, r) => sum + Number(r.n), 0)
    check("written-off units are CANCELLED, not deleted", cancelled === 2, JSON.stringify(afterWriteOff))

    const reApprove = await api(`/stock/adjustments/${arrived.id}`, {
      method: "POST", token, body: { action: "approve" },
    })
    check("an approved adjustment cannot be approved twice", reApprove.status === 409,
      `status=${reApprove.status}`)

    console.log("\n== Adding stock names the units, and their provenance ==")
    const noProvenance = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.destWarehouseId,
        reason_code: "FOUND",
        lines: [
          { item_id: seeded.itemId, direction: "INCREASE", serials: [`SER-STN-${SUFFIX}-ORPHAN`] },
        ],
      },
    })
    check("found stock must say which receipt it came in on", noProvenance.status === 400,
      String(noProvenance.json?.error?.message ?? "").slice(0, 90))

    const found = must("found stock", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.destWarehouseId,
        reason_code: "FOUND",
        reason: "Located behind racking",
        lines: [
          {
            item_id: seeded.itemId,
            direction: "INCREASE",
            serials: [`SER-STN-${SUFFIX}-FOUND`],
            grn_line_item_id: seeded.grnLineId,
            batch_number: `BATCH-STN-${SUFFIX}`,
          },
        ],
      },
    }))
    const foundApproved = must("approve found", await api(`/stock/adjustments/${found.id}`, {
      method: "POST", token, body: { action: "approve" },
    }))
    check("approval created the named unit", Number(foundApproved.increased) === 1,
      String(foundApproved.increased))

    const duplicate = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.destWarehouseId,
        reason_code: "FOUND",
        lines: [
          {
            item_id: seeded.itemId,
            direction: "INCREASE",
            serials: [`SER-STN-${SUFFIX}-FOUND`],
            grn_line_item_id: seeded.grnLineId,
          },
        ],
      },
    })
    check("an increase cannot re-create stock that already exists", duplicate.status === 400,
      String(duplicate.json?.error?.message ?? "").slice(0, 90))

    console.log("\n== Rejection ==")
    const toReject = must("adjustment to reject", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.destWarehouseId,
        reason_code: "OTHER",
        reason: "Speculative",
        lines: [
          { item_id: seeded.itemId, direction: "DECREASE", serials: [`SER-STN-${SUFFIX}-2`] },
        ],
      },
    }))
    must("reject", await api(`/stock/adjustments/${toReject.id}`, {
      method: "POST", token, body: { action: "reject", reason: "Not evidenced" },
    }))
    const rejectedSerial = await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
      const r = await db.query(
        `SELECT status FROM stock_serial_numbers WHERE company_id = $1 AND serial_number = $2`,
        [seeded.companyId, `SER-STN-${SUFFIX}-2`]
      )
      return r.rows[0]?.status
    })
    check("a rejected adjustment leaves its stock alone", rejectedSerial === "IN_STOCK",
      String(rejectedSerial))

    console.log("\n== The documents ==")
    const stn = must("stock transfer note",
      await api(`/documents/stock-transfer-note/${transferId}`, { token }))
    check("the transfer note renders", stn.type === "stock-transfer-note", stn.type)
    const stnText = JSON.stringify(stn)
    check("it reports the shortfall rather than netting it", stnText.includes("Discrepancy"),
      stnText.includes("Discrepancy") ? "present" : "missing")
    check("it names both warehouses",
      stnText.includes("Dispatching Warehouse") && stnText.includes("Receiving Warehouse"))

    const iar = must("adjustment report",
      await api(`/documents/inventory-adjustment-report/${arrived.id}`, { token }))
    check("the adjustment report renders", iar.type === "inventory-adjustment-report", iar.type)
    const iarText = JSON.stringify(iar)
    check("it prints the serial numbers, not just a quantity",
      iarText.includes(`SER-STN-${SUFFIX}-1`))
    check("it states that stock was updated", iarText.includes("Stock Updated"))

    const draftDoc = must("draft adjustment report",
      await api(`/documents/inventory-adjustment-report/${toReject.id}`, { token }))
    check("a report for an unapproved adjustment says so",
      JSON.stringify(draftDoc).includes("NOT been applied"))

    console.log("\n== Access control ==")
    check("unauthenticated transfer list rejected", (await api("/stock/transfers")).status === 401)
    check("unauthenticated adjustment list rejected", (await api("/stock/adjustments")).status === 401)
    check("unknown transfer is a 404", (await api("/stock/transfers/99999999", { token })).status === 404)
    check("an unknown action is refused",
      (await api(`/stock/transfers/${transferId}`, { method: "POST", token, body: { action: "teleport" } }))
        .status === 400)
  } finally {
    await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(TEARDOWN.companyId)])
      // Transfers and adjustments cascade from their headers, but they reference
      // the serials, so they have to go before deleteTestFixtures removes those.
      await db.query(
        `DELETE FROM stock_transfer_header WHERE company_id = $1 AND transfer_number LIKE 'STN-%'
           AND id IN (SELECT transfer_id FROM stock_transfer_lines WHERE item_id = ANY($2::int[]))`,
        [TEARDOWN.companyId, TEARDOWN.itemIds]
      )
      await db.query(
        `DELETE FROM inventory_adjustment_header WHERE company_id = $1
           AND id IN (SELECT adjustment_id FROM inventory_adjustment_lines WHERE item_id = ANY($2::int[]))`,
        [TEARDOWN.companyId, TEARDOWN.itemIds]
      )
      await deleteTestFixtures(db, TEARDOWN)
      await db.query(`DELETE FROM warehouses WHERE company_id = $1 AND warehouse_code LIKE $2`, [
        TEARDOWN.companyId,
        `WH-STN-%`,
      ])
    }).catch((error) => {
      console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  console.log("")
  if (failures) {
    console.log(`Stock transfer / adjustment: ${failures} check(s) failed.`)
    return
  }
  console.log("Stock transfer / adjustment: all checks passed.")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    failures = failures || 1
  })
  .finally(() => process.exit(failures ? 1 : 0))
