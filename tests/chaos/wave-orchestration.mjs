import pg from "pg"

import {
  BASE_URL,
  ensureChaosFixtures,
  login,
  summarizePass,
  withDb,
  fail,
} from "./_shared.mjs"

const { Client } = pg

async function apiGet(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function apiPost(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function addStock(fixtures, serial) {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query("BEGIN")
    await db.query("SELECT set_config('app.company_id', $1, true)", [String(fixtures.tenantA.companyId)])
    const grnLine = await db.query(
      `SELECT gli.id
       FROM grn_line_items gli
       JOIN grn_header gh ON gh.id = gli.grn_header_id
       WHERE gh.company_id = $1
         AND gh.grn_number = 'GRN-DEF-CHAOS'
       ORDER BY gli.id DESC
       LIMIT 1`,
      [fixtures.tenantA.companyId]
    )
    const grnLineId = Number(grnLine.rows[0]?.id || 0)
    if (!grnLineId) throw new Error("Failed to resolve GRN line for stock seed")
    await db.query(
      `INSERT INTO stock_serial_numbers (
         company_id, serial_number, item_id, client_id, warehouse_id, status, received_date, grn_line_item_id
       ) VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, $6)
       ON CONFLICT DO NOTHING`,
      [
        fixtures.tenantA.companyId,
        serial,
        fixtures.ids.a.itemId,
        fixtures.ids.a.clientId,
        fixtures.ids.a.warehouseId,
        grnLineId,
      ]
    )
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    await db.end()
  }
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures.tenantA.code, fixtures.tenantA.username, fixtures.tenantA.password)
  const me = await apiGet("/mobile/auth/me", token)
  if (me.status !== 200 || !me.json?.data?.id) {
    fail(`WAVE SCENARIO: auth me failed status=${me.status}`)
  }
  const meUserId = Number(me.json.data.id)

  const suffix = Date.now()
  await addStock(fixtures, `SER-WAVE-${suffix}`)

  const doCreate = await apiPost("/do", token, {
    header: {
      client_id: fixtures.ids.a.clientId,
      warehouse_id: fixtures.ids.a.warehouseId,
      delivery_address: "Wave test lane",
      customer_name: "Wave Tester",
      customer_phone: "9999999999",
      total_items: 1,
      total_quantity_requested: 1,
    },
    lineItems: [{ item_id: fixtures.ids.a.itemId, quantity_requested: 1 }],
  })
  if (doCreate.status !== 200 || !doCreate.json?.data?.id) {
    fail(`WAVE SCENARIO: DO create failed status=${doCreate.status}`)
  }
  const doId = Number(doCreate.json.data.id)

  const idemCreate = `idem-wave-${suffix}`
  const wavePayload = {
    warehouse_id: fixtures.ids.a.warehouseId,
    client_id: fixtures.ids.a.clientId,
    strategy: "BATCH",
    max_orders: 10,
    do_ids: [doId],
  }
  const waveCreate = await fetch(`${BASE_URL}/do/waves`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-idempotency-key": idemCreate,
    },
    body: JSON.stringify(wavePayload),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))
  if (waveCreate.status !== 200 || !waveCreate.json?.data?.id) {
    fail(`WAVE SCENARIO: wave create failed status=${waveCreate.status}`)
  }
  const waveId = Number(waveCreate.json.data.id)
  const waveCreateReplay = await fetch(`${BASE_URL}/do/waves`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-idempotency-key": idemCreate,
    },
    body: JSON.stringify(wavePayload),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))
  if (waveCreateReplay.status !== 200 || waveCreateReplay.json?.message !== "Idempotent replay") {
    fail(`WAVE SCENARIO: wave create idempotency replay failed status=${waveCreateReplay.status}`)
  }
  summarizePass("WAVE 1 CREATE")

  const waveRelease = await apiPost(`/do/waves/${waveId}/release`, token, {})
  if (waveRelease.status !== 200) {
    fail(`WAVE SCENARIO: wave release failed status=${waveRelease.status}`)
  }
  const waveReleaseAgain = await apiPost(`/do/waves/${waveId}/release`, token, {})
  if (waveReleaseAgain.status !== 409) {
    fail(`WAVE SCENARIO: wave re-release should fail 409 got ${waveReleaseAgain.status}`)
  }
  summarizePass("WAVE 2 RELEASE")

  const taskList = await apiGet(`/do/waves/tasks?wave_id=${waveId}`, token)
  if (taskList.status !== 200 || !Array.isArray(taskList.json?.data) || taskList.json.data.length === 0) {
    fail(`WAVE SCENARIO: task list failed status=${taskList.status}`)
  }
  const taskId = Number(taskList.json.data[0].id)

  const startBeforeAssign = await apiPost(`/do/waves/tasks/${taskId}/start`, token, {})
  if (startBeforeAssign.status !== 409) {
    fail(`WAVE SCENARIO: start before assign should fail 409 got ${startBeforeAssign.status}`)
  }

  const allocate = await apiPost(`/do/waves/${waveId}/allocate`, token, { user_ids: [meUserId] })
  if (allocate.status !== 200 || Number(allocate.json?.data?.allocated_tasks || 0) <= 0) {
    fail(`WAVE SCENARIO: allocate failed status=${allocate.status}`)
  }

  const assign = await apiPost(`/do/waves/tasks/${taskId}/assign`, token, {})
  if (assign.status !== 200) {
    fail(`WAVE SCENARIO: task assign failed status=${assign.status}`)
  }

  const start = await apiPost(`/do/waves/tasks/${taskId}/start`, token, {})
  if (start.status !== 200) {
    fail(`WAVE SCENARIO: task start failed status=${start.status}`)
  }

  const invalidComplete = await apiPost(`/do/waves/tasks/${taskId}/complete`, token, { picked_quantity: 999 })
  if (invalidComplete.status !== 400) {
    fail(`WAVE SCENARIO: invalid complete should fail 400 got ${invalidComplete.status}`)
  }

  const complete = await apiPost(`/do/waves/tasks/${taskId}/complete`, token, {})
  if (complete.status !== 200) {
    fail(`WAVE SCENARIO: task complete failed status=${complete.status}`)
  }
  summarizePass("WAVE 3 TASK EXECUTION")

  const taskAfter = await apiGet(`/do/waves/tasks?wave_id=${waveId}&status=DONE`, token)
  if (taskAfter.status !== 200 || !Array.isArray(taskAfter.json?.data) || taskAfter.json.data.length === 0) {
    fail(`WAVE SCENARIO: task done verification failed status=${taskAfter.status}`)
  }

  const waveList = await apiGet(`/do/waves?status=COMPLETED&warehouse_id=${fixtures.ids.a.warehouseId}`, token)
  if (waveList.status !== 200 || !Array.isArray(waveList.json?.data)) {
    fail(`WAVE SCENARIO: wave list verification failed status=${waveList.status}`)
  }
  const completed = waveList.json.data.find((w) => Number(w.id) === waveId)
  if (!completed) {
    fail("WAVE SCENARIO: expected wave to be completed")
  }

  const doAfter = await apiGet(`/do/${doId}`, token)
  if (doAfter.status !== 200) {
    fail(`WAVE SCENARIO: DO fetch failed status=${doAfter.status}`)
  }
  if (String(doAfter.json?.data?.status) !== "PICKED") {
    fail(`WAVE SCENARIO: expected DO to move to PICKED, got ${String(doAfter.json?.data?.status)}`)
  }
  summarizePass("WAVE 4 STATUS VERIFICATION")

  console.log("Wave orchestration suite complete")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
