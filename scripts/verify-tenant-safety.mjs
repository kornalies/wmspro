import process from "node:process"
import pg from "pg"

const { Client } = pg

const REQUIRED_RLS_TABLES = [
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

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL")
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    const roleResult = await client.query(
      `SELECT current_user AS role_name, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`
    )

    const role = roleResult.rows[0]
    if (!role) {
      throw new Error("Unable to inspect current DB role")
    }
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Unsafe runtime role '${role.role_name}' (rolsuper=${role.rolsuper}, rolbypassrls=${role.rolbypassrls})`
      )
    }

    const rlsResult = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname = ANY($1::text[])`,
      [REQUIRED_RLS_TABLES]
    )

    const rowsByTable = new Map(rlsResult.rows.map((row) => [row.table_name, row]))
    const missing = []
    const invalid = []

    for (const tableName of REQUIRED_RLS_TABLES) {
      const row = rowsByTable.get(tableName)
      if (!row) {
        missing.push(tableName)
        continue
      }
      if (!row.rls_enabled || !row.rls_forced) {
        invalid.push(
          `${tableName} (rls_enabled=${String(row.rls_enabled)}, rls_forced=${String(row.rls_forced)})`
        )
      }
    }

    if (missing.length || invalid.length) {
      const parts = []
      if (missing.length) parts.push(`missing tables: ${missing.join(", ")}`)
      if (invalid.length) parts.push(`RLS not enforced: ${invalid.join(", ")}`)
      throw new Error(parts.join(" | "))
    }

    console.log("Tenant safety checks passed")
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
