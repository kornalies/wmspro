import { ensureChaosFixtures, fail, summarizePass, withDb } from "./chaos/_shared.mjs"

async function assertVisibleOnly(client, companyId, tableName, visibleMarker, hiddenMarker, insertSql, selectSql) {
  await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])
  await client.query(insertSql)
  const result = await client.query(selectSql)
  const payload = JSON.stringify(result.rows)
  if (!payload.includes(visibleMarker)) {
    fail(`${tableName}: expected visible marker ${visibleMarker}`)
  }
  if (payload.includes(hiddenMarker)) {
    fail(`${tableName}: leaked hidden marker ${hiddenMarker}`)
  }
}

async function run() {
  const fixtures = await ensureChaosFixtures()
  const companyA = fixtures.tenantA.companyId
  const companyB = fixtures.tenantB.companyId

  await withDb(async (client) => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyA)])
      await client.query(
        `INSERT INTO tenant_products (company_id, product_code, plan_code, status)
         VALUES ($1, 'FF', 'ISOLATION_A', 'ACTIVE')
         ON CONFLICT (company_id, product_code)
         DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status, updated_at = NOW()`,
        [companyA]
      )
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyB)])
      await client.query(
        `INSERT INTO tenant_products (company_id, product_code, plan_code, status)
         VALUES ($1, 'FF', 'ISOLATION_B', 'ACTIVE')
         ON CONFLICT (company_id, product_code)
         DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status, updated_at = NOW()`,
        [companyB]
      )
      await assertVisibleOnly(
        client,
        companyA,
        "tenant_products",
        "ISOLATION_A",
        "ISOLATION_B",
        "SELECT 1",
        "SELECT product_code, plan_code FROM tenant_products ORDER BY product_code"
      )

      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyA)])
      const shipmentA = await client.query(
        `INSERT INTO ff_shipments (company_id, shipment_no, mode, direction, status, origin, destination)
         VALUES ($1, 'FF-ISO-A', 'ROAD', 'DOMESTIC', 'DRAFT', 'A_ORIGIN', 'A_DEST')
         ON CONFLICT (company_id, shipment_no) DO UPDATE SET origin = EXCLUDED.origin
         RETURNING id`,
        [companyA]
      )
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyB)])
      await client.query(
        `INSERT INTO ff_shipments (company_id, shipment_no, mode, direction, status, origin, destination)
         VALUES ($1, 'FF-ISO-B', 'ROAD', 'DOMESTIC', 'DRAFT', 'B_ORIGIN', 'B_DEST')
         ON CONFLICT (company_id, shipment_no) DO UPDATE SET origin = EXCLUDED.origin`,
        [companyB]
      )

      await assertVisibleOnly(
        client,
        companyA,
        "ff_shipments",
        "FF-ISO-A",
        "FF-ISO-B",
        "SELECT 1",
        "SELECT shipment_no, origin FROM ff_shipments ORDER BY shipment_no"
      )

      const shipmentAId = Number(shipmentA.rows[0].id)
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyA)])
      await client.query(
        `INSERT INTO ff_shipment_legs (company_id, shipment_id, leg_no, transport_mode, from_location, to_location)
         VALUES ($1, $2, 1, 'ROAD', 'LEG_A_FROM', 'LEG_A_TO')
         ON CONFLICT (company_id, shipment_id, leg_no) DO UPDATE SET from_location = EXCLUDED.from_location`,
        [companyA, shipmentAId]
      )
      await client.query(
        `INSERT INTO ff_milestones (company_id, shipment_id, code, status)
         VALUES ($1, $2, 'MILESTONE_A', 'PENDING')`,
        [companyA, shipmentAId]
      )
      await client.query(
        `INSERT INTO ff_documents (company_id, shipment_id, doc_type, doc_no)
         VALUES ($1, $2, 'OTHER', 'DOC_A')
         ON CONFLICT (company_id, shipment_id, doc_type, doc_no) DO NOTHING`,
        [companyA, shipmentAId]
      )

      const childChecks = [
        ["ff_shipment_legs", "LEG_A_FROM", "SELECT from_location FROM ff_shipment_legs"],
        ["ff_milestones", "MILESTONE_A", "SELECT code FROM ff_milestones"],
        ["ff_documents", "DOC_A", "SELECT doc_no FROM ff_documents"],
      ]
      for (const [tableName, marker, sql] of childChecks) {
        const rows = await client.query(sql)
        if (!JSON.stringify(rows.rows).includes(marker)) fail(`${tableName}: expected marker ${marker}`)
      }

      await client.query("ROLLBACK")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })

  summarizePass("product and freight tenant isolation")
}

run().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
