/**
 * Track B acceptance: drive one DO through the whole outbound tail, then assert
 * every document in the engine builds against real data.
 *
 * A document that renders an empty shell is the failure mode that matters here
 * — it looks fine in a screenshot and is useless on a loading bay — so each
 * assertion checks the document actually carries rows, not just HTTP 200.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import { BASE_URL, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const QTY = 3

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

/** Seed a PICKED DO with QTY in-stock serials, plus the handling fields the job card prints. */
async function seedDo(fixtures) {
  const doNumber = `DO-DOCS-${SUFFIX}`
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId, itemId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      // Session-scoped (is_local = false): withDb hands out a dedicated client and
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
           total_items, total_quantity_requested, total_quantity_dispatched, status,
           handling_type, machine_type, no_of_cases, no_of_pallets, weight_kg, outward_remarks
         )
         VALUES ($1, $2, CURRENT_DATE, $3, $4, 'Track B test', 1, $5, 0, 'PICKED',
                 'PALLETISED', 'FORKLIFT', 2, 1, 240.5, 'Handle with care')
         RETURNING id`,
        [companyId, doNumber, clientId, warehouseId, QTY]
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
          [companyId, `SER-DOCS-${SUFFIX}-${i}`, itemId, clientId, warehouseId, grnLineId]
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

/** Total row count across every table section of a document. */
function rowCount(model) {
  return (model.sections || [])
    .filter((s) => s.kind === "table")
    .reduce((sum, s) => sum + (s.rows?.length || 0), 0)
}

function hasSignatures(model) {
  return (model.sections || []).some((s) => s.kind === "signatures" && s.blocks.length > 0)
}

async function assertDocument(token, label, type, id, { minRows = 1 } = {}) {
  const result = await api(`/documents/${type}/${id}`, { token })
  if (!result.res.ok) {
    check(`${label} builds`, false, `${result.res.status} ${JSON.stringify(result.json)}`)
    return null
  }
  const model = result.json.data
  const rows = rowCount(model)
  check(
    `${label} builds`,
    model.type === type && !!model.title && !!model.documentNumber,
    `${model.title} ${model.documentNumber}`
  )
  check(`${label} carries content`, rows >= minRows, `rows=${rows}`)
  check(`${label} has letterhead`, !!model.branding?.companyName, model.branding?.companyName)
  check(`${label} has signature block`, hasSignatures(model))
  return model
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const { doId, doLineId, serialIds } = await seedDo(fixtures)

  // ---- documents available before anything is packed -----------------------
  await assertDocument(token, "dispatch-note", "dispatch-note", doId)
  await assertDocument(token, "packing-slip", "packing-slip", doId)
  // Job card prints handling fields even with no workforce tasks logged, so its
  // table can legitimately be empty; the fields section is what matters.
  await assertDocument(token, "job-card", "job-card", doId, { minRows: 0 })

  // ---- read layer before the tail runs -------------------------------------
  const emptyTail = must("tail read (pre-pack)", await api(`/do/${doId}/tail`, { token }))
  check("tail: DO resolves", Number(emptyTail.do_id) === doId, `do_id=${emptyTail.do_id}`)
  check("tail: no pack units yet", emptyTail.pack_units.length === 0)
  // The packable pool deliberately mirrors what POST /pack-units accepts: any
  // unpacked IN_STOCK/RESERVED serial for this item, warehouse and client. It is
  // therefore wider than this DO's own serials, and shared with other open DOs
  // for the same client — so assert on this run's serials, not on the total.
  const packableBefore = new Set(emptyTail.packable_serials.map((s) => Number(s.id)))
  check(
    "tail: this run's serials are packable",
    serialIds.every((id) => packableBefore.has(id)),
    `pool=${packableBefore.size}`
  )

  // ---- drive the tail ------------------------------------------------------
  const packUnit = must(
    "create pack unit",
    await api(`/do/${doId}/pack-units`, {
      method: "POST",
      token,
      body: {
        pack_type: "PALLET",
        close: true,
        gross_weight_kg: 240.5,
        volume_cbm: 1.44,
        lines: [{ do_line_item_id: doLineId, serial_ids: serialIds }],
      },
    })
  )

  // The GET that was returning 404 for every existing DO before this track.
  const packList = must("pack-units GET", await api(`/do/${doId}/pack-units`, { token }))
  check(
    "pack-units GET resolves the DO",
    packList.pack_units.length === 1,
    `n=${packList.pack_units.length}`
  )

  await assertDocument(token, "packing-list", "packing-list", doId)

  const gi = must("goods issue", await api(`/do/${doId}/goods-issue`, { method: "POST", token }))
  await assertDocument(token, "goods-issue-note", "goods-issue-note", gi.goods_issue_id ?? gi.id)

  const load = must(
    "create load",
    await api(`/do/${doId}/loads`, {
      method: "POST",
      token,
      body: {
        vehicle_number: `KA01DOC${SUFFIX.slice(-3)}`,
        driver_name: "Docs Driver",
        driver_phone: "9000000000",
        transport_company: "Track B Logistics",
        seal_number: "SEAL-001",
        loading_bay: "BAY-2",
        pack_unit_ids: [packUnit.id],
      },
    })
  )
  await assertDocument(token, "consignment-note", "consignment-note", load.id)

  const loadDone = must("complete load", await api(`/do/loads/${load.id}/complete`, { method: "POST", token }))
  const dnId = loadDone.delivery_note_id
  await assertDocument(token, "delivery-note", "delivery-note", dnId)

  must(
    "finalize delivery note",
    await api(`/do/delivery-notes/${dnId}/finalize`, { method: "POST", token })
  )

  // ---- read layer after the tail has run -----------------------------------
  const fullTail = must("tail read (post-finalize)", await api(`/do/${doId}/tail`, { token }))
  check("tail: pack unit present", fullTail.pack_units.length === 1)
  check("tail: pack unit marked issued", fullTail.pack_units[0]?.is_issued === true)
  check("tail: pack unit marked loaded", fullTail.pack_units[0]?.is_loaded === true)
  check("tail: goods issue present", fullTail.goods_issues.length === 1)
  check("tail: load present", fullTail.loads.length === 1)
  check(
    "tail: load carries pack unit count",
    Number(fullTail.loads[0]?.pack_unit_count) === 1,
    `n=${fullTail.loads[0]?.pack_unit_count}`
  )
  check("tail: delivery note present", fullTail.delivery_notes.length === 1)
  const packableAfter = new Set(fullTail.packable_serials.map((s) => Number(s.id)))
  check(
    "tail: shipped serials left the packable pool",
    serialIds.every((id) => !packableAfter.has(id)),
    `pool=${packableAfter.size}`
  )
  check(
    "tail: pool shrank by exactly this run's serials",
    packableBefore.size - packableAfter.size === QTY,
    `${packableBefore.size} -> ${packableAfter.size}`
  )

  // The delivery note is the one document whose content changes at finalize.
  const finalDn = await assertDocument(token, "delivery-note (final)", "delivery-note", dnId)
  check(
    "delivery note reports COMPLETED",
    finalDn?.meta?.some((f) => f.label === "Status" && f.value === "COMPLETED"),
    finalDn?.meta?.find((f) => f.label === "Status")?.value
  )

  // ---- rejections ----------------------------------------------------------
  const badType = await api(`/documents/not-a-real-doc/${doId}`, { token })
  check("unknown document type rejected", badType.res.status === 400, `status=${badType.res.status}`)

  const missing = await api(`/documents/delivery-note/99999999`, { token })
  check("missing subject returns 404", missing.res.status === 404, `status=${missing.res.status}`)

  const badId = await api(`/documents/delivery-note/abc`, { token })
  check("non-numeric id rejected", badId.res.status === 400, `status=${badId.res.status}`)

  const anon = await fetch(`${BASE_URL}/documents/delivery-note/${dnId}`)
  check("unauthenticated read rejected", anon.status === 401, `status=${anon.status}`)

  console.log("")
  if (failures > 0) {
    console.log(`Documents: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log("Documents: all checks passed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})