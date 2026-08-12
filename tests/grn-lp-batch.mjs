/**
 * Mobile pallet batch/expiry must survive GRN confirmation.
 *
 * The scanner types a batch and expiry once, at LP create, and they land on
 * mobile_lp_records. Nothing downstream re-asks for them: grn_line_items has no
 * column for a batch, so if confirmation does not copy the pallet's values onto the
 * serials it created, that batch is gone for good -- and the stock is then invisible
 * to Lot Master, recall, expiry alerts and FEFO while still sitting on the rack.
 *
 * So the assertion is not "the GRN confirmed". It is: the serial carries the SAME
 * batch as the pallet it came off, and the lot shows up in the lot master. A second
 * pallet with a different batch is received on the same line deliberately -- a
 * per-line copy would give every unit the first pallet's batch and still pass a
 * single-pallet test, which is exactly the bug that would poison a recall.
 *
 * Requires a running dev server and a migrated database.
 */

import process from "node:process"
import { BASE_URL, deleteTestFixtures, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const BATCH_A = `LOT-LPA-${SUFFIX}`
const BATCH_B = `LOT-LPB-${SUFFIX}`
const QTY_A = 3
const QTY_B = 2
const EXPIRY_A = "2027-04-30"
const EXPIRY_B = "2027-09-30"

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
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

async function seed(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query("BEGIN")
    try {
      const itemCode = `ITM-LPB-${SUFFIX}`
      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active,
                            is_batch_tracked, is_expiry_tracked)
         VALUES ($1, $2, $3, 'PCS', true, true, true)
         RETURNING id`,
        [companyId, itemCode, `LP batch ${itemCode}`]
      )
      const itemId = Number(item.rows[0].id)

      const gateIn = await db.query(
        `INSERT INTO gate_in (company_id, gate_in_number, warehouse_id, client_id,
                              truck_number, arrival_datetime, status)
         VALUES ($1, $2, $3, $4, 'TRK-LPB', CURRENT_TIMESTAMP, 'GRN_IN_PROGRESS')
         RETURNING id`,
        [companyId, `GI-LPB-${SUFFIX}`, warehouseId, clientId]
      )
      const gateInId = Number(gateIn.rows[0].id)

      // Two pallets of the same SKU under one gate-in, each with its own batch --
      // exactly what the mobile capture screen produces when a truck carries mixed lots.
      const lpIds = []
      for (const lp of [
        { code: `LP-A-${SUFFIX}`, batch: BATCH_A, qty: QTY_A, expiry: EXPIRY_A },
        { code: `LP-B-${SUFFIX}`, batch: BATCH_B, qty: QTY_B, expiry: EXPIRY_B },
      ]) {
        const row = await db.query(
          `INSERT INTO public.mobile_lp_records (
             id, lp_code, source_scan_code, po_id, gate_in_id, client_id, sku,
             batch_lot, quantity, expiry_date, warehouse_id, received_by_id, status
           )
           VALUES (gen_random_uuid()::text, $1, $1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
                   $9, 'test', 'RECEIVED')
           RETURNING id`,
          [
            lp.code,
            `PO-LPB-${SUFFIX}`,
            String(gateInId),
            String(clientId),
            itemCode,
            lp.batch,
            lp.qty,
            lp.expiry,
            String(warehouseId),
          ]
        )
        lpIds.push(String(row.rows[0].id))
      }

      const grn = await db.query(
        `INSERT INTO grn_header (company_id, grn_number, gate_in_id, warehouse_id, client_id,
                                 total_items, total_quantity, received_quantity, status, grn_date)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 'DRAFT', CURRENT_DATE)
         RETURNING id`,
        [companyId, `GRN-LPB-${SUFFIX}`, gateInId, warehouseId, clientId, QTY_A + QTY_B]
      )
      const grnId = Number(grn.rows[0].id)

      // No serial_numbers_json: this is the mobile path, where confirmation synthesises
      // one serial per unit from the pallets.
      await db.query(
        `INSERT INTO grn_line_items (company_id, grn_header_id, line_number, item_id, quantity, uom)
         VALUES ($1, $2, 1, $3, $4, 'PCS')`,
        [companyId, grnId, itemId, QTY_A + QTY_B]
      )

      await db.query("COMMIT")
      return { companyId, clientId, itemId, itemCode, grnId, gateInId, lpIds }
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const seeded = await seed(fixtures)

  try {
    const res = await fetch(`${BASE_URL}/grn/${seeded.grnId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    })
    const json = await res.json().catch(() => null)
    check("draft GRN confirms", res.ok, `${res.status} ${JSON.stringify(json)}`)

    const serials = await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
      const rows = await db.query(
        `SELECT s.serial_number, s.batch_number, s.expiry_date, s.lp_record_id,
                lp.lp_code, lp.batch_lot, lp.expiry_date::date AS lp_expiry
           FROM stock_serial_numbers s
           LEFT JOIN public.mobile_lp_records lp ON lp.id = s.lp_record_id
          WHERE s.company_id = $1 AND s.item_id = $2
          ORDER BY s.serial_number ASC`,
        [seeded.companyId, seeded.itemId]
      )
      return rows.rows
    })

    check("one serial per received unit", serials.length === QTY_A + QTY_B, `got ${serials.length}`)
    check(
      "every serial is linked to a pallet",
      serials.length > 0 && serials.every((row) => row.lp_record_id),
      `${serials.filter((row) => !row.lp_record_id).length} unlinked`
    )
    check(
      "every serial carries its OWN pallet's batch",
      serials.length > 0 && serials.every((row) => row.batch_number === row.batch_lot),
      JSON.stringify(serials.map((row) => [row.serial_number, row.batch_number, row.batch_lot]))
    )
    check(
      "batches are not collapsed onto one lot",
      new Set(serials.map((row) => row.batch_number)).size === 2,
      JSON.stringify([...new Set(serials.map((row) => row.batch_number))])
    )
    check(
      `${QTY_A} units on batch A`,
      serials.filter((row) => row.batch_number === BATCH_A).length === QTY_A
    )
    check(
      `${QTY_B} units on batch B`,
      serials.filter((row) => row.batch_number === BATCH_B).length === QTY_B
    )
    check(
      "expiry follows the same pallet as the batch",
      serials.length > 0 &&
        serials.every(
          (row) =>
            row.expiry_date &&
            row.lp_expiry &&
            new Date(row.expiry_date).toISOString().slice(0, 10) ===
              new Date(row.lp_expiry).toISOString().slice(0, 10)
        ),
      JSON.stringify(serials.map((row) => [row.expiry_date, row.lp_expiry]))
    )

    // The point of the copy: the stock is now findable during a recall.
    const lotsRes = await fetch(`${BASE_URL}/stock/lots?batch=LOT-LP`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const lotsJson = await lotsRes.json().catch(() => null)
    const rows = lotsJson?.data?.rows ?? []
    const seen = rows.filter((row) => row.batch_number === BATCH_A || row.batch_number === BATCH_B)
    check("both lots appear in the lot master", seen.length === 2, JSON.stringify(seen.map((r) => r.batch_number)))
    check(
      "lot master shows the units as on hand",
      seen.reduce((sum, row) => sum + Number(row.on_hand_units || 0), 0) === QTY_A + QTY_B,
      JSON.stringify(seen.map((row) => [row.batch_number, row.on_hand_units]))
    )
  } finally {
    await withDb(async (db) => {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(seeded.companyId)])
      // Order matters: movements reference serials (RESTRICT) and serials reference the
      // pallet, so the shared cleanup unwinds both before the LP rows can go.
      await deleteTestFixtures(db, {
        companyId: seeded.companyId,
        itemIds: [seeded.itemId],
        grnIds: [seeded.grnId],
      })
      await db.query(`DELETE FROM public.mobile_lp_records WHERE id = ANY($1::text[])`, [seeded.lpIds])
      await db.query(`DELETE FROM gate_in WHERE id = $1 AND company_id = $2`, [
        seeded.gateInId,
        seeded.companyId,
      ])
    })
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nGRN LP batch inheritance suite passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
