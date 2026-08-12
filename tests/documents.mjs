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
import { BASE_URL, deleteTestFixtures, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const QTY = 3

// Everything this run creates, so the teardown can remove it. Each run used to
// leave an ITM-DOCS-* and an ITM-GRN-* behind in Stock Search.
const GRN_ITEM_IDS = []
const TEARDOWN = { companyId: 0, itemIds: GRN_ITEM_IDS, doIds: [], grnIds: [] }

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
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      // Session-scoped (is_local = false): withDb hands out a dedicated client and
      // a transaction-local setting would be discarded before the next statement.
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      // A dedicated item per run, matching tests/allocation.mjs. Sharing the
      // fixture item made the packable-pool assertions meaningless: the pool is
      // capped at the line's outstanding quantity and ordered by the allocation
      // rule, so older leftover stock for a shared item takes every slot and this
      // run's freshly-received serials never appear in it.
      const itemCode = `ITM-DOCS-${SUFFIX}`
      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active)
         VALUES ($1, $2, $3, 'PCS', true)
         RETURNING id`,
        [companyId, itemCode, `Document test ${itemCode}`]
      )
      const itemId = Number(item.rows[0].id)

      const grnLine = await db.query(
        `SELECT gl.id FROM grn_line_items gl WHERE gl.company_id = $1 ORDER BY gl.id DESC LIMIT 1`,
        [companyId]
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
      return { companyId, doId, doLineId, serialIds, itemId, itemCode }
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

const STATUS_TONES = [
  "pending",
  "approved",
  "completed",
  "in-transit",
  "cancelled",
  "draft",
]

/**
 * The EDDS guarantees that must hold on EVERY document type, checked here rather
 * than per builder so a new builder cannot quietly ship without them. Each of
 * these is invisible in a screenshot of a happy path but load-bearing in print:
 * a missing QR breaks gate verification, a missing footer breaks audit trace,
 * an unlabelled status badge renders grey on a document that was cancelled.
 */
function checkEddsContract(label, model) {
  check(
    `${label} has a colour-coded status`,
    !!model.status?.label && STATUS_TONES.includes(model.status?.tone),
    `${model.status?.label} / ${model.status?.tone}`
  )
  check(
    `${label} has header identity`,
    !!model.documentDate && !!model.printedAt,
    `date=${model.documentDate} printed=${model.printedAt}`
  )
  // QR requires a signing secret; absent one it degrades rather than throws, so
  // only assert the shape when the environment can actually sign.
  if (model.qr) {
    check(
      `${label} QR is an inline PNG`,
      String(model.qr.dataUri || "").startsWith("data:image/png;base64,") &&
        String(model.qr.url || "").includes("/verify/"),
      model.qr.url
    )
  }
  check(
    `${label} approvals carry four blocks`,
    (model.sections || []).some((s) => s.kind === "signatures" && s.blocks.length === 4),
    (model.sections || []).find((s) => s.kind === "signatures")?.blocks?.length
  )
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
  checkEddsContract(label, model)
  return model
}

/**
 * Seed a confirmed GRN with two lines, one of them serialised.
 *
 * The GRN is inbound, so it hangs off none of the outbound tail this test
 * drives, and the tenant-A fixture set carries no receipt of its own. Seeding
 * rather than hunting for an existing GRN keeps the assertion meaningful in a
 * fresh database — and the serialised line is what exercises the serial-range
 * collapsing the migrated builder does.
 */
async function seedGrn(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      const item = await db.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, hsn_code, weight_kg, is_active)
         VALUES ($1, $2, $3, 'BOX', '30049011', 1.25, true)
         RETURNING id`,
        [companyId, `ITM-GRN-${SUFFIX}`, `GRN document test ${SUFFIX}`]
      )
      const itemId = Number(item.rows[0].id)

      const header = await db.query(
        `INSERT INTO grn_header (
           company_id, grn_number, client_id, warehouse_id, status, grn_date,
           invoice_number, invoice_date, supplier_name, supplier_gst,
           total_items, total_quantity, received_quantity, invoice_quantity,
           quantity_difference, damage_quantity, weight_kg, material_description
         )
         VALUES ($1, $2, $3, $4, 'CONFIRMED', CURRENT_DATE,
                 $5, CURRENT_DATE, 'Track B Supplier Pvt Ltd', '33AABCG4521K1ZP',
                 2, 15, 15, 15, 0, 0, 18.75, 'Mixed carton receipt for document test')
         RETURNING id`,
        [companyId, `GRN-DOCS-${SUFFIX}`, clientId, warehouseId, `INV-DOCS-${SUFFIX}`]
      )
      const grnId = Number(header.rows[0].id)

      // Line 1 carries a contiguous serial block so the range collapses;
      // line 2 carries none, so the "-" fallback is exercised too.
      const serials = Array.from({ length: 10 }, (_, i) => `SN-${SUFFIX}-${String(i + 1).padStart(3, "0")}`)
      await db.query(
        `INSERT INTO grn_line_items (
           company_id, grn_header_id, line_number, item_id, quantity, uom,
           remarks, serial_numbers_json
         )
         VALUES ($1, $2, 1, $3, 10, 'BOX', 'Stack max 6', $4::jsonb)`,
        [companyId, grnId, itemId, JSON.stringify(serials)]
      )
      await db.query(
        `INSERT INTO grn_line_items (
           company_id, grn_header_id, line_number, item_id, quantity, uom, remarks
         )
         VALUES ($1, $2, 2, $3, 5, 'BOX', 'Keep upright')`,
        [companyId, grnId, itemId]
      )

      await db.query("COMMIT")
      GRN_ITEM_IDS.push(itemId)
      return grnId
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

