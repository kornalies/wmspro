import process from "node:process"

const baseUrl = process.env.WMS_BASE_URL || "http://localhost:3000"
const companyCode = process.env.WMS_COMPANY_CODE || "DEFAULT"
const username = process.env.WMS_USERNAME || "admin"
const password = process.env.WMS_PASSWORD || "Admin@12345"

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

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
  assert(json?.data?.token, "Login response missing token")
  return json.data.token
}

async function run() {
  const token = await login()

  const policyVersionBefore = await request("/api/v1/policy/version", { token })
  assert(policyVersionBefore.res.ok, "Failed to read policy version before update")
  const versionBefore = Number(policyVersionBefore.json?.data?.configVersion || 0)
  assert(versionBefore > 0, "Invalid starting config version")

  const currentSettings = await request("/api/admin/tenant-settings", { token })
  assert(currentSettings.res.ok, "Failed to fetch tenant settings")
  const initialFeatureFlags = currentSettings.json?.data?.feature_flags || {}

  const disableBilling = await request("/api/admin/tenant-settings", {
    method: "PUT",
    token,
    body: {
      feature_flags: {
        ...initialFeatureFlags,
        billing: false,
      },
    },
  })
  assert(disableBilling.res.ok, `Failed to disable billing: ${JSON.stringify(disableBilling.json)}`)

  const policyVersionAfter = await request("/api/v1/policy/version", { token })
  assert(policyVersionAfter.res.ok, "Failed to read policy version after update")
  const versionAfter = Number(policyVersionAfter.json?.data?.configVersion || 0)
  assert(versionAfter > versionBefore, "Config version did not increment")

  const billingBlocked = await request("/api/finance/billing", { token })
  assert(billingBlocked.res.status === 403, "Billing endpoint was not blocked")
  assert(
    billingBlocked.json?.error?.code === "FEATURE_DISABLED",
    `Expected FEATURE_DISABLED, got ${JSON.stringify(billingBlocked.json)}`
  )

  const me = await request("/api/auth/me", { token })
  assert(me.res.ok, "Failed to fetch auth/me")
  const userId = Number(me.json?.data?.id || 0)
  assert(userId > 0, "auth/me did not return valid user id")

  const warehouses = await request("/api/warehouses?is_active=true", { token })
  assert(warehouses.res.ok, "Failed to fetch warehouses")
  const warehouseId = Number(warehouses.json?.data?.[0]?.id || 0)
  assert(warehouseId > 0, "Need at least one warehouse for scope test")

  const setScopes = await request("/api/admin/scopes", {
    method: "PUT",
    token,
    body: {
      user_id: userId,
      warehouse_ids: [warehouseId],
      zone_ids: [],
      client_ids: [],
    },
  })
  assert(setScopes.res.ok, `Failed to set scopes: ${JSON.stringify(setScopes.json)}`)

  const forbiddenWarehouseId = warehouseId + 999999
  const scopeDenied = await request(`/api/stock/putaway?warehouse_id=${forbiddenWarehouseId}`, { token })
  assert(scopeDenied.res.status === 403, "Scope guard did not block warehouse access")
  assert(
    scopeDenied.json?.error?.code === "SCOPE_DENIED",
    `Expected SCOPE_DENIED, got ${JSON.stringify(scopeDenied.json)}`
  )

  // Restore billing feature so repeated runs are idempotent.
  await request("/api/admin/tenant-settings", {
    method: "PUT",
    token,
    body: {
      feature_flags: initialFeatureFlags,
    },
  })

  // Restore unrestricted scope for current user.
  await request("/api/admin/scopes", {
    method: "PUT",
    token,
    body: {
      user_id: userId,
      warehouse_ids: [],
      zone_ids: [],
      client_ids: [],
    },
  })

  console.log("Policy acceptance checks passed")
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
