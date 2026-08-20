/**
 * ASN -> GRN: the link between what a client announces and what the warehouse
 * receives.
 *
 * Before migration 081 this path did not exist. A client could submit a
 * shipment notice with no line items, and nothing on the operator side ever
 * read the row -- the request sat at REQUESTED forever. This suite is what
 * keeps the wiring connected end to end:
 *
 *   client announces (itemised) -> staff sees it -> staff accepts
 *   -> GRN cites the request -> request flips to RECEIVED
 *   -> client sees the receipt
 *
 * The negative cases matter as much as the happy path. An empty request, a
 * receipt pointed at another client's announcement, and a second review of an
 * already-reviewed request are all things the API must refuse, because each one
 * would show a client something untrue about their own goods.
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import bcrypt from "bcryptjs"

import { BASE_URL, CHAOS_PASSWORD, ensureChaosFixtures, login, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const PORTAL_PASSWORD = "Portal@12345"
const PORTAL_USER = `asn_client_${SUFFIX}`

let failures = 0
function check(label, condition, extra = "") {
  const status = condition ? "PASS" : "FAIL"
  console.log(`${status}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

async function api(path, { token, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function seedPortalUser(db, { companyId, clientId }) {
  await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
  const passwordHash = await bcrypt.hash(PORTAL_PASSWORD, 10)
  const user = await db.query(
    `INSERT INTO users (company_id, username, email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, 'CLIENT', $5, true)
     ON CONFLICT (company_id, username)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
     RETURNING id`,
    [companyId, PORTAL_USER, `${PORTAL_USER}@example.test`, "ASN Test Client", passwordHash]
  )
  const userId = Number(user.rows[0].id)

  await db.query(
    `INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (company_id, user_id, client_id) DO UPDATE SET is_active = true`,
    [companyId, userId, clientId]
  )
  for (const key of ["portal.asn.view", "portal.asn.create"]) {
    await db.query(
      `INSERT INTO portal_user_permissions (company_id, user_id, feature_key, is_allowed)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (company_id, user_id, feature_key) DO UPDATE SET is_allowed = true`,
      [companyId, userId, key]
    )
  }
  return userId
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const { companyId } = fixtures.tenantA
  const { clientId, warehouseId, itemId } = fixtures.ids.a

  let portalUserId
  let otherClientId
  await withDb(async (db) => {
    portalUserId = await seedPortalUser(db, { companyId, clientId })
    // A second client in the same tenant, to prove a receipt cannot be attached
    // to another client's announcement.
    const other = await db.query(
      `INSERT INTO clients (company_id, client_code, client_name, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (company_id, client_code) DO UPDATE SET is_active = true
       RETURNING id`,
      [companyId, `ASNOTH${SUFFIX}`.slice(0, 20), `ASN Other ${SUFFIX}`]
    )
    otherClientId = Number(other.rows[0].id)
  })

  const clientToken = await login("DEFAULT", PORTAL_USER, PORTAL_PASSWORD)
  const staffToken = await login("DEFAULT", "chaos_default", CHAOS_PASSWORD)

  // -------------------------------------------------------------------------
  // Client announces a shipment.
  // -------------------------------------------------------------------------
  const empty = await api("/portal/asn", {
    token: clientToken,
    method: "POST",
    body: { client_id: clientId, expected_date: "2026-09-01", lines: [] },
  })
  check("a request with no line items is refused", empty.status === 400, `status=${empty.status}`)

  const badItem = await api("/portal/asn", {
    token: clientToken,
    method: "POST",
    body: {
      client_id: clientId,
      lines: [{ item_id: 99999999, expected_quantity: 5 }],
    },
  })
  check(
    "a request naming an unknown item is refused",
    badItem.status === 400 && badItem.json?.error?.code === "UNKNOWN_ITEM",
    `status=${badItem.status} code=${badItem.json?.error?.code}`
  )

  const created = await api("/portal/asn", {
    token: clientToken,
    method: "POST",
    body: {
      client_id: clientId,
      expected_date: "2026-09-01",
      remarks: "Two pallets, tail lift needed",
      lines: [{ item_id: itemId, expected_quantity: 40 }],
    },
  })
  const asnId = Number(created.json?.data?.id)
  check(
    "client can announce an itemised shipment",
    created.status === 200 && Boolean(asnId) && String(created.json?.data?.request_number).startsWith("ASNREQ-"),
    `status=${created.status} number=${created.json?.data?.request_number}`
  )
  check(
    "the created request reports its line count",
    Number(created.json?.data?.line_count) === 1 && Number(created.json?.data?.expected_quantity) === 40,
    JSON.stringify(created.json?.data)
  )

  // Idempotency: the portal page sends a key, and a retry must not file the
  // shipment twice.
  const idemKey = `asn-test-${SUFFIX}`
  const first = await api("/portal/asn", {
    token: clientToken,
    method: "POST",
    headers: { "x-idempotency-key": idemKey },
    body: { client_id: clientId, lines: [{ item_id: itemId, expected_quantity: 7 }] },
  })
  const replay = await api("/portal/asn", {
    token: clientToken,
    method: "POST",
    headers: { "x-idempotency-key": idemKey },
    body: { client_id: clientId, lines: [{ item_id: itemId, expected_quantity: 7 }] },
  })
  check(
    "a retry with the same idempotency key returns the original request",
    first.status === 200 &&
      replay.status === 200 &&
      Number(first.json?.data?.id) === Number(replay.json?.data?.id),
    `first=${first.json?.data?.id} replay=${replay.json?.data?.id}`
  )

  // -------------------------------------------------------------------------
  // Staff can actually see it. This is the gap the whole feature existed in.
  // -------------------------------------------------------------------------
  const queue = await api("/grn/asn-requests", { token: staffToken })
  const queued = (queue.json?.data || []).find((row) => Number(row.id) === asnId)
  check(
    "the announcement appears in the warehouse queue",
    queue.status === 200 && Boolean(queued),
    `status=${queue.status} found=${Boolean(queued)}`
  )
  check(
    "the queue row carries the client and the expected quantity",
    queued && Number(queued.expected_quantity) === 40 && Number(queued.client_id) === clientId,
    JSON.stringify(queued)
  )

  const detail = await api(`/grn/asn-requests/${asnId}`, { token: staffToken })
  check(
    "staff can read the announced lines",
    detail.status === 200 &&
      detail.json?.data?.lines?.length === 1 &&
      Number(detail.json.data.lines[0].item_id) === itemId,
    `status=${detail.status} lines=${detail.json?.data?.lines?.length}`
  )

  // A portal user must not reach the staff queue.
  const clientOnQueue = await api("/grn/asn-requests", { token: clientToken })
  check(
    "a portal client cannot read the warehouse queue",
    clientOnQueue.status === 403,
    `status=${clientOnQueue.status}`
  )

  // -------------------------------------------------------------------------
  // Review.
  // -------------------------------------------------------------------------
  const receiveTooEarly = await api("/grn", {
    token: staffToken,
    method: "POST",
    body: {
      header: {
        client_id: clientId,
        warehouse_id: warehouseId,
        invoice_number: `INV-EARLY-${SUFFIX}`,
        invoice_date: "2026-09-01",
        total_items: 1,
        total_quantity: 40,
        status: "DRAFT",
        asn_request_id: asnId,
      },
      lineItems: [{ item_id: itemId, quantity: 40, serial_numbers: [`SN-EARLY-${SUFFIX}`] }],
    },
  })
  check(
    "a receipt against a request nobody has accepted is refused",
    receiveTooEarly.status === 400,
    `status=${receiveTooEarly.status} msg=${receiveTooEarly.json?.error?.message}`
  )

  const accept = await api(`/grn/asn-requests/${asnId}/decision`, {
    token: staffToken,
    method: "POST",
    body: { decision: "ACCEPT", remarks: "Booked a dock slot for Tuesday" },
  })
  check(
    "staff can accept the announcement",
    accept.status === 200 && accept.json?.data?.status === "ACCEPTED",
    `status=${accept.status} next=${accept.json?.data?.status}`
  )

  const acceptAgain = await api(`/grn/asn-requests/${asnId}/decision`, {
    token: staffToken,
    method: "POST",
    body: { decision: "REJECT" },
  })
  check(
    "an already-reviewed request cannot be reviewed again",
    acceptAgain.status === 409,
    `status=${acceptAgain.status}`
  )

  const clientReview = await api(`/grn/asn-requests/${asnId}/decision`, {
    token: clientToken,
    method: "POST",
    body: { decision: "ACCEPT" },
  })
  check(
    "a portal client cannot accept their own announcement",
    clientReview.status === 403,
    `status=${clientReview.status}`
  )

  // -------------------------------------------------------------------------
  // Receive against it.
  // -------------------------------------------------------------------------
  const wrongClient = await api("/grn", {
    token: staffToken,
    method: "POST",
    body: {
      header: {
        client_id: otherClientId,
        warehouse_id: warehouseId,
        invoice_number: `INV-WRONG-${SUFFIX}`,
        invoice_date: "2026-09-01",
        total_items: 1,
        total_quantity: 40,
        status: "DRAFT",
        asn_request_id: asnId,
      },
      lineItems: [{ item_id: itemId, quantity: 40, serial_numbers: [`SN-WRONG-${SUFFIX}`] }],
    },
  })
  check(
    "a receipt cannot cite another client's announcement",
    wrongClient.status === 400,
    `status=${wrongClient.status} msg=${wrongClient.json?.error?.message}`
  )

  // The received quantity deliberately differs from the announced 40: the
  // warehouse books what turned up, not what was promised.
  const grn = await api("/grn", {
    token: staffToken,
    method: "POST",
    body: {
      header: {
        client_id: clientId,
        warehouse_id: warehouseId,
        invoice_number: `INV-ASN-${SUFFIX}`,
        invoice_date: "2026-09-01",
        total_items: 1,
        total_quantity: 38,
        status: "DRAFT",
        asn_request_id: asnId,
      },
      lineItems: [
        {
          item_id: itemId,
          quantity: 38,
          serial_numbers: Array.from({ length: 38 }, (_, i) => `SN-ASN-${SUFFIX}-${i}`),
        },
      ],
    },
  })
  const grnId = Number(grn.json?.data?.id)
  check(
    "a GRN can be raised against the accepted announcement",
    grn.status === 200 && Boolean(grnId),
    `status=${grn.status} msg=${grn.json?.error?.message}`
  )

  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const stamped = await db.query(
      "SELECT asn_request_id, total_quantity FROM grn_header WHERE company_id = $1 AND id = $2",
      [companyId, grnId]
    )
    check(
      "the GRN stores the announcement it fulfils",
      Number(stamped.rows[0]?.asn_request_id) === asnId,
      `asn_request_id=${stamped.rows[0]?.asn_request_id}`
    )
    check(
      "the GRN records what arrived, not what was announced",
      Number(stamped.rows[0]?.total_quantity) === 38,
      `total_quantity=${stamped.rows[0]?.total_quantity}`
    )

    const status = await db.query(
      "SELECT status FROM client_portal_asn_requests WHERE company_id = $1 AND id = $2",
      [companyId, asnId]
    )
    check(
      "the announcement flips to RECEIVED",
      status.rows[0]?.status === "RECEIVED",
      `status=${status.rows[0]?.status}`
    )
  })

  // -------------------------------------------------------------------------
  // The client can see what happened -- the whole point of the exercise.
  // -------------------------------------------------------------------------
  const clientView = await api(`/portal/asn?client_id=${clientId}&id=${asnId}`, { token: clientToken })
  check(
    "the client sees their request as received",
    clientView.status === 200 && clientView.json?.data?.status === "RECEIVED",
    `status=${clientView.status} asn=${clientView.json?.data?.status}`
  )
  check(
    "the client sees the receipt raised against it",
    clientView.json?.data?.receipts?.length === 1 &&
      Number(clientView.json.data.receipts[0].id) === grnId,
    JSON.stringify(clientView.json?.data?.receipts)
  )
  check(
    "the client sees the warehouse's review note",
    clientView.json?.data?.review_remarks === "Booked a dock slot for Tuesday",
    `remarks=${clientView.json?.data?.review_remarks}`
  )

  // -------------------------------------------------------------------------
  // Notifications: every hop tells the other side.
  //
  // The whole point of the queue is that nobody has to remember to open it, so
  // a silent hop is a regression even when the data is correct.
  // -------------------------------------------------------------------------
  const clientNotices = await api("/notifications?status=all&limit=30", { token: clientToken })
  const clientTypes = (clientNotices.json?.data || [])
    .filter((row) => Number(row.data?.asn_request_id) === asnId)
    .map((row) => row.type)
  check(
    "the client is told their announcement was accepted",
    clientTypes.includes("asn.request.accepted"),
    `types=${JSON.stringify(clientTypes)}`
  )
  check(
    "the client is told the goods were received",
    clientTypes.includes("asn.request.received"),
    `types=${JSON.stringify(clientTypes)}`
  )

  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const staffNotice = await db.query(
      `SELECT n.user_id, n.title, n.source
       FROM notifications n
       WHERE n.company_id = $1
         AND n.type = 'asn.request.submitted'
         AND (n.data->>'asn_request_id')::int = $2`,
      [companyId, asnId]
    )
    check(
      "submitting an announcement notifies the warehouse",
      staffNotice.rows.length > 0,
      `recipients=${staffNotice.rows.length}`
    )
    check(
      "web-written notifications are tagged as such",
      staffNotice.rows.every((row) => row.source === "web"),
      `sources=${JSON.stringify(staffNotice.rows.map((r) => r.source))}`
    )
    // One row per recipient is the contract: read_at lives on the row, so a
    // shared row would let the first reader hide it for everyone.
    check(
      "the warehouse notification is one row per recipient",
      new Set(staffNotice.rows.map((row) => row.user_id)).size === staffNotice.rows.length,
      `rows=${staffNotice.rows.length}`
    )
    check(
      "the client who raised it is not notified of their own submission",
      !staffNotice.rows.some((row) => Number(row.user_id) === portalUserId),
      `portalUserId=${portalUserId}`
    )
  })

  // -------------------------------------------------------------------------
  // Cleanup: leave no half-received announcement behind for the next run.
  // -------------------------------------------------------------------------
  await withDb(async (db) => {
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    await db.query(
      `DELETE FROM notifications
       WHERE company_id = $1
         AND (data->>'asn_request_id')::int IN (
           SELECT id FROM client_portal_asn_requests WHERE company_id = $1 AND requested_by = $2
         )`,
      [companyId, portalUserId]
    )
    await db.query("UPDATE grn_header SET asn_request_id = NULL WHERE company_id = $1 AND asn_request_id IS NOT NULL AND id = $2", [companyId, grnId])
    await db.query("DELETE FROM stock_serial_numbers WHERE company_id = $1 AND serial_number LIKE $2", [companyId, `SN-ASN-${SUFFIX}-%`])
    await db.query(
      `DELETE FROM grn_line_items WHERE company_id = $1 AND grn_header_id = $2`,
      [companyId, grnId]
    )
    await db.query("DELETE FROM grn_header WHERE company_id = $1 AND id = $2", [companyId, grnId])
    await db.query(
      `DELETE FROM client_portal_asn_requests WHERE company_id = $1 AND requested_by = $2`,
      [companyId, portalUserId]
    )
    await db.query("DELETE FROM portal_user_permissions WHERE company_id = $1 AND user_id = $2", [companyId, portalUserId])
    await db.query("DELETE FROM portal_user_clients WHERE company_id = $1 AND user_id = $2", [companyId, portalUserId])
    await db.query("DELETE FROM users WHERE company_id = $1 AND id = $2", [companyId, portalUserId])
    await db.query("DELETE FROM clients WHERE company_id = $1 AND id = $2", [companyId, otherClientId])
  })

  console.log(failures === 0 ? "\nASN -> GRN suite passed" : `\nASN -> GRN suite failed (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
