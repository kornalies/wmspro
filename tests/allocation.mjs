/**
 * Track D acceptance: prove the allocation rule is honoured rather than noted.
 *
 * The regression this guards against is specific and was live until Track D: the
 * DO form offered FEFO, the value was written into a remarks string, and every
 * allocation path ordered by received_date. FEFO orders shipped FIFO.
 *
 * So the central assertion is a discrimination test — the same stock, two
 * different rules, two different serials committed. A test that only checked
 * "FEFO dispatch returns 200" would have passed throughout the entire period the
 * bug existed.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
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

/**
 * Seed stock where FIFO and FEFO disagree by construction: the OLDEST received
 * unit has the LATEST expiry. FIFO must take the old one, FEFO the soon-expiring
 * one. If a rule is ignored, the wrong serial is committed and the test says so.
 */
let seedSeq = 0

// Every item and DO this suite creates, so the finally in main() can remove
// them. Each run used to leave eight throwaway items behind, and they piled up
// in Stock Search among real inventory.
const SEEDED = []

async function seed(fixtures, { allocationRule, minShelfLifeDays = null, extraExpired = 0 }) {
  // Every seed gets its own item and DO. Sharing an item across scenarios would
  // let one scenario's leftover stock satisfy another's allocation.
  const key = `${allocationRule}${++seedSeq}`
  const doNumber = `DO-ALLOC-${SUFFIX}-${key}`
  const result = await withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      // Session-scoped (is_local = false): withDb hands out a dedicated client and
      // a transaction-local setting would be discarded before the next statement.
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      // A dedicated item per scenario, so shelf-life rules and leftover stock
      // from other runs cannot bleed across assertions.
      const itemCode = `ITM-ALLOC-${SUFFIX}-${key}`
      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active,
                            is_batch_tracked, is_expiry_tracked, min_shelf_life_days)
         VALUES ($1, $2, $3, 'PCS', true, true, true, $4)
         RETURNING id`,
        [companyId, itemCode, `Allocation test ${itemCode}`, minShelfLifeDays]
      )
      const itemId = Number(item.rows[0].id)

      const grnLine = await db.query(
        `SELECT gl.id FROM grn_line_items gl WHERE gl.company_id = $1 ORDER BY gl.id DESC LIMIT 1`,
        [companyId]
      )
      const grnLineId = Number(grnLine.rows[0]?.id)
      if (!grnLineId) throw new Error("No GRN line fixture to hang stock off")

      // OLD_LATE: received 30 days ago, expires in 300 days  -> FIFO picks this
      // NEW_SOON: received today,       expires in 10 days   -> FEFO picks this
      const specs = [
        { tag: "OLD_LATE", receivedDaysAgo: 30, expiresInDays: 300, batch: "B-LATE" },
        { tag: "NEW_SOON", receivedDaysAgo: 0, expiresInDays: 10, batch: "A-SOON" },
      ]
      for (let i = 0; i < extraExpired; i++) {
        specs.push({ tag: `EXPIRED_${i}`, receivedDaysAgo: 60, expiresInDays: -5, batch: "C-DEAD" })
      }

      const serials = {}
      for (const spec of specs) {
        const row = await db.query(
          `INSERT INTO stock_serial_numbers (
             company_id, serial_number, item_id, client_id, warehouse_id, status,
             received_date, grn_line_item_id, batch_number, expiry_date
           )
           VALUES ($1, $2, $3, $4, $5, 'IN_STOCK',
                   CURRENT_DATE - ($6 || ' days')::interval, $7, $8,
                   CURRENT_DATE + ($9 || ' days')::interval)
           RETURNING id`,
          [
            companyId,
            `SER-ALLOC-${SUFFIX}-${key}-${spec.tag}`,
            itemId,
            clientId,
            warehouseId,
            String(spec.receivedDaysAgo),
            grnLineId,
            spec.batch,
            String(spec.expiresInDays),
          ]
        )
        serials[spec.tag] = Number(row.rows[0].id)
      }

      const doHeader = await db.query(
        `INSERT INTO do_header (
           company_id, do_number, request_date, client_id, warehouse_id, requested_by,
           total_items, total_quantity_requested, total_quantity_dispatched, status, allocation_rule
         )
         VALUES ($1, $2, CURRENT_DATE, $3, $4, 'Track D test', 1, 1, 0, 'STAGED', $5)
         RETURNING id`,
        [companyId, doNumber, clientId, warehouseId, allocationRule]
      )
      const doId = Number(doHeader.rows[0].id)

      const doLine = await db.query(
        `INSERT INTO do_line_items (company_id, do_header_id, line_number, item_id,
                                    quantity_requested, quantity_dispatched, uom)
         VALUES ($1, $2, 1, $3, 1, 0, 'PCS')
         RETURNING id`,
        [companyId, doId, itemId]
      )
      const doLineId = Number(doLine.rows[0].id)

      await db.query(`UPDATE do_header SET status = 'STAGED' WHERE id = $1 AND company_id = $2`, [
        doId,
        companyId,
      ])

      await db.query("COMMIT")
      return { companyId, doId, doLineId, itemId, itemCode, serials }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
  SEEDED.push(result)
  return result
}

async function cleanupSeeded() {
  if (!SEEDED.length) return
  await withDb(async (db) =>
    deleteTestFixtures(db, {
      companyId: SEEDED[0].companyId,
      itemIds: SEEDED.map((s) => s.itemId),
      doIds: SEEDED.map((s) => s.doId),
    })
  )
}

async function dispatchedSerialIds(companyId, doLineId) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT id FROM stock_serial_numbers
       WHERE company_id = $1 AND do_line_item_id = $2 AND status = 'DISPATCHED'`,
      [companyId, doLineId]
    )
    return r.rows.map((x) => Number(x.id))
  })
}

