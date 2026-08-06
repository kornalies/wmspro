/**
 * Migration target resolution. Pure — no database, no server.
 *
 * These rules decide where migrations get applied. Getting them wrong in a
 * database-per-tenant estate means either missing a tenant or pointing a
 * migration at the wrong one, and neither announces itself. So they are tested
 * away from the thing they control.
 */

import process from "node:process"
import assert from "node:assert/strict"

import {
  findDuplicateNumbers,
  parseTargetList,
  redact,
  resolveMigrationTargets,
} from "../scripts/db/migration-targets.mjs"

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label} :: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log("== Single database (today) ==")

check("falls back to MIGRATOR_DATABASE_URL", () => {
  const targets = resolveMigrationTargets({
    MIGRATOR_DATABASE_URL: "postgres://u:p@localhost:5432/wms_db",
  })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].url, "postgres://u:p@localhost:5432/wms_db")
})

check("prefers MIGRATOR_DATABASE_URL over DATABASE_URL", () => {
  const targets = resolveMigrationTargets({
    MIGRATOR_DATABASE_URL: "postgres://m@localhost/mig",
    DATABASE_URL: "postgres://a@localhost/app",
  })
  assert.match(targets[0].url, /mig$/)
})

check("names a target after its host and database", () => {
  const targets = resolveMigrationTargets({ DATABASE_URL: "postgres://u@db.internal:5432/tenant_7" })
  assert.equal(targets[0].name, "db.internal:5432/tenant_7")
})

check("no connection string at all is an error", () => {
  assert.throws(() => resolveMigrationTargets({}), /Missing MIGRATOR_DATABASE_URL/)
})

console.log("\n== Fan-out ==")

check("splits a comma-separated list", () => {
  const targets = resolveMigrationTargets({
    MIGRATION_TARGETS: "postgres://u@h/a,postgres://u@h/b",
  })
  assert.equal(targets.length, 2)
})

check("splits a newline-separated list", () => {
  const targets = parseTargetList("postgres://u@h/a\npostgres://u@h/b\n")
  assert.equal(targets.length, 2)
})

check("takes an explicit name", () => {
  const [target] = parseTargetList("acme=postgres://u@h/acme_db")
  assert.equal(target.name, "acme")
  assert.equal(target.url, "postgres://u@h/acme_db")
})

// A connection string is full of '=' and ':'. Splitting naively would mangle it.
check("a bare url containing '=' is not mistaken for a named entry", () => {
  const [target] = parseTargetList("postgres://u:p@h/db?sslmode=require")
  assert.equal(target.url, "postgres://u:p@h/db?sslmode=require")
  assert.equal(target.name, "h/db")
})

check("a named entry keeps query parameters", () => {
  const [target] = parseTargetList("acme=postgres://u:p@h/db?sslmode=require&x=1")
  assert.equal(target.name, "acme")
  assert.equal(target.url, "postgres://u:p@h/db?sslmode=require&x=1")
})

check("duplicate names are refused", () => {
  assert.throws(
    () => resolveMigrationTargets({ MIGRATION_TARGETS: "a=postgres://u@h/1,a=postgres://u@h/2" }),
    /Duplicate migration target name/
  )
})

check("an empty MIGRATION_TARGETS falls through rather than resolving to nothing", () => {
  const targets = resolveMigrationTargets({
    MIGRATION_TARGETS: "   ",
    DATABASE_URL: "postgres://u@h/fallback",
  })
  assert.equal(targets.length, 1)
  assert.match(targets[0].url, /fallback/)
})

console.log("\n== Credentials never reach the log ==")

check("the password is redacted", () => {
  const out = redact("postgres://user:hunter2@host:5432/db")
  assert.ok(!out.includes("hunter2"), out)
  assert.ok(out.includes("host:5432"), out)
})

check("an unparseable string is not echoed back", () => {
  const out = redact("host=localhost password=hunter2")
  assert.ok(!out.includes("hunter2"), out)
})

console.log("\n== Duplicate migration numbers ==")

check("finds a collision", () => {
  const dupes = findDuplicateNumbers(["001_a.sql", "020_b.sql", "020_c.sql", "021_d.sql"])
  assert.equal(dupes.length, 1)
  assert.equal(dupes[0].number, "020")
  assert.deepEqual(dupes[0].files, ["020_b.sql", "020_c.sql"])
})

check("a clean sequence reports nothing", () => {
  assert.deepEqual(findDuplicateNumbers(["001_a.sql", "002_b.sql"]), [])
})

console.log("")
if (failures) {
  console.error(`Migration targets: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log("Migration targets: all checks passed.")