/**
 * Seed one blind and one open cycle-count plan.
 *
 * Both are needed because the blind-count control is a two-sided property: the
 * open plan must PRINT the system quantity, and the blind plan must omit it from
 * the model entirely — not merely hide the column, since the model is served as
 * JSON and a hidden column would still hand the figure to anyone who opened the
 * network tab.
 */
async function seedCountPlans(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
      const ids = {}
      for (const blind of [true, false]) {
        const plan = await db.query(
          `INSERT INTO cycle_count_plans (
             company_id, plan_number, warehouse_id, client_id, strategy,
             blind_count, status, zone_code, total_tasks, notes
           )
           VALUES ($1, $2, $3, $4, 'ABC', $5, 'OPEN', 'ZONE-A', 2, 'Document test plan')
           RETURNING id`,
          [
            companyId,
            `CCS-DOCS-${blind ? "B" : "O"}-${SUFFIX}`,
            warehouseId,
            clientId,
            blind,
          ]
        )
        const planId = Number(plan.rows[0].id)
        for (let i = 1; i <= 2; i++) {
          await db.query(
            `INSERT INTO mobile_cycle_count_tasks (
               company_id, warehouse_id, client_id, task_type, blind_count,
               bin_id, sku, expected_qty, status, plan_id
             )
             VALUES ($1, $2, $3, 'CYCLE', $4, $5, $6, $7, 'PENDING', $8)`,
            [
              companyId,
              warehouseId,
              clientId,
              blind,
              `A-0${i}-01-C`,
              `SKU-DOCS-${SUFFIX}-${i}`,
              100 * i,
              planId,
            ]
          )
        }
        ids[blind ? "blind" : "open"] = planId
      }
      await db.query("COMMIT")
      return ids
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

/**
 * Seed a gate-out for a DO. Must run AFTER the DO is packed, because the gate
 * pass lists pack units — that is what the security desk physically counts, and
 * a pass with an empty item table is the failure mode this suite exists to catch.
 */
async function seedGateOut(fixtures, doId) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId, warehouseId } = fixtures.ids.a
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const { rows } = await db.query(
      `INSERT INTO gate_out (
         company_id, gate_out_number, do_header_id, warehouse_id, client_id,
         truck_number, driver_name, driver_phone, transport_company,
         gate_out_datetime, lr_number, e_way_bill_number, remarks
       )
       VALUES ($1, $2, $3, $4, $5, 'TN 22 BQ 4187', 'R. Manikandan', '+91 90031 47820',
               'Sri Balaji Roadlines', NOW(), $6, '3418 9927 4410', 'Seal intact')
       RETURNING id`,
      [companyId, `GP-DOCS-${SUFFIX}`, doId, warehouseId, clientId, `LR-DOCS-${SUFFIX}`]
    )
    return Number(rows[0].id)
  })
}

