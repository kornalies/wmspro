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
import bcrypt from "bcryptjs"
import {
  BASE_URL,
  CHAOS_PASSWORD,
  deleteTestFixtures,
  ensureChaosFixtures,
  withDb,
} from "./chaos/_shared.mjs"

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

      // A receipt of OUR item, for this client at this warehouse, rather than
      // whatever GRN line happened to be last in the table. Found stock has to
      // be attributed to a receipt of the same item, so a borrowed line would
      // make that path untestable — and would be a lie about where the units
      // came from.
      const grn = await db.query(
        `INSERT INTO grn_header (company_id, grn_number, warehouse_id, client_id, grn_date, status)
         VALUES ($1, $2, $3, $4, CURRENT_DATE - INTERVAL '6 days', 'CONFIRMED') RETURNING id`,
        [companyId, `GRN-STN-${SUFFIX}`, warehouseId, clientId]
      )
      const grnLine = await db.query(
        `INSERT INTO grn_line_items (company_id, grn_header_id, line_number, item_id, quantity, uom)
         VALUES ($1, $2, 1, $3, 10, 'PCS') RETURNING id`,
        [companyId, Number(grn.rows[0].id), itemId]
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

/** Who is holding this client's units, and in what state. */
async function serialHolds(companyId, itemId) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT status, transfer_line_id, do_line_item_id, COUNT(*)::int AS n
         FROM stock_serial_numbers WHERE company_id = $1 AND item_id = $2
        GROUP BY status, transfer_line_id, do_line_item_id ORDER BY status`,
      [companyId, itemId]
    )
    return r.rows
  })
}

/**
 * An OPERATOR in the same tenant — the role that raises transfers and, since
 * migration 075, must not be able to authorise them.
 */
async function seedOperator(companyId, warehouseId) {
  // A FIXED name, not a per-run one. The operator's actions are audited, and
  // audit_logs holds a foreign key to the actor, so a per-run user could never
  // be deleted and every run would leave another behind. One reusable fixture,
  // reactivated on each run and deactivated at the end, leaves nothing to clean.
  const username = "op_stn_fixture"
  const hash = await bcrypt.hash(CHAOS_PASSWORD, 10)
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

    // The RBAC rows this fixture needs are CREATED here rather than assumed.
    // CI restores db/baseline/schema_migrations.sql before migrating, so
    // migration 008 counts as already applied and its role/permission seed
    // never runs; scripts/db/seed.mjs only creates SUPER_ADMIN, ADMIN, CLIENT
    // and VIEWER. There is no OPERATOR role on a fresh CI database, and no
    // stock.putaway.manage permission. Every other suite misses this because
    // the fixture user is SUPER_ADMIN, which bypasses requirePermission
    // entirely -- this is the only test that exercises a real permission check.
    await db.query(
      `INSERT INTO rbac_roles (role_code, role_name, description, is_system, is_active)
       VALUES ('OPERATOR', 'Operator', 'Operations operator', true, true)
       ON CONFLICT (role_code) DO UPDATE SET is_active = true`
    )
    await db.query(
      `INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
       VALUES ('stock.putaway.manage', 'Manage Putaway', true)
       ON CONFLICT (permission_key) DO NOTHING`
    )
    // Raising and picking, but deliberately NOT stock.transfer.approve — the
    // absence of that grant is the control under test.
    await db.query(
      `INSERT INTO rbac_role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM rbac_roles r
         JOIN rbac_permissions p ON p.permission_key = 'stock.putaway.manage'
        WHERE r.role_code = 'OPERATOR'
       ON CONFLICT DO NOTHING`
    )

    const user = await db.query(
      `INSERT INTO users (company_id, username, email, full_name, role, password_hash,
                          warehouse_id, is_active)
       VALUES ($1, $2, $3, 'Transfer Operator', 'OPERATOR', $4, $5, true)
       ON CONFLICT (company_id, username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
       RETURNING id`,
      [companyId, username, `${username}@local`, hash, warehouseId]
    )
    await db.query(
      `INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
       SELECT $1, r.id, true FROM rbac_roles r WHERE r.role_code = 'OPERATOR'
       ON CONFLICT DO NOTHING`,
      [Number(user.rows[0].id)]
    )
  })
  return username
}

/**
 * Grant or revoke stock.transfer.approve on the OPERATOR role.
 *
 * Toggling the single permission and re-testing the same user is what proves
 * the gate is keyed on that permission and nothing else. Asserting via the
 * SUPER_ADMIN fixture instead would prove nothing: it bypasses the check.
 */
async function setOperatorApprove(companyId, granted) {
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    if (granted) {
      await db.query(
        `INSERT INTO rbac_role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM rbac_roles r
           JOIN rbac_permissions p ON p.permission_key = 'stock.transfer.approve'
          WHERE r.role_code = 'OPERATOR'
         ON CONFLICT DO NOTHING`
      )
    } else {
      await db.query(
        `DELETE FROM rbac_role_permissions rp
          USING rbac_roles r, rbac_permissions p
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
            AND r.role_code = 'OPERATOR'
            AND p.permission_key = 'stock.transfer.approve'`
      )
    }
  })
}

/**
 * Grant or revoke an arbitrary permission on the OPERATOR role.
 *
 * Same idea as {@link setOperatorApprove}: toggle one key and re-test the same
 * user, so the refusal is proven to come from that key and nothing else.
 */
async function setOperatorPermission(companyId, key, granted) {
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query(
      `INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
       VALUES ($1, $1, true) ON CONFLICT (permission_key) DO NOTHING`,
      [key]
    )
    if (granted) {
      await db.query(
        `INSERT INTO rbac_role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM rbac_roles r
           JOIN rbac_permissions p ON p.permission_key = $1
          WHERE r.role_code = 'OPERATOR'
         ON CONFLICT DO NOTHING`,
        [key]
      )
    } else {
      await db.query(
        `DELETE FROM rbac_role_permissions rp
          USING rbac_roles r, rbac_permissions p
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
            AND r.role_code = 'OPERATOR' AND p.permission_key = $1`,
        [key]
      )
    }
  })
}

/** Fresh units at the source warehouse, for the adjustment-flow section. */
async function seedUnits(seeded, prefix, count) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
    const names = []
    for (let i = 1; i <= count; i++) {
      const serial = `${prefix}-${i}`
      await db.query(
        `INSERT INTO stock_serial_numbers (
           company_id, serial_number, item_id, client_id, warehouse_id, status,
           received_date, grn_line_item_id, batch_number, expiry_date
         )
         VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE - ($6 || ' days')::interval,
                 $7, $8, CURRENT_DATE + INTERVAL '300 days')`,
        [
          seeded.companyId,
          serial,
          seeded.itemId,
          seeded.clientId,
          seeded.warehouseId,
          String(10 - i),
          seeded.grnLineId,
          `BATCH-STN-${SUFFIX}`,
        ]
      )
      names.push(serial)
    }
    return names
  })
}

/** Which serial, if any, a transfer line is currently holding. */
async function heldByTransfer(companyId, itemId) {
  return withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT serial_number FROM stock_serial_numbers
        WHERE company_id = $1 AND item_id = $2 AND transfer_line_id IS NOT NULL
        ORDER BY id LIMIT 1`,
      [companyId, itemId]
    )
    return r.rows[0]?.serial_number ?? null
  })
}

