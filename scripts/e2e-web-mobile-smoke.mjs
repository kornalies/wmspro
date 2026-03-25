import process from "node:process"

const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"
const COMPANY_CODE = process.env.WMS_COMPANY_CODE || "GWU"
const USERNAME = process.env.WMS_USERNAME || "wms_ci"
const PASSWORD = process.env.WMS_PASSWORD || "wms_ci_password"
const STAGED_DO_NO = process.env.WMS_STAGED_DO_NO || "DO-GWU-CI-STAGED-001"

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name, detail) {
  throw new Error(`${name}: ${detail}`)
}

async function getJson(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const json = await res.json().catch(() => null)
  return { res, json }
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

async function run() {
  const login = await postJson("/mobile/auth/login", {
    company_code: COMPANY_CODE,
    username: USERNAME,
    password: PASSWORD,
  })
  if (!login.res.ok || !login.json?.data?.access_token) {
    fail("login", `status=${login.res.status}`)
  }
  const accessToken = String(login.json.data.access_token)
  const refreshToken = String(login.json.data.refresh_token || "")
  if (!refreshToken) fail("login", "missing refresh_token")
  pass("mobile/auth/login")

  const mobileMe = await getJson("/mobile/auth/me", accessToken)
  if (!mobileMe.res.ok || !mobileMe.json?.data) {
    fail("mobile/auth/me", `status=${mobileMe.res.status}`)
  }
  pass("mobile/auth/me")

  const webMe = await getJson("/auth/me", accessToken)
  if (webMe.res.status >= 500) {
    fail("auth/me", `status=${webMe.res.status}`)
  }
  pass("auth/me")

  const refresh = await postJson("/mobile/auth/refresh", { refresh_token: refreshToken })
  if (!refresh.res.ok || !refresh.json?.data?.access_token) {
    fail("mobile/auth/refresh", `status=${refresh.res.status}`)
  }
  pass("mobile/auth/refresh")

  const doDetail = await getJson(`/do/${encodeURIComponent(STAGED_DO_NO)}`, accessToken)
  if (!doDetail.res.ok || !doDetail.json?.data?.id) {
    fail("do fixture lookup", `status=${doDetail.res.status}`)
  }
  if (String(doDetail.json.data.status || "").toUpperCase() !== "STAGED") {
    fail("do fixture status", `expected STAGED got ${doDetail.json.data.status}`)
  }
  const item = (doDetail.json.data.items || []).find((row) => Number(row.quantity_remaining || 0) > 0)
  if (!item?.item_id) {
    fail("do fixture lines", "no dispatchable line found")
  }
  pass("staged do fixture")

  const dispatch = await postJson(
    `/do/${encodeURIComponent(STAGED_DO_NO)}/dispatch`,
    {
      vehicle_number: "KA01AA1111",
      driver_name: "Smoke Driver",
      driver_phone: "9000000001",
      dispatch_date: new Date().toISOString().slice(0, 10),
      items: [{ item_id: Number(item.item_id), quantity: 1 }],
      invoiceQty: 1,
      dispatchedQty: 1,
      doNo: STAGED_DO_NO,
    },
    accessToken
  )
  if (!dispatch.res.ok || !dispatch.json?.data?.status) {
    fail("do dispatch", `status=${dispatch.res.status}`)
  }
  pass("do dispatch success path")

  const checks = [
    "/gate/in",
    "/gate/out",
    "/do",
    "/grn",
  ]
  for (const path of checks) {
    const result = await getJson(path, accessToken)
    if (result.res.status >= 500) {
      fail(path, `status=${result.res.status}`)
    }
    pass(path)
  }

  console.log("PASS full web+mobile E2E smoke")
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
