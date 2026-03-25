const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"

const credentials = {
  company_code: process.env.WMS_COMPANY_CODE,
  username: process.env.WMS_USERNAME,
  password: process.env.WMS_PASSWORD,
}

function requireValue(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`)
}

async function postJson(path, body, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

async function getJson(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

function assertNotServerError(path, res) {
  if (res.status >= 500) throw new Error(`${path} returned server error ${res.status}`)
}

async function run() {
  requireValue("WMS_COMPANY_CODE", credentials.company_code)
  requireValue("WMS_USERNAME", credentials.username)
  requireValue("WMS_PASSWORD", credentials.password)

  const login = await postJson("/mobile/auth/login", credentials)
  if (!login.res.ok || !login.json?.data?.access_token) {
    throw new Error(`Login failed: ${login.res.status}`)
  }
  const token = login.json.data.access_token

  const checks = [
    () => getJson("/mobile/auth/me", token),
    () => getJson("/gate/in", token),
    () => getJson("/grn/form-data", token),
    () => getJson("/do", token),
    () => getJson("/portal/clients", token),
  ]

  for (const runCheck of checks) {
    const { res } = await runCheck()
    assertNotServerError("core-check", res)
  }

  const portalClients = await getJson("/portal/clients", token)
  assertNotServerError("/portal/clients", portalClients.res)
  const firstClientId = portalClients.json?.data?.[0]?.id
  if (firstClientId) {
    const portalChecks = [
      `/portal/reports?client_id=${firstClientId}`,
      `/portal/orders?client_id=${firstClientId}`,
      `/portal/inventory?client_id=${firstClientId}`,
      `/portal/billing?client_id=${firstClientId}`,
      `/portal/asn?client_id=${firstClientId}`,
    ]
    for (const path of portalChecks) {
      const result = await getJson(path, token)
      assertNotServerError(path, result.res)
    }
  }

  const sampleLookup = process.env.WMS_SMOKE_ITEM_QUERY || "ITEM"
  const sampleBarcode = process.env.WMS_SMOKE_BARCODE || "DO-"
  const scanChecks = [
    () => postJson("/mobile/scans/items/lookup", { query: sampleLookup, limit: 5 }, token),
    () => postJson("/mobile/scans/grn/barcode/lookup", { barcode: sampleBarcode }, token),
    () => postJson("/mobile/scans/do/parse", { barcode: sampleBarcode }, token),
  ]
  for (const runCheck of scanChecks) {
    const { res } = await runCheck()
    assertNotServerError("scan-check", res)
  }

  console.log("Pilot smoke checks passed")
}

run().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})