/** What a delivery order would be allowed to take right now. */
async function doAvailability(token, seeded) {
  const res = await api(
    `/do/inventory-availability?warehouse_id=${seeded.warehouseId}` +
      `&client_id=${seeded.clientId}&item_ids=${seeded.itemId}`,
    { token }
  )
  const rows = must("do availability", res)
  return Number(rows.find((r) => Number(r.item_id) === seeded.itemId)?.available_qty ?? -1)
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const seeded = await seed(fixtures)

  try {
    // Runs first, while the destination warehouse is still empty: it is the
    // warehouse this client demonstrably has no stock in, which is exactly the
    // situation that produced a transfer nobody could dispatch.
    console.log("== A transfer the source cannot cover ==")
    const availability = must(
      "availability",
      await api(
        `/stock/transfers/availability?client_id=${seeded.clientId}&warehouse_id=${seeded.destWarehouseId}`,
        { token }
      )
    )
    check(
      "an empty warehouse offers no items to transfer",
      !availability.rows.some((r) => Number(r.item_id) === seeded.itemId),
      JSON.stringify(availability.rows.slice(0, 3))
    )

    const sourceAvailability = must(
      "source availability",
      await api(
        `/stock/transfers/availability?client_id=${seeded.clientId}&warehouse_id=${seeded.warehouseId}`,
        { token }
      )
    )
    const seededRow = sourceAvailability.rows.find((r) => Number(r.item_id) === seeded.itemId)
    check("the stocked warehouse reports what it holds", Number(seededRow?.available) === 3,
      JSON.stringify(seededRow))

    const uncovered = must(
      "create uncovered transfer",
      await api("/stock/transfers", {
        method: "POST",
        token,
        body: {
          client_id: seeded.clientId,
          from_warehouse_id: seeded.destWarehouseId,
          to_warehouse_id: seeded.warehouseId,
          reason: "Raised against stock that is not there",
          lines: [{ item_id: seeded.itemId, quantity: 1 }],
        },
      })
    )
    // A draft is still a request, so raising it is allowed -- but it must say so.
    check("it is still raised as a draft", uncovered.status === "DRAFT", uncovered.status)
    check("the shortfall is reported at once", Number(uncovered.shortages?.[0]?.available) === 0,
      JSON.stringify(uncovered.shortages))

    const blocked = await api(`/stock/transfers/${Number(uncovered.id)}`, {
      method: "POST", token, body: { action: "approve" },
    })
    check("approving it is refused", blocked.status === 409, `status=${blocked.status}`)
    check("and the refusal says why",
      String(blocked.json?.error?.message ?? "").includes("does not have this stock"),
      String(blocked.json?.error?.message ?? "").slice(0, 90))

    const stillDraft = must("re-read uncovered transfer",
      await api(`/stock/transfers/${Number(uncovered.id)}`, { token }))
    check("a refused approval leaves it in DRAFT", stillDraft.transfer.status === "DRAFT",
      stillDraft.transfer.status)

    // Approval takes a real hold, and the hold has to be visible to the OTHER
    // module competing for the same stock. Runs before the main flow and gives
    // everything back, so what follows still sees three free units.
    console.log("\n== Approval holds the stock, cancellation gives it back ==")
    check("all three units start free", (await doAvailability(token, seeded)) === 3)

    const held = must("create transfer to hold stock", await api("/stock/transfers", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        from_warehouse_id: seeded.warehouseId,
        to_warehouse_id: seeded.destWarehouseId,
        lines: [{ item_id: seeded.itemId, quantity: 2 }],
      },
    }))
    must("approve the holding transfer", await api(`/stock/transfers/${Number(held.id)}`, {
      method: "POST", token, body: { action: "approve" },
    }))

    const afterHold = await serialHolds(seeded.companyId, seeded.itemId)
    check("approval pins two units to the transfer line",
      afterHold.filter((r) => r.transfer_line_id !== null).reduce((n, r) => n + r.n, 0) === 2,
      JSON.stringify(afterHold))
    // The whole reason the hold is a column and not a status: billing, reports
    // and cycle counts all key off IN_STOCK, and the stock has not moved.
    check("held stock is still IN_STOCK, not RESERVED",
      afterHold.every((r) => r.status === "IN_STOCK"), JSON.stringify(afterHold))
    check("a delivery order can no longer see the held units",
      (await doAvailability(token, seeded)) === 1)

    // Approving a second transfer for the remaining unit must not be able to
    // take what the first one holds.
    const second = must("create competing transfer", await api("/stock/transfers", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        from_warehouse_id: seeded.warehouseId,
        to_warehouse_id: seeded.destWarehouseId,
        lines: [{ item_id: seeded.itemId, quantity: 2 }],
      },
    }))
    const contested = await api(`/stock/transfers/${Number(second.id)}`, {
      method: "POST", token, body: { action: "approve" },
    })
    check("a second transfer cannot approve against held stock", contested.status === 409,
      `status=${contested.status}`)
    check("and it is told only one unit is free",
      String(contested.json?.error?.message ?? "").includes("available 1"),
      String(contested.json?.error?.message ?? "").slice(-40))

    // Cancelling from PICKED has more to undo than cancelling from APPROVED:
    // the units are staged against the transfer, not merely claimed.
    must("pick the holding transfer", await api(`/stock/transfers/${Number(held.id)}`, {
      method: "POST", token, body: { action: "pick" },
    }))
    const releasedTransfer = must("cancel the holding transfer",
      await api(`/stock/transfers/${Number(held.id)}`, {
        method: "POST", token, body: { action: "cancel" },
      }))
    const unstaged = must("re-read the cancelled transfer",
      await api(`/stock/transfers/${Number(held.id)}`, { token }))
    check("cancelling un-stages the pick", unstaged.serials.length === 0,
      String(unstaged.serials.length))
    check("and zeroes the picked quantity",
      unstaged.lines.every((l) => Number(l.quantity_picked) === 0),
      JSON.stringify(unstaged.lines.map((l) => l.quantity_picked)))
    check("cancelling reports what it released", Number(releasedTransfer.released) === 2,
      String(releasedTransfer.released))
    check("the units are free again", (await doAvailability(token, seeded)) === 3)
    const afterRelease = await serialHolds(seeded.companyId, seeded.itemId)
    check("no hold survives the cancellation",
      afterRelease.every((r) => r.transfer_line_id === null), JSON.stringify(afterRelease))

    console.log("\n== Stock transfer: the state machine ==")
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

    console.log("\n== The pick stages the stock without moving it ==")
    // Gate-out before the pick would put the paperwork ahead of the pallet,
    // which is the failure the pick step was added to prevent.
    const earlyGateOut = await api(`/stock/transfers/${transferId}`, {
      method: "POST", token, body: { action: "dispatch" },
    })
    check("gate-out before picking is blocked", earlyGateOut.status === 409,
      `status=${earlyGateOut.status}`)

    const picked = must("pick", await api(`/stock/transfers/${transferId}`, {
      method: "POST", token, body: { action: "pick" },
    }))
    check("all three units were staged", Number(picked.picked) === 3, String(picked.picked))
    check("the transfer is PICKED", picked.transfer.status === "PICKED", picked.transfer.status)

    const afterPick = await serialStatuses(seeded.companyId, seeded.itemId)
    check("picked stock has NOT moved — still IN_STOCK at the source",
      afterPick.every((r) => r.status === "IN_STOCK" && Number(r.warehouse_id) === seeded.warehouseId),
      JSON.stringify(afterPick))
    const holdsAfterPick = await serialHolds(seeded.companyId, seeded.itemId)
    check("staged units are still held",
      holdsAfterPick.every((r) => r.transfer_line_id !== null), JSON.stringify(holdsAfterPick))
    check("a delivery order still cannot see them",
      (await doAvailability(token, seeded)) === 0)

    console.log("\n== Gate-out is what takes the stock out of circulation ==")
    const dispatched = must("dispatch", await api(`/stock/transfers/${transferId}`, {
      method: "POST",
      token,
      body: { action: "dispatch", vehicle_number: "KA-01-TEST-9", driver_name: "Test Driver" },
    }))
    check("all three units went", Number(dispatched.sent) === 3, String(dispatched.sent))
    // These columns have existed since migration 070 and were never written,
    // because no step in the flow knew them.
    check("gate-out records the vehicle", dispatched.transfer.vehicle_number === "KA-01-TEST-9",
      String(dispatched.transfer.vehicle_number))
    check("gate-out records the driver", dispatched.transfer.driver_name === "Test Driver",
      String(dispatched.transfer.driver_name))

    const afterDispatch = await serialStatuses(seeded.companyId, seeded.itemId)
    check("dispatched units are IN_TRANSIT",
      afterDispatch.some((r) => r.status === "IN_TRANSIT" && r.n === 3),
      JSON.stringify(afterDispatch))
    check("they are still at the source warehouse until received",
      afterDispatch.every((r) => Number(r.warehouse_id) === seeded.warehouseId),
      JSON.stringify(afterDispatch))
    // The hold is consumed by dispatch: from here stock_transfer_serials records
    // what shipped, and a claim on stock that has left would be nonsense.
    const holdsAfterDispatch = await serialHolds(seeded.companyId, seeded.itemId)
    check("dispatch consumes the hold",
      holdsAfterDispatch.every((r) => r.transfer_line_id === null),
      JSON.stringify(holdsAfterDispatch))

    // The point of a distinct IN_TRANSIT status: the source can no longer promise
    // this stock to anybody.
    const lots = must("lot master", await api(`/stock/lots?batch=BATCH-STN-${SUFFIX}`, { token }))
    const lot = lots.rows.find((r) => r.batch_number === `BATCH-STN-${SUFFIX}`)
    check("in-transit stock is still counted as ours", Number(lot?.on_hand_units) === 3,
      String(lot?.on_hand_units))

    console.log("\n== The destination can see what is coming ==")
    const inbound = must("inbound queue", await api(
      `/stock/transfers/inbound?warehouse_id=${seeded.destWarehouseId}`, { token }))
    const mine = inbound.rows.find((r) => Number(r.id) === transferId)
    check("the transfer appears in the destination's inbound queue", Boolean(mine),
      JSON.stringify(inbound.rows.map((r) => r.transfer_number)))
    check("it says how many units are on the truck", Number(mine?.units_on_truck) === 3,
      String(mine?.units_on_truck))
    check("it carries the vehicle captured at gate-out",
      mine?.vehicle_number === "KA-01-TEST-9", String(mine?.vehicle_number))
    check("it reports how long the stock has been on the road",
      Number.isInteger(Number(mine?.days_in_transit)), String(mine?.days_in_transit))
    // The sending warehouse must not see it as inbound — that is the whole
    // point of a destination-oriented view.
    const wrongEnd = must("inbound at the source", await api(
      `/stock/transfers/inbound?warehouse_id=${seeded.warehouseId}`, { token }))
    check("the sending warehouse does not list it as inbound",
      !wrongEnd.rows.some((r) => Number(r.id) === transferId),
      JSON.stringify(wrongEnd.rows.map((r) => r.transfer_number)))

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

    console.log("\n== Received stock lands in the destination's put-away queue ==")
    const putaway = must("unlocated put-away queue", await api(
      `/stock/putaway?warehouse_id=${seeded.destWarehouseId}&unlocated=true`, { token }))
    const arrivedUnits = putaway.filter((r) => String(r.arrived_on_transfer || "") !== "")
    check("the arrived units are queued for put-away", arrivedUnits.length === 2,
      String(arrivedUnits.length))
    check("and they name the transfer that brought them",
      arrivedUnits.every((r) => r.arrived_on_transfer === String(created.transfer_number)),
      JSON.stringify(arrivedUnits.map((r) => r.arrived_on_transfer)))
    // The bug this filter exposed: CONCAT renders NULL as '', so the COALESCE
    // fallback was unreachable and unlocated stock displayed as the string '//'.
    check("stock with no bin reads as Unassigned, not '//'",
      arrivedUnits.every((r) => r.current_bin_location === "Unassigned"),
      JSON.stringify(arrivedUnits.map((r) => r.current_bin_location)))

    console.log("\n== The unit that never arrived is chased, not forgotten ==")
    // lots.ts counts IN_TRANSIT as on hand, so without this worklist the lost
    // unit inflates inventory forever while looking perfectly healthy.
    const exceptions = must("exceptions", await api("/stock/transfers/exceptions", { token }))
    const stranded = exceptions.rows.find((r) => r.serial_number === `SER-STN-${SUFFIX}-3`)
    check("the unit that never arrived is listed", Boolean(stranded),
      JSON.stringify(exceptions.rows.map((r) => r.serial_number).slice(0, 5)))
    check("it is classified as never arrived, not merely late",
      stranded?.bucket === "SHORT_RECEIPT", String(stranded?.bucket))
    check("it names the transfer that lost it",
      stranded?.transfer_number === String(created.transfer_number),
      String(stranded?.transfer_number))
    check("received units are NOT exceptions",
      !exceptions.rows.some((r) => r.serial_number === `SER-STN-${SUFFIX}-1`))

    const draft = must("draft write-off", await api("/stock/transfers/exceptions", {
      method: "POST", token, body: { transfer_id: transferId },
    }))
    check("the write-off is raised as a DRAFT", draft.adjustment.status === "DRAFT",
      String(draft.adjustment.status))
    // The worklist must not route around the control that makes approval the
    // only thing that touches stock.
    const afterDraft = await serialStatuses(seeded.companyId, seeded.itemId)
    check("drafting the write-off changed no stock",
      afterDraft.some((r) => r.status === "IN_TRANSIT" && r.n === 1), JSON.stringify(afterDraft))
    check("the write-off is attributed to the transfer, not to MANUAL",
      draft.adjustment.source_module === "TRANSFER", String(draft.adjustment.source_module))
    check("it writes off against the SENDING warehouse",
      Number(draft.adjustment.warehouse_id) === seeded.warehouseId,
      String(draft.adjustment.warehouse_id))

    const nothingLost = await api("/stock/transfers/exceptions", {
      method: "POST", token, body: { transfer_id: Number(held.id) },
    })
    check("a transfer with nothing lost cannot be written off", nothingLost.status === 400,
      `status=${nothingLost.status}`)

    console.log("\n== Inventory adjustment: a draft changes nothing ==")
    const missingSerial = `SER-STN-${SUFFIX}-3`

    // The exceptions worklist has already drafted a write-off for this unit,
    // and raising one quarantines the serial, so a second write-off for the
    // same unit is now refused — which is the point of the quarantine. Withdraw
    // the drafted one and raise the manual equivalent, as an operator who wants
    // to word the reason themselves would.
    const dupOfException = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "LOSS",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [missingSerial] }],
      },
    })
    check("a unit already named on an open write-off cannot be written off again",
      dupOfException.status === 400,
      String(dupOfException.json?.error?.message ?? "").slice(0, 70))
    must("withdraw the drafted write-off", await api(`/stock/adjustments/${draft.adjustment.id}`, {
      method: "POST", token, body: { action: "cancel" },
    }))

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

    console.log("\n== The form can only offer what the warehouse holds ==")
    const units = await seedUnits(seeded, `SER-ADJ-${SUFFIX}`, 3)
    const availPath =
      `/stock/adjustments/availability?client_id=${seeded.clientId}` +
      `&warehouse_id=${seeded.warehouseId}`

    const availItems = must("adjustment availability", await api(availPath, { token }))
    const offeredItem = availItems.items.find((r) => Number(r.item_id) === seeded.itemId)
    check("the item list is what the warehouse actually holds",
      Number(offeredItem?.adjustable) === 3, JSON.stringify(offeredItem))

    const availSerials = must("adjustable serials",
      await api(`${availPath}&item_id=${seeded.itemId}`, { token }))
    check("it offers the units themselves, not a free-text box",
      availSerials.serials.length === 3, String(availSerials.serials.length))
    check("and none of them read as the literal '//' location",
      availSerials.serials.every((s) => s.bin_location !== "//"),
      JSON.stringify(availSerials.serials.map((s) => s.bin_location)))
    check("nothing is claimed yet",
      availSerials.serials.every((s) => s.claimed_by === null))

    const searched = must("filtered serials",
      await api(`${availPath}&item_id=${seeded.itemId}&q=${encodeURIComponent(units[1])}`, { token }))
    check("the search happens on the server, not over a truncated page",
      searched.serials.length === 1 && searched.serials[0].serial_number === units[1],
      JSON.stringify(searched.serials.map((s) => s.serial_number)))

    const receipts = must("receipt lines",
      await api(`${availPath}&item_id=${seeded.itemId}&mode=receipts`, { token }))
    check("found stock can be told which receipt it belongs to",
      receipts.receipts.some((r) => Number(r.grn_line_item_id) === seeded.grnLineId),
      String(receipts.receipts.length))

    console.log("\n== Raising quarantines the stock ==")
    check("all three units start allocatable", (await doAvailability(token, seeded)) === 3)

    const quarantine = must("quarantine draft", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "DAMAGE",
        reason: "Crushed on the pallet",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [units[0], units[1]] }],
      },
    }))
    check("it is still only a draft", quarantine.status === "DRAFT", quarantine.status)
    check("a delivery order can no longer see the reported units",
      (await doAvailability(token, seeded)) === 1, "expected 1")

    const quarantinedStatus = await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
      const r = await db.query(
        `SELECT status, adjustment_line_id FROM stock_serial_numbers
          WHERE company_id = $1 AND serial_number = $2`,
        [seeded.companyId, units[0]]
      )
      return r.rows[0]
    })
    // The whole reason the hold is a column: a quarantined unit has not moved,
    // so it is still on hand, still countable and still billable.
    check("quarantined stock is still IN_STOCK, not written off",
      quarantinedStatus.status === "IN_STOCK", String(quarantinedStatus.status))
    check("and it carries the adjustment line that claimed it",
      quarantinedStatus.adjustment_line_id !== null)

    const stillOffered = must("availability after quarantine",
      await api(`${availPath}&item_id=${seeded.itemId}`, { token }))
    check("the raise form stops offering units already under adjustment",
      stillOffered.serials.length === 1, String(stillOffered.serials.length))

    const doubleReport = await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "LOSS",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [units[0]] }],
      },
    })
    check("the same unit cannot be reported twice", doubleReport.status === 400,
      String(doubleReport.json?.error?.message ?? "").slice(0, 70))

    console.log("\n== Withdrawing puts the stock back ==")
    const withdrawn = must("withdraw", await api(`/stock/adjustments/${quarantine.id}`, {
      method: "POST", token, body: { action: "cancel" },
    }))
    check("withdrawal is recorded as CANCELLED, not REJECTED",
      withdrawn.adjustment.status === "CANCELLED", String(withdrawn.adjustment.status))
    check("it reports what it released", Number(withdrawn.released) === 2,
      String(withdrawn.released))
    check("the units are allocatable again", (await doAvailability(token, seeded)) === 3)
    const lateApprove = await api(`/stock/adjustments/${quarantine.id}`, {
      method: "POST", token, body: { action: "approve" },
    })
    check("a withdrawn adjustment cannot then be approved", lateApprove.status === 409,
      `status=${lateApprove.status}`)

    console.log("\n== Writing off stock somebody else has promised ==")
    // A real hold, taken by a real transfer, rather than a column poked in the
    // database: the point is that the two features see each other.
    const claimTransfer = must("transfer to hold stock", await api("/stock/transfers", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        from_warehouse_id: seeded.warehouseId,
        to_warehouse_id: seeded.destWarehouseId,
        lines: [{ item_id: seeded.itemId, quantity: 1 }],
      },
    }))
    must("approve holding transfer", await api(`/stock/transfers/${claimTransfer.id}`, {
      method: "POST", token, body: { action: "approve" },
    }))
    const heldSerial = await heldByTransfer(seeded.companyId, seeded.itemId)
    check("the transfer is holding a unit", Boolean(heldSerial), String(heldSerial))

    const claimedAvail = must("availability with a claim",
      await api(`${availPath}&item_id=${seeded.itemId}`, { token }))
    const heldRow = claimedAvail.serials.find((s) => s.serial_number === heldSerial)
    check("the picker says who is holding it",
      String(heldRow?.claimed_by ?? "").includes(String(claimTransfer.transfer_number)),
      String(heldRow?.claimed_by))

    const overClaim = must("adjustment over a claim", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "DAMAGE",
        reason: "Damaged after it was promised",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [heldSerial] }],
      },
    }))
    // Damage happens to stock that is already sold. Refusing to record it would
    // be the wrong way round; the control is at approval.
    check("reporting damage on promised stock is allowed", overClaim.status === "DRAFT",
      String(overClaim.status))
    check("but the raiser is told about the claim", (overClaim.warnings ?? []).length === 1,
      JSON.stringify(overClaim.warnings))

    const blind = await api(`/stock/adjustments/${overClaim.id}`, {
      method: "POST", token, body: { action: "approve" },
    })
    check("approving it blind is refused", blind.status === 409, `status=${blind.status}`)
    check("and the refusal names the order that loses the stock",
      String(blind.json?.error?.message ?? "").includes(String(claimTransfer.transfer_number)),
      String(blind.json?.error?.message ?? "").slice(0, 90))

    const adjDetail = must("adjustment detail",
      await api(`/stock/adjustments/${overClaim.id}`, { token }))
    check("the approver can see the serials before deciding",
      adjDetail.lines[0].serials.some((s) => s.serial_number === heldSerial),
      JSON.stringify(adjDetail.lines[0].serials))
    check("and the claims are on the same payload", adjDetail.claims.length === 1,
      JSON.stringify(adjDetail.claims))

    const acknowledged = must("approve with acknowledgement",
      await api(`/stock/adjustments/${overClaim.id}`, {
        method: "POST", token, body: { action: "approve", acknowledge_claims: true },
      }))
    check("acknowledging is what lets it through", Number(acknowledged.decreased) === 1,
      String(acknowledged.decreased))
    check("and approval reports every claim it broke",
      acknowledged.released_claims.length === 1, JSON.stringify(acknowledged.released_claims))
    const afterClaimBreak = await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
      const r = await db.query(
        `SELECT status, transfer_line_id, adjustment_line_id FROM stock_serial_numbers
          WHERE company_id = $1 AND serial_number = $2`,
        [seeded.companyId, heldSerial]
      )
      return r.rows[0]
    })
    check("the written-off unit is CANCELLED", afterClaimBreak.status === "CANCELLED",
      String(afterClaimBreak.status))
    check("and holds nothing afterwards",
      afterClaimBreak.transfer_line_id === null && afterClaimBreak.adjustment_line_id === null,
      JSON.stringify(afterClaimBreak))

    console.log("\n== Approving is not an operator's job ==")
    // Approval places a real hold on inventory (migration 072), so it is no
    // longer the same permission as raising or picking.
    const operatorName = await seedOperator(seeded.companyId, seeded.warehouseId)
    await setOperatorApprove(seeded.companyId, false)
    const operatorLogin = async () => {
      const res = await fetch(`${BASE_URL}/mobile/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_code: fixtures.tenantA.code,
          username: operatorName,
          password: CHAOS_PASSWORD,
        }),
      })
      return (await res.json())?.data?.access_token
    }
    const opToken = await operatorLogin()
    check("the operator can log in", Boolean(opToken))

    if (opToken) {
      const opRaised = await api("/stock/transfers", {
        method: "POST",
        token: opToken,
        body: {
          client_id: seeded.clientId,
          from_warehouse_id: seeded.warehouseId,
          to_warehouse_id: seeded.destWarehouseId,
          lines: [{ item_id: seeded.itemId, quantity: 1 }],
        },
      })
      // Raising is still an operator's job — the control is on authorising, not
      // on asking.
      check("an operator can still raise a transfer", opRaised.status === 200,
        `status=${opRaised.status}`)

      const opApprove = await api(`/stock/transfers/${Number(opRaised.json?.data?.id)}`, {
        method: "POST", token: opToken, body: { action: "approve" },
      })
      const opMessage = String(opApprove.json?.error?.message ?? "")
      check("an operator is refused on permissions", opMessage.includes("Insufficient permissions"),
        `status=${opApprove.status} ${opMessage.slice(0, 60)}`)

      // Grant that one permission to the same user and nothing else changes.
      // If the refusal above came from anything other than the new gate, this
      // would still fail on permissions.
      await setOperatorApprove(seeded.companyId, true)
      const grantedToken = await operatorLogin()
      const nowAllowed = await api(`/stock/transfers/${Number(opRaised.json?.data?.id)}`, {
        method: "POST", token: grantedToken, body: { action: "approve" },
      })
      const grantedMessage = String(nowAllowed.json?.error?.message ?? "")
      // By this point every unit of the seeded item has been received or written
      // off, so the correct answer is a stock shortage — which is the proof
      // wanted: it got past the permission gate and was stopped by a real check.
      check("granting stock.transfer.approve is what unblocks it",
        !grantedMessage.includes("Insufficient permissions"),
        `status=${nowAllowed.status} ${grantedMessage.slice(0, 60)}`)
      await setOperatorApprove(seeded.companyId, false)

      await api(`/stock/transfers/${Number(opRaised.json?.data?.id)}`, {
        method: "POST", token, body: { action: "cancel" },
      })

      // The same control on the more dangerous of the two: an approved transfer
      // moves stock between our own warehouses, an approved adjustment destroys
      // it (migration 077).
      await setOperatorPermission(seeded.companyId, "stock.adjustment.approve", false)
      const opAdjToken = await operatorLogin()
      const opAdj = await api("/stock/adjustments", {
        method: "POST",
        token: opAdjToken,
        body: {
          client_id: seeded.clientId,
          warehouse_id: seeded.warehouseId,
          reason_code: "DAMAGE",
          reason: "Reported by the operator who found it",
          lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [units[2]] }],
        },
      })
      check("an operator can still report damage", opAdj.status === 200, `status=${opAdj.status}`)

      const opAdjId = Number(opAdj.json?.data?.id)
      const opApproveAdj = await api(`/stock/adjustments/${opAdjId}`, {
        method: "POST", token: opAdjToken, body: { action: "approve" },
      })
      check("but cannot approve their own write-off",
        String(opApproveAdj.json?.error?.message ?? "").includes("Insufficient permissions"),
        `status=${opApproveAdj.status}`)

      // Withdrawing your own request is not an authority, so it must not need
      // the approver's permission.
      const opWithdraw = await api(`/stock/adjustments/${opAdjId}`, {
        method: "POST", token: opAdjToken, body: { action: "cancel" },
      })
      check("an operator can withdraw what they raised", opWithdraw.status === 200,
        `status=${opWithdraw.status}`)

      await setOperatorPermission(seeded.companyId, "stock.adjustment.approve", true)
      const adjGrantedToken = await operatorLogin()
      const opAdj2 = await api("/stock/adjustments", {
        method: "POST",
        token: adjGrantedToken,
        body: {
          client_id: seeded.clientId,
          warehouse_id: seeded.warehouseId,
          reason_code: "DAMAGE",
          lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [units[2]] }],
        },
      })
      const nowApproved = await api(`/stock/adjustments/${Number(opAdj2.json?.data?.id)}`, {
        method: "POST", token: adjGrantedToken, body: { action: "approve" },
      })
      check("granting stock.adjustment.approve is what unblocks it",
        !String(nowApproved.json?.error?.message ?? "").includes("Insufficient permissions"),
        `status=${nowApproved.status}`)
      await setOperatorPermission(seeded.companyId, "stock.adjustment.approve", false)
    }

    console.log("\n== The documents ==")
    // Left open on purpose: the draft report has to be checked while it is still
    // a draft, and its wording is different from a rejected one.
    const openDraft = must("open draft for the report", await api("/stock/adjustments", {
      method: "POST",
      token,
      body: {
        client_id: seeded.clientId,
        warehouse_id: seeded.warehouseId,
        reason_code: "DAMAGE",
        reason: "Awaiting a decision",
        lines: [{ item_id: seeded.itemId, direction: "DECREASE", serials: [units[1]] }],
      },
    }))
    const opAdjDraftId = openDraft.id
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

    const draftDoc = must("rejected adjustment report",
      await api(`/documents/inventory-adjustment-report/${toReject.id}`, { token }))
    check("a report for a rejected adjustment says it never applied",
      JSON.stringify(draftDoc).includes("rejected and never applied to stock"),
      String(draftDoc.footerNote ?? "").slice(0, 80))

    // A draft says something different: nothing has changed, but the units are
    // held, so the reader is not told the paperwork is free.
    const pendingDoc = must("draft adjustment report",
      await api(`/documents/inventory-adjustment-report/${opAdjDraftId}`, { token }))
    check("a report for a draft says it is proposed and the stock is held",
      JSON.stringify(pendingDoc).includes("NOT been applied") &&
        JSON.stringify(pendingDoc).includes("held out of picking"),
      String(pendingDoc.footerNote ?? "").slice(0, 80))

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
      // After the serials, which carry a NOT NULL reference to the receipt line.
      await db.query(
        `DELETE FROM grn_header WHERE company_id = $1 AND grn_number LIKE 'GRN-STN-%'`,
        [TEARDOWN.companyId]
      )
      await db.query(`DELETE FROM warehouses WHERE company_id = $1 AND warehouse_code LIKE $2`, [
        TEARDOWN.companyId,
        `WH-STN-%`,
      ])
      // The OPERATOR fixture is deactivated, not deleted: audit_logs references
      // it and those rows are evidence, not litter. The approve grant is removed
      // regardless of where the run stopped, so a failure mid-test cannot leave
      // the role holding a permission it must not have.
      await db.query(
        `DELETE FROM rbac_role_permissions rp
          USING rbac_roles r, rbac_permissions p
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
            AND r.role_code = 'OPERATOR'
            AND p.permission_key IN ('stock.transfer.approve', 'stock.adjustment.approve')`
      )
      await db.query(
        `UPDATE users SET is_active = false WHERE company_id = $1 AND username = 'op_stn_fixture'`,
        [TEARDOWN.companyId]
      )
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