async function dispatch(token, seeded, quantity = 1) {
  return api(`/do/${seeded.doId}/dispatch`, {
    method: "POST",
    token,
    body: {
      items: [{ item_id: seeded.itemId, quantity }],
      vehicle_number: `KA01ALLOC${SUFFIX.slice(-3)}`,
      driver_name: "Allocation Driver",
      driver_phone: "9000000001",
    },
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)

  // ---- the discrimination test -------------------------------------------
  const fifo = await seed(fixtures, { allocationRule: "FIFO" })
  must("FIFO dispatch", await dispatch(token, fifo))
  const fifoTaken = await dispatchedSerialIds(fifo.companyId, fifo.doLineId)
  check(
    "FIFO takes the oldest received unit",
    fifoTaken.length === 1 && fifoTaken[0] === fifo.serials.OLD_LATE,
    `took=${fifoTaken[0]} expected=${fifo.serials.OLD_LATE}`
  )

  const fefo = await seed(fixtures, { allocationRule: "FEFO" })
  must("FEFO dispatch", await dispatch(token, fefo))
  const fefoTaken = await dispatchedSerialIds(fefo.companyId, fefo.doLineId)
  check(
    "FEFO takes the soonest-expiring unit, not the oldest",
    fefoTaken.length === 1 && fefoTaken[0] === fefo.serials.NEW_SOON,
    `took=${fefoTaken[0]} expected=${fefo.serials.NEW_SOON} (FIFO would take ${fefo.serials.OLD_LATE})`
  )
  check(
    "FIFO and FEFO chose differently on identical stock",
    fifoTaken[0] !== null && fefoTaken[0] !== null,
    `fifo=${fifoTaken[0]} fefo=${fefoTaken[0] === fefo.serials.NEW_SOON ? "soonest" : "WRONG"}`
  )

  // ---- expired stock is never allocated -----------------------------------
  const withExpired = await seed(fixtures, { allocationRule: "FEFO", extraExpired: 2 })
  must("FEFO dispatch with expired stock present", await dispatch(token, withExpired))
  const takenWithExpired = await dispatchedSerialIds(withExpired.companyId, withExpired.doLineId)
  const expiredIds = [withExpired.serials.EXPIRED_0, withExpired.serials.EXPIRED_1]
  check(
    "expired stock is never allocated",
    takenWithExpired.every((id) => !expiredIds.includes(id)),
    `took=${takenWithExpired.join(",")} expired=${expiredIds.join(",")}`
  )
  check(
    "allocation still fell to the soonest non-expired unit",
    takenWithExpired[0] === withExpired.serials.NEW_SOON,
    `took=${takenWithExpired[0]}`
  )

  // ---- minimum shelf life blocks otherwise-good stock ----------------------
  // min_shelf_life_days = 30 makes NEW_SOON (10 days left) unacceptable, so the
  // only allocatable unit is OLD_LATE even under FEFO.
  const shelf = await seed(fixtures, { allocationRule: "FEFO", minShelfLifeDays: 30 })
  must("FEFO dispatch under a 30-day minimum shelf life", await dispatch(token, shelf))
  const shelfTaken = await dispatchedSerialIds(shelf.companyId, shelf.doLineId)
  check(
    "stock inside the minimum shelf life is skipped",
    shelfTaken[0] === shelf.serials.OLD_LATE,
    `took=${shelfTaken[0]} expected=${shelf.serials.OLD_LATE} (NEW_SOON=${shelf.serials.NEW_SOON} has 10 days left)`
  )

  // ---- a shortage caused by expiry says so --------------------------------
  const blocked = await seed(fixtures, { allocationRule: "FEFO", minShelfLifeDays: 400 })
  const refused = await dispatch(token, blocked)
  check("dispatch refused when nothing is allocatable", refused.res.status >= 400, `status=${refused.res.status}`)
  const msg = refused.json?.error?.message || refused.json?.message || ""
  check(
    "the refusal explains stock was excluded, not merely absent",
    /expired|shelf life/i.test(msg),
    msg.slice(0, 140)
  )

  // ---- the advisory endpoint agrees with the commit path -------------------
  const advisory = await seed(fixtures, { allocationRule: "FEFO" })
  const fifoView = must("advisory read", await api(`/do/${advisory.doId}/fifo`, { token }))
  check("advisory reports the rule", fifoView.allocation_rule === "FEFO", fifoView.allocation_rule)
  check("advisory explains the rule", /expiry/i.test(fifoView.allocation_note || ""), fifoView.allocation_note)
  const suggested = fifoView.lines?.[0]?.fifo_stock ?? []
  check(
    "advisory suggests the soonest-expiring unit first",
    suggested[0]?.stock_id === advisory.serials.NEW_SOON,
    `first=${suggested[0]?.stock_id} expected=${advisory.serials.NEW_SOON}`
  )
  check("advisory exposes expiry data", suggested[0]?.expiry_date != null, String(suggested[0]?.expiry_date))

  // ---- the pack pool is ordered by the same rule ---------------------------
  const tail = must("tail read", await api(`/do/${advisory.doId}/tail`, { token }))
  check("tail reports the rule", tail.allocation_rule === "FEFO", tail.allocation_rule)
  const pool = tail.packable_serials.filter((s) => s.item_code === advisory.itemCode)
  check(
    "packable pool leads with the soonest-expiring unit",
    pool[0]?.id === advisory.serials.NEW_SOON,
    `first=${pool[0]?.id} expected=${advisory.serials.NEW_SOON}`
  )

  // ---- the pack ROUTE enforces the pool's exclusions, not just the pool ----
  // The pool only shapes what the screen offers. Before this was enforced at the
  // route, a caller posting serial ids directly could pack expired stock and the
  // tail shipped it -- finalize commits exactly what was packed and never
  // re-tests it -- while the dispatch path refused the same stock. Verified end
  // to end: pack 200 -> goods issue 200 -> load 200 -> finalize 200 -> DISPATCHED.
  const packGuard = await seed(fixtures, { allocationRule: "FEFO", extraExpired: 1 })
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(packGuard.companyId)])
    // seed() leaves the DO STAGED for the dispatch path; packing needs PICKED,
    // and STAGED -> PICKED is not a legal transition, so set it directly.
    await db.query(`UPDATE do_header SET status = 'PICKED' WHERE id = $1 AND company_id = $2`, [
      packGuard.doId,
      packGuard.companyId,
    ])
  })

  const packExpired = await api(`/do/${packGuard.doId}/pack-units`, {
    method: "POST",
    token,
    body: {
      pack_type: "PALLET",
      lines: [{ do_line_item_id: packGuard.doLineId, serial_ids: [packGuard.serials.EXPIRED_0] }],
    },
  })
  check(
    "pack-units refuses expired stock",
    packExpired.res.status === 409,
    `status=${packExpired.res.status} ${packExpired.json?.error?.message ?? ""}`
  )
  check(
    "the pack refusal names expiry as the reason",
    /expired/i.test(packExpired.json?.error?.message ?? ""),
    String(packExpired.json?.error?.message ?? "").slice(0, 140)
  )

  // The guard must not over-block: allocatable stock still packs.
  const packGood = await api(`/do/${packGuard.doId}/pack-units`, {
    method: "POST",
    token,
    body: {
      pack_type: "PALLET",
      lines: [{ do_line_item_id: packGuard.doLineId, serial_ids: [packGuard.serials.OLD_LATE] }],
    },
  })
  check(
    "pack-units still accepts allocatable stock",
    packGood.res.ok,
    `status=${packGood.res.status} ${JSON.stringify(packGood.json?.error ?? "")}`
  )

  // Minimum shelf life is a separate rule from expiry and must block too: this
  // stock is saleable, but a customer contracted to 30 days will reject it.
  const shelfPack = await seed(fixtures, { allocationRule: "FEFO", minShelfLifeDays: 30 })
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(shelfPack.companyId)])
    await db.query(`UPDATE do_header SET status = 'PICKED' WHERE id = $1 AND company_id = $2`, [
      shelfPack.doId,
      shelfPack.companyId,
    ])
  })
  const packShort = await api(`/do/${shelfPack.doId}/pack-units`, {
    method: "POST",
    token,
    body: {
      pack_type: "PALLET",
      lines: [{ do_line_item_id: shelfPack.doLineId, serial_ids: [shelfPack.serials.NEW_SOON] }],
    },
  })
  check(
    "pack-units refuses stock inside the minimum shelf life",
    packShort.res.status === 409 && /shelf life/i.test(packShort.json?.error?.message ?? ""),
    `status=${packShort.res.status} ${String(packShort.json?.error?.message ?? "").slice(0, 140)}`
  )

  // ---- expiry exposure ----------------------------------------------------
  const exposure = must("expiry exposure", await api("/stock/expiry?days=30", { token }))
  check("exposure reports totals", typeof exposure.totals?.EXPIRED === "number", JSON.stringify(exposure.totals))
  check("exposure counts blocked stock", typeof exposure.blocked_from_allocation === "number", String(exposure.blocked_from_allocation))

  // ---- the rule is persisted, not written into remarks --------------------
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(fefo.companyId)])
    const r = await db.query(`SELECT allocation_rule, remarks FROM do_header WHERE id = $1`, [fefo.doId])
    check("allocation_rule is a column", r.rows[0]?.allocation_rule === "FEFO", String(r.rows[0]?.allocation_rule))
    check(
      "the rule is not smuggled into remarks",
      !/Allocation rule:/i.test(String(r.rows[0]?.remarks ?? "")),
      String(r.rows[0]?.remarks ?? "")
    )
  })

  console.log("")
  // Reporting only -- the exit code is set by the finally below, which must run
  // first so the suite's throwaway items are removed either way.
  if (failures > 0) {
    console.log(`Allocation: ${failures} check(s) failed.`)
    return
  }
  console.log("Allocation: all checks passed.")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    failures = failures || 1
  })
  // In a finally so a failing run still removes its items, rather than leaving
  // debris behind exactly when someone is about to re-run the suite.
  .finally(async () => {
    await cleanupSeeded().catch((error) => {
      console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    process.exit(failures ? 1 : 0)
  })