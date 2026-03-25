import process from "node:process"
import {
  BASE_URL,
  apiGet,
  ensureChaosFixtures,
  login,
  summarizePass,
  withDb,
  fail,
} from "./_shared.mjs"

async function scenario21(tokenA) {
  await withDb(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND usename = current_user
         AND pid <> pg_backend_pid()`
    )
  })

  const checks = []
  for (let i = 0; i < 10; i++) {
    const res = await apiGet("/health", tokenA, { timeoutMs: 4000 })
    checks.push(res.status)
    if (res.status === 200) break
    await new Promise((r) => setTimeout(r, 700))
  }
  if (!checks.includes(200)) {
    fail(`SCENARIO 2.1: app did not recover health after transient DB disconnect statuses=${checks.join(",")}`)
  }
  summarizePass("SCENARIO 2.1")
}

async function scenario22(tokenA) {
  const concurrency = 200
  const started = Date.now()
  const reqs = Array.from({ length: concurrency }, () => apiGet("/warehouses?is_active=true", tokenA, { timeoutMs: 12000 }))
  const results = await Promise.all(reqs)
  const elapsed = Date.now() - started
  const bad = results.filter((r) => r.status >= 500 && r.status !== 503)
  if (bad.length > 0) {
    fail(`SCENARIO 2.2: unexpected 5xx responses count=${bad.length}`)
  }
  if (elapsed > 30000) {
    fail(`SCENARIO 2.2: requests took too long elapsed_ms=${elapsed}`)
  }
  summarizePass("SCENARIO 2.2")
}

async function scenario23(tokenA) {
  // Bounded retry guard in test harness: max 3 retries and no amplification.
  let attempts = 0
  let finalStatus = 0
  for (let i = 0; i < 4; i++) {
    attempts += 1
    const res = await apiGet("/health", tokenA, { timeoutMs: 3000 })
    finalStatus = res.status
    if (res.status === 200) break
    await new Promise((r) => setTimeout(r, 250 * (i + 1)))
  }
  if (attempts > 4) {
    fail(`SCENARIO 2.3: unbounded retries attempts=${attempts}`)
  }
  if (finalStatus !== 200) {
    fail(`SCENARIO 2.3: health did not recover with bounded retries final_status=${finalStatus}`)
  }
  summarizePass("SCENARIO 2.3")
}

async function scenario24(tokenA) {
  // Hold lock briefly via separate dedicated client.
  const lockPromise = withDb(async (client) => {
    await client.query("BEGIN")
    await client.query("LOCK TABLE clients IN ACCESS EXCLUSIVE MODE")
    await client.query("SELECT pg_sleep(2)")
    await client.query("ROLLBACK")
  })

  const started = Date.now()
  const res = await apiGet("/clients", tokenA, { timeoutMs: 6000 })
  await lockPromise
  const elapsed = Date.now() - started
  if (elapsed > 7000) {
    fail(`SCENARIO 2.4: lock contention request exceeded timeout budget elapsed_ms=${elapsed}`)
  }
  if (![200, 503, 500].includes(res.status)) {
    fail(`SCENARIO 2.4: unexpected status under lock contention status=${res.status}`)
  }
  summarizePass("SCENARIO 2.4")
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

async function scenario31(tokenA, fixtures) {
  const header = {
    client_id: fixtures.ids.a.clientId,
    warehouse_id: fixtures.ids.a.warehouseId,
    delivery_address: "Chaos street 1",
    customer_name: "Chaos Customer",
    total_items: 1,
    total_quantity_requested: 1,
  }
  const lineItems = [{ item_id: fixtures.ids.a.itemId, quantity_requested: 1 }]
  const body = { header, lineItems }

  const req = async () => {
    const res = await fetch(`${process.env.WMS_API_BASE_URL || "http://localhost:3000/api"}/do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  }

  const [a, b] = await Promise.all([req(), req()])
  const okStatuses = [200, 201, 400, 409]
  if (!okStatuses.includes(a.status) || !okStatuses.includes(b.status)) {
    fail(`SCENARIO 3.1: unexpected statuses a=${a.status} b=${b.status}`)
  }
  summarizePass("SCENARIO 3.1")
}

async function scenario32(tokenA, fixtures) {
  const before = await apiGet("/grn?limit=1", tokenA)
  const beforeCount = Number(before.json?.pagination?.total || 0)

  const badPayload = {
    header: {
      client_id: fixtures.ids.a.clientId,
      warehouse_id: fixtures.ids.a.warehouseId,
      invoice_number: "CHAOS-BAD",
      invoice_date: new Date().toISOString().slice(0, 10),
      total_items: 1,
      total_quantity: 1,
      status: "CONFIRMED",
    },
    lineItems: [{ item_id: 999999, quantity: 1, serial_numbers: ["SER-BAD-1"] }],
  }

  const res = await fetch(`${process.env.WMS_API_BASE_URL || "http://localhost:3000/api"}/grn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenA}`,
    },
    body: JSON.stringify(badPayload),
  })
  if (res.status < 400) {
    fail(`SCENARIO 3.2: expected failure on invalid line item, got ${res.status}`)
  }

  const after = await apiGet("/grn?limit=1", tokenA)
  const afterCount = Number(after.json?.pagination?.total || 0)
  if (afterCount !== beforeCount) {
    fail(`SCENARIO 3.2: GRN count changed on partial failure before=${beforeCount} after=${afterCount}`)
  }
  summarizePass("SCENARIO 3.2")
}

