import { ensureChaosFixtures } from "../tests/chaos/_shared.mjs"

const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"

async function resolveCredentials() {
  if (process.env.WMS_COMPANY_CODE && process.env.WMS_USERNAME && process.env.WMS_PASSWORD) {
    return {
      company_code: process.env.WMS_COMPANY_CODE,
      username: process.env.WMS_USERNAME,
      password: process.env.WMS_PASSWORD,
    }
  }

  const fixtures = await ensureChaosFixtures()
  return {
    company_code: fixtures.tenantA.code,
    username: fixtures.tenantA.username,
    password: fixtures.tenantA.password,
  }
}

async function requestJson(path, { method = "GET", token, body } = {}) {
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

function assertOk(label, result) {
  if (!result.res.ok || result.res.status >= 500) {
    throw new Error(`${label} failed: ${result.res.status} ${JSON.stringify(result.json)}`)
  }
}

async function run() {
  const credentials = await resolveCredentials()

  const login = await requestJson("/mobile/auth/login", { method: "POST", body: credentials })
  assertOk("login", login)
  const token = login.json?.data?.access_token
  if (!token) throw new Error("Login did not return access_token")

  const form = await requestJson("/grn/form-data", { token })
  assertOk("grn form data", form)
  const client = form.json?.data?.clients?.[0]
  const warehouse = form.json?.data?.warehouses?.[0]
  const item = form.json?.data?.items?.[0]
  if (!client || !warehouse || !item) {
    throw new Error("Smoke requires at least one active client, warehouse, and item")
  }

  const serial = `P0-SMOKE-${Date.now()}`
  const grn = await requestJson("/grn", {
    method: "POST",
    token,
    body: {
      header: {
        client_id: Number(client.id),
        warehouse_id: Number(warehouse.id),
        invoice_number: `P0-INV-${Date.now()}`,
        invoice_date: new Date().toISOString().slice(0, 10),
        total_items: 1,
        total_quantity: 1,
        total_value: Number(item.standard_mrp || 1),
        status: "CONFIRMED",
      },
      lineItems: [
        {
          item_id: Number(item.id),
          quantity: 1,
          rate: Number(item.standard_mrp || 1),
          serial_numbers: [serial],
        },
      ],
    },
  })
  assertOk("grn create", grn)

  const stock = await requestJson(`/stock/search?serial=${encodeURIComponent(serial)}`, { token })
  assertOk("stock search", stock)
  const stockRows = stock.json?.data?.rows || []
  if (!JSON.stringify(stockRows).includes(serial)) {
    throw new Error(`Created serial ${serial} was not visible in stock search`)
  }

  const deliveryOrder = await requestJson("/do", {
    method: "POST",
    token,
    body: {
      header: {
        client_id: Number(client.id),
        warehouse_id: Number(warehouse.id),
        delivery_address: "P0 smoke delivery address",
        customer_name: "P0 Smoke Customer",
        dispatch_date: new Date().toISOString().slice(0, 10),
        total_items: 1,
        total_quantity_requested: 1,
      },
      lineItems: [{ item_id: Number(item.id), quantity_requested: 1 }],
    },
  })
  assertOk("do create", deliveryOrder)

  const billing = await requestJson("/finance/billing", { token })
  assertOk("billing summary", billing)

  const portalClients = await requestJson("/portal/clients", { token })
  assertOk("portal clients", portalClients)
  const portalClient = portalClients.json?.data?.find((row) => Number(row.id) === Number(client.id)) || portalClients.json?.data?.[0]
  if (portalClient?.id) {
    const portalReport = await requestJson(`/portal/reports?client_id=${portalClient.id}`, { token })
    assertOk("portal reports", portalReport)
  }

  console.log("P0 flow smoke passed")
}

run().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
