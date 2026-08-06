// Where migrations have to be applied.
//
// Today that is one database: every tenant shares it, separated by company_id
// and RLS. The provisioning scaffolds in db/sql/ describe two futures where it
// is not — a schema per tenant (ADVANCE) and a database per tenant
// (ENTERPRISE) — and in both, "run the migrations" becomes "run the migrations
// N times and tell me which one broke".
//
// This module is the part of that problem worth solving now: resolving the list
// of targets. It is pure and separately tested, because the alternative is
// discovering the parsing rules are wrong while a fan-out is halfway through a
// production estate.
//
// Resolution order, first match wins:
//
//   MIGRATION_TARGETS   explicit list, "name=url" or bare urls, comma or newline
//                       separated. The escape hatch, and what CI uses.
//   MIGRATOR_DATABASE_URL / DATABASE_URL
//                       the single shared database — today's normal case.

/** Hide credentials before a connection string is printed or logged. */
export function redact(url) {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = "***"
    return parsed.toString()
  } catch {
    // Not a parseable URL; never echo it back, since the reason it failed to
    // parse may be that it is a DSN with the password in an odd position.
    return "<unparseable connection string>"
  }
}

/** A stable, human-usable name for a target that did not supply one. */
function deriveName(url, index) {
  try {
    const parsed = new URL(url)
    const database = parsed.pathname.replace(/^\//, "") || "default"
    return `${parsed.host}/${database}`
  } catch {
    return `target-${index + 1}`
  }
}

export function parseTargetList(raw) {
  return String(raw)
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      // "name=postgres://..." — split on the FIRST '=' only, because a
      // connection string is full of them.
      const separator = entry.indexOf("=")
      const looksNamed = separator > 0 && !entry.slice(0, separator).includes(":")
      const name = looksNamed ? entry.slice(0, separator).trim() : ""
      const url = looksNamed ? entry.slice(separator + 1).trim() : entry
      if (!url) throw new Error(`Migration target ${index + 1} has no connection string`)
      return { name: name || deriveName(url, index), url }
    })
}

export function resolveMigrationTargets(env = process.env) {
  const list = env.MIGRATION_TARGETS
  if (list && String(list).trim()) {
    const targets = parseTargetList(list)
    if (!targets.length) throw new Error("MIGRATION_TARGETS is set but empty")
    const names = new Set()
    for (const target of targets) {
      if (names.has(target.name)) {
        // Two targets with one name makes the per-target report ambiguous, and
        // the report is the entire point of fanning out.
        throw new Error(`Duplicate migration target name: ${target.name}`)
      }
      names.add(target.name)
    }
    return targets
  }

  const single = env.MIGRATOR_DATABASE_URL || env.DATABASE_URL
  if (!single || !String(single).trim()) {
    throw new Error("Missing MIGRATOR_DATABASE_URL or DATABASE_URL")
  }
  return [{ name: deriveName(single, 0), url: String(single) }]
}

/**
 * Migrations sharing a numeric prefix.
 *
 * Not an error: the runner keys on the full filename and sorts
 * lexicographically, so 020_a and 020_b both apply in a stable order. It is a
 * footgun though — the next author reads the highest number and picks one that
 * is already taken — so it is surfaced on every run rather than left to be
 * rediscovered.
 */
export function findDuplicateNumbers(filenames) {
  const byNumber = new Map()
  for (const filename of filenames) {
    const number = String(filename).slice(0, 3)
    if (!byNumber.has(number)) byNumber.set(number, [])
    byNumber.get(number).push(filename)
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({ number, files: files.sort() }))
}