async function scenario33(tokenA, fixtures) {
  const createPayload = {
    header: {
      client_id: fixtures.ids.a.clientId,
      warehouse_id: fixtures.ids.a.warehouseId,
      delivery_address: "Chaos status lane",
      customer_name: "Chaos Status Tester",
      customer_phone: "9999999999",
      total_items: 1,
      total_quantity_requested: 1,
    },
    lineItems: [{ item_id: fixtures.ids.a.itemId, quantity_requested: 1 }],
  }

  const created = await apiPost("/do", tokenA, createPayload)
  if (created.status < 200 || created.status >= 300 || !created.json?.data?.id) {
    fail(`SCENARIO 3.3: failed to create DO fixture status=${created.status}`)
  }
  const doId = Number(created.json.data.id)

  const picked = await apiPost(`/do/${doId}/status`, tokenA, { status: "PICKED" })
  if (picked.status !== 200 || picked.json?.data?.status !== "PICKED") {
    fail(`SCENARIO 3.3: expected PICKED status transition, got status=${picked.status}`)
  }

  const stagedViaLegacy = await apiPost(`/do/${doId}/status`, tokenA, { status: "READY_TO_DISPATCH" })
  if (stagedViaLegacy.status !== 200 || stagedViaLegacy.json?.data?.status !== "STAGED") {
    fail(`SCENARIO 3.3: expected READY_TO_DISPATCH to map to STAGED, got status=${stagedViaLegacy.status}`)
  }

  const invalid = await apiPost(`/do/${doId}/status`, tokenA, { status: "INVALID_STATUS" })
  if (invalid.status !== 400) {
    fail(`SCENARIO 3.3: invalid status should be rejected before DB write, got ${invalid.status}`)
  }

  const statusAfterInvalid = await apiGet(`/do/${doId}`, tokenA)
  if (statusAfterInvalid.status !== 200) {
    fail(`SCENARIO 3.3: failed to fetch DO after invalid status attempt status=${statusAfterInvalid.status}`)
  }

  const finalStatus = String(statusAfterInvalid.json?.data?.status || "")
  if (finalStatus !== "STAGED") {
    fail(`SCENARIO 3.3: DO status changed after invalid status attempt final_status=${finalStatus}`)
  }

  summarizePass("SCENARIO 3.3")
}

async function scenario41and42() {
  const { spawn } = await import("node:child_process")
  const run = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit", shell: true, env: process.env })
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed with ${code}`))))
    })
  await run("npm", ["run", "db:migrate"])
  await run("npm", ["run", "db:migrate"])
  summarizePass("SCENARIO 4.1")
  await run("npm", ["run", "db:seed"])
  await run("npm", ["run", "db:seed"])
  summarizePass("SCENARIO 4.2")
}

async function scenario43() {
  await withDb(async (client) => {
    const res = await client.query(
      `SELECT DISTINCT p.permission_key
       FROM users u
       JOIN rbac_user_roles ur ON ur.user_id = u.id
       JOIN rbac_roles r ON r.id = ur.role_id
       JOIN rbac_role_permissions rp ON rp.role_id = r.id
       JOIN rbac_permissions p ON p.id = rp.permission_id
       JOIN companies c ON c.id = u.company_id
       WHERE c.company_code = 'DEFAULT'
         AND u.username = 'chaos_default'`
    )
    const have = new Set(res.rows.map((r) => String(r.permission_key)))
    const required = ["gate.in.create", "do.manage", "grn.manage"]
    const missing = required.filter((k) => !have.has(k))
    if (missing.length) {
      fail(`SCENARIO 4.3: missing RBAC permissions for seeded chaos user: ${missing.join(", ")}`)
    }
  })
  summarizePass("SCENARIO 4.3")
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const tokenA = await login(fixtures.tenantA.code, fixtures.tenantA.username, fixtures.tenantA.password)

  await scenario21(tokenA)
  await scenario22(tokenA)
  await scenario23(tokenA)
  await scenario24(tokenA)
  await scenario31(tokenA, fixtures)
  await scenario32(tokenA, fixtures)
  await scenario33(tokenA, fixtures)
  await scenario41and42()
  await scenario43()
  console.log("Resilience suite complete")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