/** Seed a finalized invoice with two charge lines and real intra-state tax. */
async function seedInvoice(fixtures) {
  return withDb(async (db) => {
    const companyId = fixtures.tenantA.companyId
    const { clientId } = fixtures.ids.a
    await db.query("BEGIN")
    try {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])

      // invoice_header is unique on (company, client, billing_period), so a
      // re-run with the same period collides. Clear this suite's own prior
      // fixture rather than inventing a fake period — the document under test
      // should look like a real monthly invoice.
      await db.query(
        `DELETE FROM invoice_lines
          WHERE company_id = $1
            AND invoice_id IN (
              SELECT id FROM invoice_header
               WHERE company_id = $1 AND client_id = $2 AND invoice_number LIKE 'INV-DOCS-%'
            )`,
        [companyId, clientId]
      )
      await db.query(
        `DELETE FROM invoice_header
          WHERE company_id = $1 AND client_id = $2 AND invoice_number LIKE 'INV-DOCS-%'`,
        [companyId, clientId]
      )

      const header = await db.query(
        `INSERT INTO invoice_header (
           company_id, invoice_number, client_id, billing_cycle, billing_period,
           period_from, period_to, invoice_date, due_date, currency,
           taxable_amount, cgst_amount, sgst_amount, igst_amount,
           total_tax_amount, grand_total, paid_amount, balance_amount, status
         )
         -- These totals MUST equal the sum of the lines inserted below, because the
         -- billing engine always derives the header from invoice_lines. A hardcoded
         -- header that disagrees leaves a FINALIZED invoice whose stated grand_total
         -- exceeds its own lines, which reads as a real revenue discrepancy in any
         -- audit of this database. Lines: 153760 + 29952 taxable, 27676 + 5392 tax.
         VALUES ($1, $2, $3, 'MONTHLY', '2026-07',
                 DATE '2026-07-01', DATE '2026-07-31', CURRENT_DATE, CURRENT_DATE + 30, 'INR',
                 183712, 16534, 16534, 0, 33068, 216780, 0, 216780, 'FINALIZED')
         RETURNING id`,
        [companyId, `INV-DOCS-${SUFFIX}`, clientId]
      )
      const invoiceId = Number(header.rows[0].id)
      // charge_type is constrained to the billing engine's vocabulary
      // (ck_il_charge_type); the human-facing wording lives in description.
      const lines = [
        ["STORAGE", "Warehousing — storage, Jul 2026", "996729", 2480, 62, 153760, 13838],
        ["OUTBOUND_HANDLING", "Outbound handling — pick, pack, dispatch", "996729", 1248, 24, 29952, 2696],
      ]
      let lineNo = 1
      for (const [chargeType, description, hsn, qty, rate, amount, gst] of lines) {
        await db.query(
          `INSERT INTO invoice_lines (
             company_id, invoice_id, line_no, charge_type, description, uom,
             quantity, rate, amount, tax_code, gst_rate,
             cgst_amount, sgst_amount, igst_amount, total_tax_amount, gross_amount
           )
           VALUES ($1, $2, $3, $4, $5, 'PD', $6, $7, $8, $9, 18,
                   $10, $10, 0, $11, $12)`,
          [
            companyId, invoiceId, lineNo++, chargeType, description, qty, rate, amount, hsn,
            gst, gst * 2, amount + gst * 2,
          ]
        )
      }
      await db.query("COMMIT")
      return invoiceId
    } catch (error) {
      await db.query("ROLLBACK")
      throw error
    }
  })
}

