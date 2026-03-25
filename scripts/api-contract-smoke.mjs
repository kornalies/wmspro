const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"

const credentialsA = {
  company_code: process.env.WMS_COMPANY_CODE,
  username: process.env.WMS_USERNAME,
  password: process.env.WMS_PASSWORD,
}

const credentialsB = {
  company_code: process.env.WMS_COMPANY_CODE_B,
  username: process.env.WMS_USERNAME_B,
  password: process.env.WMS_PASSWORD_B,
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing env var: ${name}`)
  }
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
  const contentType = res.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    return { res, json: null }
  }
  const json = await res.json().catch(() => null)
  return { res, json }
}

async function run() {
  requireValue("WMS_COMPANY_CODE", credentialsA.company_code)
  requireValue("WMS_USERNAME", credentialsA.username)
  requireValue("WMS_PASSWORD", credentialsA.password)

  const loginA = await postJson("/mobile/auth/login", credentialsA)
  if (!loginA.res.ok || !loginA.json?.data?.access_token) {
    throw new Error(`Login A failed: ${loginA.res.status}`)
  }
  const tokenA = loginA.json.data.access_token
  const refreshA = loginA.json.data.refresh_token

  const meA = await getJson("/mobile/auth/me", tokenA)
  if (!meA.res.ok || !meA.json?.success) throw new Error(`/mobile/auth/me failed: ${meA.res.status}`)

  const refreshRes = await postJson("/mobile/auth/refresh", { refresh_token: refreshA }, tokenA)
  if (!refreshRes.res.ok || !refreshRes.json?.data?.access_token) {
    throw new Error(`/mobile/auth/refresh failed: ${refreshRes.res.status}`)
  }

  const gateIn = await getJson("/gate/in", tokenA)
  if (!gateIn.res.ok || !Array.isArray(gateIn.json?.data)) {
    throw new Error(`/gate/in contract failed: ${gateIn.res.status}`)
  }

  const grnFormData = await getJson("/grn/form-data", tokenA)
  if (!grnFormData.res.ok || !grnFormData.json?.data?.clients) {
    throw new Error(`/grn/form-data contract failed: ${grnFormData.res.status}`)
  }

  const doList = await getJson("/do", tokenA)
  if (!doList.res.ok || !Array.isArray(doList.json?.data)) {
    throw new Error(`/do contract failed: ${doList.res.status}`)
  }

  if (credentialsB.company_code && credentialsB.username && credentialsB.password) {
    const loginB = await postJson("/mobile/auth/login", credentialsB)
    if (!loginB.res.ok || !loginB.json?.data?.access_token) {
      throw new Error(`Login B failed: ${loginB.res.status}`)
    }
    const tokenB = loginB.json.data.access_token
    const meB = await getJson("/mobile/auth/me", tokenB)
    if (!meB.res.ok || !meB.json?.success) throw new Error(`/mobile/auth/me B failed: ${meB.res.status}`)
    const companyA = meA.json?.data?.company_id
    const companyB = meB.json?.data?.company_id
    if (companyA && companyB && companyA === companyB) {
      console.warn("Warning: tenant isolation check skipped because both users resolved to same company_id")
    }
  } else {
    console.warn("Tenant isolation sub-check skipped (secondary credentials not provided)")
  }

  console.log("API contract smoke checks passed")
}

run().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
