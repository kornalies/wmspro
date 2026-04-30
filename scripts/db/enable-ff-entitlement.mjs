import process from "node:process"
import pg from "pg"

const { Client } = pg

async function main() {
  const databaseUrl = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("Missing MIGRATOR_DATABASE_URL or DATABASE_URL")
  }

  const companyCode = String(process.argv[2] || "DEFAULT").trim().toUpperCase()
  if (!companyCode) {
    throw new Error("Company code is required")
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    const companyRes = await client.query(
      `SELECT id
       FROM companies
       WHERE UPPER(company_code) = $1
       LIMIT 1`,
      [companyCode]
    )
    if (!companyRes.rows.length) {
      throw new Error(`Company not found: ${companyCode}`)
    }

    const companyId = Number(companyRes.rows[0].id)
    await client.query(
      `INSERT INTO tenant_products (company_id, product_code, plan_code, status)
       VALUES ($1, 'FF', 'STANDARD', 'ACTIVE')
       ON CONFLICT (company_id, product_code)
       DO UPDATE SET
         status = 'ACTIVE',
         updated_at = NOW()`,
      [companyId]
    )

    const productsRes = await client.query(
      `SELECT product_code, status
       FROM tenant_products
       WHERE company_id = $1
       ORDER BY product_code ASC`,
      [companyId]
    )

    console.log(
      JSON.stringify(
        {
          company_code: companyCode,
          company_id: companyId,
          products: productsRes.rows,
        },
        null,
        2
      )
    )
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
