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

async function createGRN(token, status) {
  const warehouseId = await getFirstId(token, "/api/warehouses?is_active=true")
  const clientId = await getFirstId(token, "/api/clients?is_active=true")
  const itemId = await getFirstId(token, "/api/items?is_active=true")
  const ts = Date.now()
  const serial = `TST-GRN-CANCEL-${ts}-${Math.floor(Math.random() * 1000)}`

  const payload = {
    header: {
      client_id: clientId,
      warehouse_id: warehouseId,
      invoice_number: `INV-TST-${ts}`,
      invoice_date: new Date().toISOString().slice(0, 10),
      total_items: 1,
      total_quantity: 1,
      total_value: 1,
      received_quantity: 1,
      status,
    },
    lineItems: [
      {
        item_id: itemId,
        quantity: 1,
        serial_numbers: [serial],
        rate: 1,
      },
    ],
  }

  const { res, json } = await request("/api/grn", {
    method: "POST",
    token,
    body: payload,
  })
  assert(res.ok, `Failed to create ${status} GRN: ${JSON.stringify(json)}`)
  const grnId = Number(json?.data?.id || 0)
  assert(grnId > 0, `Invalid GRN id for ${status}`)
  return grnId
}

async function cancelGRN(token, grnId) {
  return request(`/api/grn/${grnId}`, {
    method: "DELETE",
    token,
  })
}

async function run() {
  const token = await login()

  // Case 1: Confirmed GRN cancellation should reverse stock + void billing tx.
  const confirmedGrnId = await createGRN(token, "CONFIRMED")
  const cancelConfirmed = await cancelGRN(token, confirmedGrnId)
  assert(
    cancelConfirmed.res.ok,
    `Confirmed GRN cancel failed: ${cancelConfirmed.res.status} ${JSON.stringify(cancelConfirmed.json)}`
  )
  const confirmedData = cancelConfirmed.json?.data || {}
  assert(
    confirmedData.status === "CANCELLED",
    `Expected CANCELLED status for confirmed GRN, got ${JSON.stringify(confirmedData)}`
  )
  assert(
    Number(confirmedData.reversed_stock_count || 0) >= 1,
    `Expected reversed_stock_count >= 1, got ${JSON.stringify(confirmedData)}`
  )

  // Case 2: Re-cancel same GRN should be idempotent.
  const recancel = await cancelGRN(token, confirmedGrnId)
  assert(
    recancel.res.ok,
    `Re-cancel GRN failed: ${recancel.res.status} ${JSON.stringify(recancel.json)}`
  )
  const recancelData = recancel.json?.data || {}
  assert(
    recancelData.status === "CANCELLED",
    `Expected idempotent CANCELLED status, got ${JSON.stringify(recancelData)}`
  )

  // Case 3: Draft GRN cancellation should work with zero stock reversal.
  const draftGrnId = await createGRN(token, "DRAFT")
  const cancelDraft = await cancelGRN(token, draftGrnId)
  assert(
    cancelDraft.res.ok,
    `Draft GRN cancel failed: ${cancelDraft.res.status} ${JSON.stringify(cancelDraft.json)}`
  )
  const draftData = cancelDraft.json?.data || {}
  assert(
    draftData.status === "CANCELLED",
    `Expected CANCELLED status for draft GRN, got ${JSON.stringify(draftData)}`
  )
  assert(
    Number(draftData.reversed_stock_count || 0) === 0,
    `Expected draft reversed_stock_count = 0, got ${JSON.stringify(draftData)}`
  )

  console.log("GRN cancellation compliance checks passed")
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

