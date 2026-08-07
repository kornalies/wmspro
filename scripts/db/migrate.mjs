import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import pg from "pg"

import {
  findDuplicateNumbers,
  redact,
  resolveMigrationTargets,
} from "./migration-targets.mjs"

const { Client } = pg
const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations")
const MIGRATION_NAME_RE = /^\d{3}_.+\.sql$/

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

async function migrateTarget(target, files) {
  const client = new Client({ connectionString: target.url })
  await client.connect()
  let applied = 0
  try {
    await ensureMigrationsTable(client)
    for (const filename of files) {
      if (await isApplied(client, filename)) {
        console.log(`  Already applied ${filename}`)
        continue
      }
      await applyMigration(client, filename)
      applied += 1
    }
  } finally {
    await client.end()
  }
  return applied
}

async function main() {
  const targets = resolveMigrationTargets(process.env)
  const files = await getMigrationFiles()

  // Surfaced every run rather than left to be rediscovered by whoever picks the
  // next number. Not fatal -- the runner keys on the full filename, so the
  // existing collisions apply in a stable order and are harmless.
  for (const { number, files: clashing } of findDuplicateNumbers(files)) {
    console.warn(`Warning: migration number ${number} is used by ${clashing.join(" and ")}`)
  }

  const results = []
  for (const target of targets) {
    console.log(`\n== ${target.name} ==`)
    if (targets.length > 1) console.log(`   ${redact(target.url)}`)
    try {
      const applied = await migrateTarget(target, files)
      results.push({ target: target.name, ok: true, applied })
    } catch (error) {
      // One tenant's failure must not hide the state of the rest. With a
      // database per tenant, aborting on the first error would leave an estate
      // in an unknown mix of versions and no report of which are which.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  FAILED: ${message}`)
      results.push({ target: target.name, ok: false, error: message })
    }
  }

  if (targets.length > 1) {
    console.log("\n== Summary ==")
    for (const result of results) {
      console.log(
        result.ok
          ? `  OK      ${result.target} (${result.applied} applied)`
          : `  FAILED  ${result.target}: ${result.error}`
      )
    }
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    throw new Error(`${failed.length} of ${results.length} migration target(s) failed`)
  }
  console.log("\nMigrations completed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
