import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import pg from "pg"

const { Client } = pg
const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations")
const MIGRATION_NAME_RE = /^\d{3}_.+\.sql$/

function getDatabaseUrl() {
  const value = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL
  if (!value || !String(value).trim()) {
    throw new Error("Missing MIGRATOR_DATABASE_URL or DATABASE_URL")
  }
  return String(value)
}

function normalizeMigrationSql(sql) {
  return sql
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "")
    .trim()
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)
}

async function getMigrationFiles() {
  let files
  try {
    files = await fs.readdir(MIGRATIONS_DIR)
  } catch {
    throw new Error("Migration directory missing: db/migrations")
  }

  const sqlFiles = files.filter((f) => f.endsWith(".sql"))
  if (sqlFiles.length === 0) {
    throw new Error("No migration files found in db/migrations")
  }

  const invalid = sqlFiles.filter((f) => !MIGRATION_NAME_RE.test(f))
  if (invalid.length > 0) {
    throw new Error(
      `Invalid migration filename(s): ${invalid.join(
        ", "
      )}. Expected pattern: 001_name.sql, 002_name.sql`
    )
  }

  return sqlFiles.sort((a, b) => a.localeCompare(b))
}

async function isApplied(client, filename) {
  const res = await client.query(
    "SELECT 1 FROM public.schema_migrations WHERE filename = $1 LIMIT 1",
    [filename]
  )
  return res.rows.length > 0
}

async function applyMigration(client, filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename)
  const rawSql = await fs.readFile(fullPath, "utf8")
  const sql = normalizeMigrationSql(rawSql)

  if (!sql) {
    console.log(`Skipping empty migration: ${filename}`)
    return
  }

  console.log(`Applying ${filename}`)
  await client.query("BEGIN")
  try {
    await client.query(sql)
    await client.query(
      "INSERT INTO public.schema_migrations (filename) VALUES ($1)",
      [filename]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

async function main() {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    await ensureMigrationsTable(client)
    const files = await getMigrationFiles()
    for (const filename of files) {
      if (await isApplied(client, filename)) {
        console.log(`Already applied ${filename}`)
        continue
      }
      await applyMigration(client, filename)
    }
    console.log("Migrations completed.")
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