/**
 * Assert every DocumentType is referenced from app/ or components/.
 *
 * Deliberately a source scan rather than a browser crawl: it is cheap, has no
 * fixture requirements, and catches the exact failure it exists for — a builder
 * that ships without an entry point. It cannot prove the link is reachable for a
 * given user or role, only that one exists at all.
 */
async function checkUiReachability() {
  const { readdirSync, readFileSync, statSync } = await import("node:fs")
  const { join, extname } = await import("node:path")

  const roots = ["app", "components"]
  const sources = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if ([".ts", ".tsx"].includes(extname(entry))) sources.push(full)
    }
  }
  for (const r of roots) walk(r)

  // The engine's own plumbing references every type by definition; excluding it
  // is what makes this assert a real entry point rather than a self-reference.
  const engine = ["document-sheet.tsx", "builders.ts", "types.ts", "branding.ts", "summary.ts", "verify.ts"]
  const haystack = sources
    .filter((f) => !engine.some((e) => f.endsWith(e)))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")

  const types = [
    "pick-list", "packing-list", "goods-issue-note", "goods-receipt-note",
    "delivery-note", "consignment-note", "gate-pass", "cycle-count-sheet",
    "dispatch-manifest", "commercial-invoice", "job-card", "dispatch-note",
    "packing-slip", "stock-transfer-note", "inventory-adjustment-report",
    "client-statement",
  ]
  const orphans = types.filter((t) => !haystack.includes(`"${t}"`) && !haystack.includes(`/documents/${t}/`))
  check(
    "every document type has a UI entry point",
    orphans.length === 0,
    orphans.length ? `unreachable: ${orphans.join(", ")}` : `all ${types.length} linked`
  )
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const seeded = await seedDo(fixtures)
  const { doId, doLineId, serialIds, itemCode } = seeded
  TEARDOWN.companyId = seeded.companyId
  TEARDOWN.itemIds.push(seeded.itemId)
  TEARDOWN.doIds.push(seeded.doId)

  // ---- inbound: the GRN migrated off its standalone print page -------------
  const grnId = await seedGrn(fixtures)
  TEARDOWN.grnIds.push(grnId)
  const grn = await assertDocument(token, "goods-receipt-note", "goods-receipt-note", grnId, {
    minRows: 2,
  })
  check(
    "goods-receipt-note has inbound party cards",
    grn?.sections?.some(
      (s) =>
        s.kind === "party-cards" &&
        s.cards.some((c) => c.title === "Supplier") &&
        s.cards.some((c) => c.title === "Inbound Reference")
    ),
    grn?.sections?.find((s) => s.kind === "party-cards")?.cards?.map((c) => c.title).join(" | ")
  )
  // The old print page joined serials with commas; a 10-serial block must now
  // collapse to a range or the table reflows off the page.
  const grnRows = grn?.sections?.find((s) => s.kind === "table")?.rows || []
  check(
    "goods-receipt-note collapses serials to a range",
    /^SN-\d+-001–SN-\d+-010$/.test(String(grnRows[0]?.serials || "")),
    grnRows[0]?.serials
  )
  check(
    "goods-receipt-note renders a dash for unserialised lines",
    grnRows[1]?.serials === "-",
    grnRows[1]?.serials
  )

  // ---- cycle count sheets: the blind-count control both ways ---------------
  const plans = await seedCountPlans(fixtures)

  const openSheet = await assertDocument(
    token, "cycle-count-sheet (open)", "cycle-count-sheet", plans.open, { minRows: 2 }
  )
  const openTable = openSheet?.sections?.find((s) => s.kind === "table")
  check(
    "open count sheet prints the system quantity",
    openTable?.columns?.some((c) => c.key === "expected") && openTable?.rows?.[0]?.expected === 100,
    `col=${!!openTable?.columns?.some((c) => c.key === "expected")} value=${openTable?.rows?.[0]?.expected}`
  )

  const blindSheet = await assertDocument(
    token, "cycle-count-sheet (blind)", "cycle-count-sheet", plans.blind, { minRows: 2 }
  )
  const blindTable = blindSheet?.sections?.find((s) => s.kind === "table")
  check(
    "blind count sheet hides the system quantity column",
    !blindTable?.columns?.some((c) => c.key === "expected"),
    blindTable?.columns?.map((c) => c.key).join(",")
  )
  // The column being absent is not enough. The model is JSON on the wire, so the
  // value must not be in the payload at all or the blind count is defeated by
  // anyone who opens the network tab.
  check(
    "blind count sheet omits the system quantity from the payload",
    (blindTable?.rows || []).every(
      (row) => !Object.prototype.hasOwnProperty.call(row, "expected")
    ),
    JSON.stringify(blindTable?.rows?.[0])
  )

  // ---- commercial invoice --------------------------------------------------
  const invoiceId = await seedInvoice(fixtures)
  const invoice = await assertDocument(
    token, "commercial-invoice", "commercial-invoice", invoiceId, { minRows: 2 }
  )
  const invTable = invoice?.sections?.find((s) => s.kind === "table")
  check(
    "invoice groups money in Indian digits",
    invTable?.totals?.gross === "2,16,780.00",
    invTable?.totals?.gross
  )
  check(
    "invoice renders amount in words",
    invoice?.sections
      ?.find((s) => s.kind === "fields" && s.title === "Amount in Words")
      ?.fields?.[0]?.value === "Rupees Two Lakh Sixteen Thousand Seven Hundred Eighty only",
    invoice?.sections?.find((s) => s.kind === "fields" && s.title === "Amount in Words")?.fields?.[0]
      ?.value
  )
  // Intra-state supply must show CGST+SGST and drop the all-zero IGST column,
  // which would otherwise waste a tenth of the table width on every invoice.
  // Wide tables print landscape (FR-10). This is a per-type decision so the same
  // document always prints the same way, rather than depending on who printed it.
  check(
    "invoice prints landscape",
    invoice?.orientation === "landscape",
    invoice?.orientation
  )
  check(
    "invoice shows CGST/SGST and not IGST for intra-state supply",
    invTable?.columns?.some((c) => c.key === "cgst") &&
      invTable?.columns?.some((c) => c.key === "sgst") &&
      !invTable?.columns?.some((c) => c.key === "igst"),
    invTable?.columns?.map((c) => c.key).join(",")
  )
  // An invoice belongs to no warehouse; null (not 0) is what lets requireScope
  // skip the dimension instead of denying every warehouse-scoped user.
  check(
    "invoice builds for a warehouse-scoped read",
    invoice?.type === "commercial-invoice",
    invoice?.documentNumber
  )

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
  // The packable pool is capped at the line's outstanding quantity and ordered by
  // the DO's allocation rule, so it is NARROWER than every eligible serial, not
  // wider. Because this run owns its item outright, the pool must be exactly the
  // serials it seeded — filtered by item_code so unrelated fixture stock on other
  // lines cannot mask a regression either way.
  const poolIds = (rows) =>
    new Set(rows.filter((s) => s.item_code === itemCode).map((s) => Number(s.id)))
  const packableBefore = poolIds(emptyTail.packable_serials)
  check(
    "tail: the packable pool is exactly this run's serials",
    packableBefore.size === serialIds.length && serialIds.every((id) => packableBefore.has(id)),
    `pool=${[...packableBefore].join(",")} seeded=${serialIds.join(",")}`
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

  // The manifest is derived from the load's vehicle + dispatch date, since the
  // schema has no trip entity. One load means a one-stop manifest, which is a
  // legitimate single-drop trip — what matters is that the stop carries a real
  // DO rather than an empty row.
  const manifest = await assertDocument(token, "dispatch-manifest", "dispatch-manifest", load.id)
  check(
    "dispatch-manifest prints landscape",
    manifest?.orientation === "landscape",
    manifest?.orientation
  )
  check(
    "dispatch-manifest stop carries a DO",
    (manifest?.sections?.find((s) => s.kind === "table")?.rows || []).some((r) =>
      String(r.do_number || "").startsWith("DO-DOCS-")
    ),
    manifest?.sections?.find((s) => s.kind === "table")?.rows?.[0]?.do_number
  )

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
  const packableAfter = poolIds(fullTail.packable_serials)
  check(
    "tail: shipped serials left the packable pool",
    serialIds.every((id) => !packableAfter.has(id)),
    `pool=${[...packableAfter].join(",") || "empty"}`
  )
  check(
    "tail: pool shrank by exactly this run's serials",
    packableBefore.size - packableAfter.size === QTY,
    `${packableBefore.size} -> ${packableAfter.size}`
  )

  // The delivery note is the one document whose content changes at finalize.
  const finalDn = await assertDocument(token, "delivery-note (final)", "delivery-note", dnId)
  // Status is a first-class field on the model rather than a row in the meta
  // grid, because the printed badge is colour-coded off its tone (FR-02). The
  // tone is asserted too: a status that renders in the wrong colour on a loading
  // bay is a real defect, and "COMPLETED" mapping to anything but a completed
  // tone would be silent.
  check(
    "delivery note reports COMPLETED",
    finalDn?.status?.label === "COMPLETED",
    finalDn?.status?.label
  )
  check(
    "delivery note status tone is completed",
    finalDn?.status?.tone === "completed",
    finalDn?.status?.tone
  )

  // ---- gate pass: seeded here so the DO's pack units already exist ----------
  const gateOutId = await seedGateOut(fixtures, doId)
  const gatePass = await assertDocument(token, "gate-pass", "gate-pass", gateOutId)
  check(
    "gate pass lists the packages leaving the premises",
    (gatePass?.sections?.find((s) => s.kind === "table")?.rows || []).length > 0,
    gatePass?.sections?.find((s) => s.kind === "table")?.rows?.length
  )
  check(
    "gate pass carries vehicle and document-check cards",
    gatePass?.sections?.some(
      (s) =>
        s.kind === "party-cards" &&
        s.cards.some((c) => c.title === "Vehicle & Driver") &&
        s.cards.some((c) => c.title === "Documents Checked")
    ),
    gatePass?.sections?.find((s) => s.kind === "party-cards")?.cards?.map((c) => c.title).join(" | ")
  )
  // Internal operating paper carries GWU's letterhead, not the tenant's — the
  // branding split from Phase 0. The delivery note above proves the other side.
  check(
    "gate pass uses the internal letterhead",
    gatePass?.branding?.companyName !== finalDn?.branding?.companyName,
    `gate-pass=${gatePass?.branding?.companyName} vs delivery-note=${finalDn?.branding?.companyName}`
  )

  // ---- reachability --------------------------------------------------------
  // Every document type must be linked from somewhere in the UI.
  //
  // This exists because four types shipped with builders, API routes and full
  // green coverage here, yet no button anywhere opened them — the suite calls
  // the API directly, so it could not see that a user had no way in. A document
  // nobody can reach is not delivered, and only a printed export revealed it.
  await checkUiReachability()

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
  // Reporting only -- the exit code comes from the finally below, so the run's
  // throwaway items are removed whether it passed or failed.
  if (failures > 0) {
    console.log(`Documents: ${failures} check(s) failed.`)
    return
  }
  console.log("Documents: all checks passed.")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    failures = failures || 1
  })
  .finally(async () => {
    if (TEARDOWN.companyId) {
      await withDb((db) => deleteTestFixtures(db, TEARDOWN)).catch((error) => {
        console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    process.exit(failures ? 1 : 0)
  })