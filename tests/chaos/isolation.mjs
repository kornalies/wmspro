import process from "node:process"
import {
  apiGet,
  assertNoMarkerInRows,
  ensureChaosFixtures,
  login,
  summarizePass,
  withDb,
  fail,
} from "./_shared.mjs"

async function scenario11(fixtures, tokenA) {
  const listChecks = [
    ["/clients", "CLIENT_DEMO_MARKER", "clients"],
    ["/warehouses", "WH DEMO", "warehouses"],
    ["/items", "ITEM_DEMO_MARKER", "items"],
    ["/grn", "GRN-DEM-CHAOS", "grn list"],
    ["/do", "DO-DEM-CHAOS", "do list"],
    ["/gate/in", "GIN-DEM-CHAOS", "gate list"],
    ["/stock/search?serial=SER-DEM-CHAOS", "SER-DEM-CHAOS", "stock search"],
    ["/stock/movements?serial=SER-DEM-CHAOS", "SER-DEM-CHAOS", "stock movements"],
  ]

  for (const [path, marker, label] of listChecks) {
    const res = await apiGet(path, tokenA)
    if (res.status >= 500) {
      fail(`SCENARIO 1.1 ${label}: server error status=${res.status} path=${path}`)
    }
    assertNoMarkerInRows(res.json?.data, marker, `SCENARIO 1.1 ${label}`)
  }

  const detailChecks = [
    [`/grn/${fixtures.ids.b.grnId}`, "grn detail"],
    [`/do/${fixtures.ids.b.doId}`, "do detail"],
    [`/gate/in/${fixtures.ids.b.gateInId}`, "gate detail"],
  ]
  for (const [path, label] of detailChecks) {
    const res = await apiGet(path, tokenA)
    if (![404, 403, 401].includes(res.status)) {
      fail(`SCENARIO 1.1 ${label}: expected 404/403/401, got ${res.status} path=${path}`)
    }
  }

  summarizePass("SCENARIO 1.1")
}

async function scenario12() {
  const res = await apiGet("/clients", null)
  const allow = res.status === 401 || res.status === 403 || Array.isArray(res.json?.data)
  if (!allow) {
    fail(`SCENARIO 1.2: unexpected status=${res.status}`)
  }
  if (Array.isArray(res.json?.data) && res.json.data.length > 0) {
    fail("SCENARIO 1.2: unauthenticated request returned non-empty tenant data")
  }
  summarizePass("SCENARIO 1.2")
}

async function scenario13(fixtures) {
  const tokenA = await login(fixtures.tenantA.code, fixtures.tenantA.username, fixtures.tenantA.password)
  const tokenB = await login(fixtures.tenantB.code, fixtures.tenantB.username, fixtures.tenantB.password)
  const total = 500
  const reqs = Array.from({ length: total }, (_, i) => {
    const isA = i % 2 === 0
    const token = isA ? tokenA : tokenB
    return apiGet("/clients", token, { timeoutMs: 15000 }).then((res) => ({ isA, res, i }))
  })

  const results = await Promise.all(reqs)
  const mismatches = []
  for (const row of results) {
    if (row.res.status !== 200) {
      mismatches.push(`idx=${row.i} status=${row.res.status}`)
      continue
    }
    const body = JSON.stringify(row.res.json?.data || [])
    const hasDefault = body.includes("CLIENT_DEFAULT_MARKER")
    const hasDemo = body.includes("CLIENT_DEMO_MARKER")
    if (row.isA && (hasDemo || !hasDefault)) mismatches.push(`idx=${row.i} tenant=A leak/miss`)
    if (!row.isA && (hasDefault || !hasDemo)) mismatches.push(`idx=${row.i} tenant=B leak/miss`)
  }

  if (mismatches.length) {
    fail(`SCENARIO 1.3: mismatches=${mismatches.length}; sample=${mismatches.slice(0, 10).join("; ")}`)
  }
  summarizePass("SCENARIO 1.3")
}

async function scenario14() {
  await withDb(async (client) => {
    const role = await client.query(
      `SELECT current_user AS role_name, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`
    )
    const r = role.rows[0]
    if (!r || r.rolsuper || r.rolbypassrls) {
      fail(
        `SCENARIO 1.4: unsafe runtime role role=${r?.role_name || "unknown"} rolsuper=${String(
          r?.rolsuper
        )} rolbypassrls=${String(r?.rolbypassrls)}`
      )
    }

    const required = [
      "clients",
      "warehouses",
      "items",
      "grn_header",
      "grn_line_items",
      "do_header",
      "do_line_items",
      "gate_in",
      "gate_out",
      "stock_movements",
      "stock_serial_numbers",
    ]
    const rows = await client.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [required]
    )
    const map = new Map(rows.rows.map((x) => [x.relname, x]))
    for (const name of required) {
      const row = map.get(name)
      if (!row) fail(`SCENARIO 1.4: missing table=${name}`)
      if (!row.relrowsecurity || !row.relforcerowsecurity) {
        fail(
          `SCENARIO 1.4: RLS unsafe table=${name} rls=${String(row.relrowsecurity)} force=${String(
            row.relforcerowsecurity
          )}`
        )
      }
    }

    const unsafeOwners = await client.query(
      `SELECT n.nspname AS schema_name, c.relname AS object_name, r.rolname AS owner_role, r.rolsuper, r.rolbypassrls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public'
         AND c.relkind IN ('v','m')
         AND (r.rolsuper OR r.rolbypassrls)`
    )
    if (unsafeOwners.rows.length) {
      const first = unsafeOwners.rows[0]
      fail(
        `SCENARIO 1.4: unsafe view owner schema=${first.schema_name} object=${first.object_name} owner=${first.owner_role}`
      )
    }
  })
  summarizePass("SCENARIO 1.4")
}

async function main() {
  const started = Date.now()
  const fixtures = await ensureChaosFixtures()
  const tokenA = await login(fixtures.tenantA.code, fixtures.tenantA.username, fixtures.tenantA.password)

  await scenario11(fixtures, tokenA)
  await scenario12()
  await scenario13(fixtures)
  await scenario14()

  console.log(`Isolation suite complete in ${Date.now() - started}ms`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
