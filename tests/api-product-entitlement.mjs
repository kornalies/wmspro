import { apiGet, ensureChaosFixtures, fail, login, summarizePass, withDb } from "./chaos/_shared.mjs"

async function setProduct(client, companyId, productCode, status) {
  await client.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
  await client.query(
    `INSERT INTO tenant_products (company_id, product_code, plan_code, status)
     VALUES ($1, $2, 'ENTITLEMENT_TEST', $3)
     ON CONFLICT (company_id, product_code)
     DO UPDATE SET status = EXCLUDED.status, plan_code = EXCLUDED.plan_code, updated_at = NOW()`,
    [companyId, productCode, status]
  )
}

async function run() {
  const fixtures = await ensureChaosFixtures()
  const companyId = fixtures.tenantB.companyId

  await withDb(async (client) => {
    await setProduct(client, companyId, "WMS", "INACTIVE")
    await setProduct(client, companyId, "FF", "INACTIVE")
  })

  const token = await login(fixtures.tenantB.code, fixtures.tenantB.username, fixtures.tenantB.password)
  const wmsDenied = await apiGet("/grn/form-data", token)
  if (wmsDenied.status !== 403 || wmsDenied.json?.error?.code !== "PRODUCT_DISABLED") {
    fail(`Expected disabled WMS route to return PRODUCT_DISABLED 403, got ${wmsDenied.status}`)
  }

  const freightDenied = await apiGet("/freight/shipments", token)
  if (freightDenied.status !== 403 || freightDenied.json?.error?.code !== "PRODUCT_DISABLED") {
    fail(`Expected disabled FF route to return PRODUCT_DISABLED 403, got ${freightDenied.status}`)
  }

  await withDb(async (client) => {
    await setProduct(client, companyId, "WMS", "ACTIVE")
    await setProduct(client, companyId, "FF", "INACTIVE")
  })
  await new Promise((resolve) => setTimeout(resolve, 5500))

  summarizePass("API product entitlement guards")
}

run().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
