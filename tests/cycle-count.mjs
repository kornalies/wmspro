/**
 * Track C acceptance: plan a cycle count, count it, decide the variance, and
 * assert what the decision did to stock.
 *
 * The assertions that matter are the asymmetric ones. A shortage must write
 * exactly the missing serials off and leave a LOST movement behind; an overage
 * must write NOTHING, because WMS cannot invent a serial number. A test that
 * only checked HTTP 200 would pass while silently fabricating inventory.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import { BASE_URL, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const BIN = `CCTEST-${SUFFIX}/R1/B1`
const ZONE = `CCTEST-${SUFFIX}`
const STOCK_QTY = 5

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
  return { res, json }
}

function must(label, result) {
  if (!result.res.ok) {
    throw new Error(`${label} failed: ${result.res.status} ${JSON.stringify(result.json)}`)
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

/** Put STOCK_QTY serials into a bin nothing else touches, so counts are exact. */
async function seedBin(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId, itemId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      // Session-scoped (is_local = false): withDb hands out a dedicated client and
      // a transaction-local setting would be discarded before the next statement.
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      const grnLine = await db.query(
        `SELECT gl.id FROM grn_line_items gl
         WHERE gl.company_id = $1 AND gl.item_id = $2 ORDER BY gl.id DESC LIMIT 1`,
        [companyId, itemId]
      )
      const grnLineId = Number(grnLine.rows[0]?.id)
      if (!grnLineId) throw new Error("No GRN line fixture to hang stock off")

      const itemCode = (
        await db.query(`SELECT item_code FROM items WHERE company_id = $1 AND id = $2`, [
          companyId,
          itemId,
        ])
      ).rows[0].item_code

      const serialIds = []
      for (let i = 0; i < STOCK_QTY; i++) {
        const row = await db.query(
          `INSERT INTO stock_serial_numbers (
             company_id, serial_number, item_id, client_id, warehouse_id,
             status, received_date, grn_line_item_id, bin_location
           )
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE - ($6 || ' days')::interval, $7, $8)
           RETURNING id`,
          [companyId, `SER-CC-${SUFFIX}-${i}`, itemId, clientId, warehouseId, String(STOCK_QTY - i), grnLineId, BIN]
        )
        serialIds.push(Number(row.rows[0].id))
      }

      await db.query("COMMIT")
      return { companyId, warehouseId, clientId, itemCode, serialIds }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

async function readStock(companyId, serialIds) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const s = await db.query(
      `SELECT status, COUNT(*)::int n FROM stock_serial_numbers WHERE id = ANY($1::int[]) GROUP BY status`,
      [serialIds]
    )
    const mv = await db.query(
      `SELECT COUNT(*)::int n FROM stock_movements
       WHERE company_id = $1 AND serial_number_id = ANY($2::int[]) AND movement_type = 'LOST'`,
      [companyId, serialIds]
    )
    return {
      byStatus: Object.fromEntries(s.rows.map((r) => [String(r.status), Number(r.n)])),
      lostMovements: Number(mv.rows[0].n),
    }
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const { companyId, warehouseId, itemCode, serialIds } = await seedBin(fixtures)

  // ---- planning -----------------------------------------------------------
  const plan = must(
    "create ZONE plan",
    await api("/stock/cycle-counts", {
      method: "POST",
      token,
      body: { warehouse_id: warehouseId, strategy: "ZONE", zone_code: ZONE, blind_count: true },
    })
  )
  check("plan raised with tasks", plan.total_tasks >= 1, `n=${plan.total_tasks}`)

  const detail = must("read plan", await api(`/stock/cycle-counts/plans/${plan.id}`, { token }))
  const task = detail.tasks.find((t) => t.bin_id === BIN && t.sku === itemCode)
  check("task covers the seeded bin", !!task, task ? `${task.bin_id} ${task.sku}` : "not found")
  // A blind count must not tell the counter the answer.
  check("blind task withholds expected qty", task?.expected_qty === null, String(task?.expected_qty))

  const emptyPlan = await api("/stock/cycle-counts", {
    method: "POST",
    token,
    body: { warehouse_id: warehouseId, strategy: "ZONE", zone_code: `NOPE-${SUFFIX}` },
  })
  check("empty scope rejected", emptyPlan.res.status === 409, `status=${emptyPlan.res.status}`)

  // ---- exact count needs no approval --------------------------------------
  const exact = must(
    "submit exact count",
    await api(`/stock/cycle-counts/tasks/${task.id}/count`, {
      method: "POST",
      token,
      body: { counted_qty: STOCK_QTY },
    })
  )
  check("exact count resolves expected from live stock", exact.expected_qty === STOCK_QTY, `expected=${exact.expected_qty}`)
  check("exact count needs no approval", exact.requires_approval === false)

  let stock = await readStock(companyId, serialIds)
  check("exact count did not touch stock", (stock.byStatus.IN_STOCK ?? 0) === STOCK_QTY, JSON.stringify(stock.byStatus))

  // ---- shortage: approving must write stock off ----------------------------
  const plan2 = must(
    "create second plan",
    await api("/stock/cycle-counts", {
      method: "POST",
      token,
      body: { warehouse_id: warehouseId, strategy: "MANUAL", bin_locations: [BIN], blind_count: false },
    })
  )
  const detail2 = must("read second plan", await api(`/stock/cycle-counts/plans/${plan2.id}`, { token }))
  const task2 = detail2.tasks.find((t) => t.sku === itemCode)
  check("non-blind task shows expected qty", task2?.expected_qty === STOCK_QTY, String(task2?.expected_qty))

  const short = must(
    "submit short count",
    await api(`/stock/cycle-counts/tasks/${task2.id}/count`, {
      method: "POST",
      token,
      body: { counted_qty: STOCK_QTY - 2 },
    })
  )
  check("shortage flagged for approval", short.requires_approval === true && short.discrepancy === -2, `d=${short.discrepancy}`)

  stock = await readStock(companyId, serialIds)
  check("stock untouched before approval", (stock.byStatus.IN_STOCK ?? 0) === STOCK_QTY, JSON.stringify(stock.byStatus))

  const closeBlocked = await api(`/stock/cycle-counts/plans/${plan2.id}`, { method: "POST", token })
  check("plan cannot close over an undecided variance", closeBlocked.res.status === 409, `status=${closeBlocked.res.status}`)

  const approved = must(
    "approve shortage",
    await api(`/stock/cycle-counts/submissions/${short.submission_id}/approve`, {
      method: "POST",
      token,
      body: { decision: "APPROVED", remarks: "Confirmed missing on recount" },
    })
  )
  check("approval wrote off exactly the shortfall", approved.adjustedSerialCount === 2, `n=${approved.adjustedSerialCount}`)

  stock = await readStock(companyId, serialIds)
  check("two serials cancelled", (stock.byStatus.CANCELLED ?? 0) === 2, JSON.stringify(stock.byStatus))
  check("three serials remain in stock", (stock.byStatus.IN_STOCK ?? 0) === STOCK_QTY - 2, JSON.stringify(stock.byStatus))
  check("write-off left a LOST movement per serial", stock.lostMovements === 2, `n=${stock.lostMovements}`)

  const replay = await api(`/stock/cycle-counts/submissions/${short.submission_id}/approve`, {
    method: "POST",
    token,
    body: { decision: "APPROVED" },
  })
  check("approving twice is blocked", replay.res.status === 409, `status=${replay.res.status}`)

  const closeOk = must("close plan after decision", await api(`/stock/cycle-counts/plans/${plan2.id}`, { method: "POST", token }))
  check("plan closed", closeOk.status === "CLOSED", closeOk.status)

  // ---- overage: approving must NOT invent stock ----------------------------
  const plan3 = must(
    "create overage plan",
    await api("/stock/cycle-counts", {
      method: "POST",
      token,
      body: { warehouse_id: warehouseId, strategy: "MANUAL", bin_locations: [BIN], blind_count: false },
    })
  )
  const detail3 = must("read overage plan", await api(`/stock/cycle-counts/plans/${plan3.id}`, { token }))
  const task3 = detail3.tasks.find((t) => t.sku === itemCode)

  // Two serials were written off above, so live on-hand is now STOCK_QTY - 2.
  // The expected figure is resolved from stock at count time, not from the
  // original plan, so the discrepancy is measured against 3 rather than 5.
  const onHandNow = STOCK_QTY - 2
  const overCount = onHandNow + 4
  const over = must(
    "submit over count",
    await api(`/stock/cycle-counts/tasks/${task3.id}/count`, {
      method: "POST",
      token,
      body: { counted_qty: overCount },
    })
  )
  check("overage measured against live on-hand", over.expected_qty === onHandNow, `expected=${over.expected_qty}`)
  check("overage flagged for approval", over.discrepancy === 4, `d=${over.discrepancy}`)

  const overApproved = must(
    "approve overage",
    await api(`/stock/cycle-counts/submissions/${over.submission_id}/approve`, {
      method: "POST",
      token,
      body: { decision: "APPROVED" },
    })
  )
  check("overage adjusted nothing", overApproved.adjustedSerialCount === 0, `n=${overApproved.adjustedSerialCount}`)

  const afterOver = await readStock(companyId, serialIds)
  check(
    "overage did not fabricate stock",
    (afterOver.byStatus.IN_STOCK ?? 0) === STOCK_QTY - 2,
    JSON.stringify(afterOver.byStatus)
  )

  // ---- rejection leaves stock alone ---------------------------------------
  const plan4 = must(
    "create rejection plan",
    await api("/stock/cycle-counts", {
      method: "POST",
      token,
      body: { warehouse_id: warehouseId, strategy: "MANUAL", bin_locations: [BIN], blind_count: false },
    })
  )
  const detail4 = must("read rejection plan", await api(`/stock/cycle-counts/plans/${plan4.id}`, { token }))
  const task4 = detail4.tasks.find((t) => t.sku === itemCode)
  const rej = must(
    "submit count to reject",
    await api(`/stock/cycle-counts/tasks/${task4.id}/count`, {
      method: "POST",
      token,
      body: { counted_qty: 0 },
    })
  )
  must(
    "reject variance",
    await api(`/stock/cycle-counts/submissions/${rej.submission_id}/approve`, {
      method: "POST",
      token,
      body: { decision: "REJECTED", remarks: "Miscount, recount scheduled" },
    })
  )
  const afterReject = await readStock(companyId, serialIds)
  check(
    "rejection left stock untouched",
    (afterReject.byStatus.IN_STOCK ?? 0) === STOCK_QTY - 2,
    JSON.stringify(afterReject.byStatus)
  )

  // ---- queue and rejections ------------------------------------------------
  const queue = must("read queue", await api("/stock/cycle-counts", { token }))
  check("queue reports accuracy", typeof queue.accuracy?.counts === "number", JSON.stringify(queue.accuracy))
  check("queue lists plans", queue.plans.length >= 3, `n=${queue.plans.length}`)

  const anon = await fetch(`${BASE_URL}/stock/cycle-counts`)
  check("unauthenticated read rejected", anon.status === 401, `status=${anon.status}`)

  const badId = await api(`/stock/cycle-counts/submissions/not-a-uuid/approve`, {
    method: "POST",
    token,
    body: { decision: "APPROVED" },
  })
  check("non-uuid submission id rejected", badId.res.status === 400, `status=${badId.res.status}`)

  console.log("")
  if (failures > 0) {
    console.log(`Cycle count: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log("Cycle count: all checks passed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})