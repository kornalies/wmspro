import process from "node:process"

const baseUrl = process.env.WMS_BASE_URL || "http://localhost:3000"
const companyCode = process.env.WMS_COMPANY_CODE || "GWU"
const username = process.env.WMS_USERNAME || "admin"
const password = process.env.WMS_PASSWORD || "Admin@12345"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function request(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

async function login() {
  const { res, json } = await request("/api/auth/login", {
    method: "POST",
    body: {
      company_code: companyCode,
      username,
      password,
    },
  })
  assert(res.ok, `Login failed: ${JSON.stringify(json)}`)
  const token = json?.data?.token
  assert(token, "Missing access token in login response")
  return token
}

async function getFirstId(token, path, field = "id") {
  const { res, json } = await request(path, { token })
  assert(res.ok, `Failed to fetch ${path}: ${JSON.stringify(json)}`)
  const rows = json?.data || []
  assert(Array.isArray(rows) && rows.length > 0, `No rows from ${path}`)
  const id = Number(rows[0]?.[field] || 0)
  assert(id > 0, `Invalid ${field} from ${path}`)
  return id
}

async function createDraftDO(token) {
  const warehouseId = await getFirstId(token, "/api/warehouses?is_active=true")
  const clientId = await getFirstId(token, "/api/clients?is_active=true")
  const itemId = await getFirstId(token, "/api/items?is_active=true")

  const payload = {
    header: {
      client_id: clientId,
      warehouse_id: warehouseId,
      delivery_address: "Compliance Test Address",
      customer_name: "Compliance Test",
      customer_phone: "9999999999",
      total_items: 1,
      total_quantity_requested: 1,
      invoice_qty: 1,
      dispatched_qty: 0,
      quantity_difference: 1,
    },
    lineItems: [
      {
        item_id: itemId,
        quantity_requested: 1,
      },
    ],
  }

  const { res, json } = await request("/api/do", {
    method: "POST",
    token,
    body: payload,
  })
  assert(res.ok, `Failed to create DO: ${JSON.stringify(json)}`)
  const doId = Number(json?.data?.id || 0)
  assert(doId > 0, "Invalid DO id in create response")
  return doId
}

async function testOverDispatchBlocked(token) {
  const doId = await createDraftDO(token)
  const { res, json } = await request(`/api/do/${doId}/dispatch`, {
    method: "POST",
    token,
    body: {
      vehicle_number: "TN01AB1234",
      driver_name: "Driver A",
      driver_phone: "9999999999",
      invoiceQty: 1,
      dispatchedQty: 2,
      items: [],
    },
  })

  assert(res.status === 409, `Expected 409 for over-dispatch, got ${res.status}`)
  assert(
    json?.error?.code === "WORKFLOW_BLOCKED",
    `Expected WORKFLOW_BLOCKED, got ${JSON.stringify(json)}`
  )
}

async function testCompletedDOLock(token) {
  const { res: listRes, json: listJson } = await request("/api/do?status=COMPLETED&limit=1", { token })
  assert(listRes.ok, `Failed to query completed DO list: ${JSON.stringify(listJson)}`)

  const rows = listJson?.data || []
  assert(
    Array.isArray(rows) && rows.length > 0,
    "No COMPLETED DO found. Create one first, then re-run this compliance test."
  )

  const doId = Number(rows[0]?.id || 0)
  assert(doId > 0, "Invalid completed DO id")

  const { res, json } = await request(`/api/do/${doId}/dispatch`, {
    method: "POST",
    token,
    body: {
      vehicle_number: "TN01AB1234",
      driver_name: "Driver A",
      driver_phone: "9999999999",
      items: [],
    },
  })

  assert(res.status === 409, `Expected 409 for completed DO dispatch, got ${res.status}`)
  assert(
    json?.error?.code === "WORKFLOW_BLOCKED",
    `Expected WORKFLOW_BLOCKED for completed DO, got ${JSON.stringify(json)}`
  )
}

async function run() {
  const token = await login()
  await testOverDispatchBlocked(token)
  await testCompletedDOLock(token)
  console.log("DO compliance checks passed")
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
