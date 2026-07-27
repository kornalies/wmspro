/**
 * Track E acceptance: bin generation from rack geometry.
 *
 * The geometry arithmetic is checked directly rather than only through HTTP,
 * because the failure modes are silent: an off-by-one range creates one rack too
 * few, mixed padding breaks code sorting, and a level/bin prefix collision is
 * absorbed by ON CONFLICT DO NOTHING and reported as "already existed".
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import { BASE_URL, ensureChaosFixtures, withDb } from "./chaos/_shared.mjs"
import {
  MAX_GENERATED_BINS,
  countGeneratedBins,
  generateBins,
} from "../lib/location-generator.ts"

const SUFFIX = Date.now().toString().slice(-9)
const ZONE = `GEN${SUFFIX.slice(-6)}`

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

function expectThrow(label, fn, codeMatch) {
  try {
    fn()
    check(label, false, "no error thrown")
  } catch (error) {
    check(label, codeMatch.test(error.code || error.message), `${error.code}: ${error.message}`)
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => null)
  return { res, json }
}

function must(label, result) {
  if (!result.res.ok) {
    throw new Error(`${label} failed: ${result.res.status} ${JSON.stringify(result.json)}`)
  }
  return result.json?.data ?? result.json
}

async function login(fixtures) {
  const res = await fetch(`${BASE_URL}/mobile/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_code: fixtures.tenantA.code,
      username: fixtures.tenantA.username,
      password: fixtures.tenantA.password,
    }),
  })
  const json = await res.json()
  if (!json?.data?.access_token) throw new Error(`login failed: ${JSON.stringify(json)}`)
  return json.data.access_token
}

function runGeometryChecks() {
  // 3 racks x 2 levels x 4 bins = 24
  const spec = {
    zoneCode: "Z",
    racks: { prefix: "R", from: 1, to: 3, pad: 2 },
    levels: { prefix: "L", from: 1, to: 2, pad: 0 },
    bins: { prefix: "B", from: 1, to: 4, pad: 2 },
  }
  check("count matches racks x levels x bins", countGeneratedBins(spec) === 24, String(countGeneratedBins(spec)))

  const bins = generateBins(spec)
  check("generates every bin", bins.length === 24, String(bins.length))
  check("pads rack codes", bins[0].rackCode === "R01", bins[0].rackCode)
  check("composes level and bin into the bin code", bins[0].binCode === "L1B01", bins[0].binCode)
  check("walks rack, then level, then bin", bins[4].binCode === "L2B01", bins[4].binCode)
  check("sort order is contiguous across the whole zone", bins.every((b, i) => b.sortOrder === i))
  check("last bin is the final rack/level/bin", bins[23].rackCode === "R03" && bins[23].binCode === "L2B04", `${bins[23].rackCode}/${bins[23].binCode}`)

  // Flat rack: no levels
  const flat = generateBins({
    zoneCode: "Z",
    racks: { prefix: "R", from: 1, to: 2, pad: 0 },
    bins: { prefix: "B", from: 1, to: 3, pad: 0 },
  })
  check("flat geometry omits the level segment", flat.length === 6 && flat[0].binCode === "B1", flat[0].binCode)

  // Inclusive ranges: from == to is one unit, not zero
  const single = generateBins({
    zoneCode: "Z",
    racks: { prefix: "R", from: 5, to: 5, pad: 0 },
    bins: { prefix: "B", from: 7, to: 7, pad: 0 },
  })
  check("ranges are inclusive at both ends", single.length === 1 && single[0].binCode === "B7", single[0]?.binCode)

  expectThrow(
    "inverted range rejected",
    () => generateBins({ zoneCode: "Z", racks: { prefix: "R", from: 5, to: 2 }, bins: { prefix: "B", from: 1, to: 2 } }),
    /VALIDATION_ERROR|inverted/
  )

  expectThrow(
    "padding too narrow for the range rejected",
    () => generateBins({ zoneCode: "Z", racks: { prefix: "R", from: 1, to: 100, pad: 2 }, bins: { prefix: "B", from: 1, to: 1 } }),
    /VALIDATION_ERROR|narrow/
  )

  // Unpadded and unseparated, level 1 + bin 11 and level 11 + bin 1 both render
  // as "111". Both sides of the collision have to be in range for it to exist,
  // hence levels running to 11 rather than 10.
  expectThrow(
    "colliding level/bin codes rejected rather than silently deduped",
    () =>
      generateBins({
        zoneCode: "Z",
        racks: { prefix: "", from: 1, to: 1, pad: 0 },
        levels: { prefix: "", from: 1, to: 11, pad: 0 },
        bins: { prefix: "", from: 1, to: 11, pad: 0 },
      }),
    /DUPLICATE_CODE|more than once/
  )

  // The same geometry is legal once a separator disambiguates it, which is the
  // fix the error message points the user at.
  const separated = generateBins({
    zoneCode: "Z",
    racks: { prefix: "", from: 1, to: 1, pad: 0 },
    levels: { prefix: "", from: 1, to: 11, pad: 0 },
    bins: { prefix: "", from: 1, to: 11, pad: 0 },
    binSeparator: "-",
  })
  check("a separator resolves the collision", separated.length === 121, String(separated.length))

  expectThrow(
    "generation above the ceiling rejected",
    () =>
      generateBins({
        zoneCode: "Z",
        racks: { prefix: "R", from: 1, to: 100, pad: 3 },
        levels: { prefix: "L", from: 1, to: 10, pad: 2 },
        bins: { prefix: "B", from: 1, to: 10, pad: 2 },
      }),
    /TOO_MANY_BINS/
  )
  check("ceiling is documented", MAX_GENERATED_BINS === 5000, String(MAX_GENERATED_BINS))
}

async function main() {
  runGeometryChecks()

  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures)
  const warehouseId = fixtures.ids.a.warehouseId

  const body = {
    warehouse_id: warehouseId,
    zone_code: ZONE,
    zone_name: "Generated Zone",
    zone_type: "STORAGE",
    racks: { prefix: "R", from: 1, to: 3, pad: 2 },
    levels: { prefix: "L", from: 1, to: 2, pad: 0 },
    bins: { prefix: "B", from: 1, to: 4, pad: 2 },
    capacity_units: 50,
  }

  // ---- dry run writes nothing ---------------------------------------------
  const preview = must("dry run", await api("/zone-layouts/generate", { method: "POST", token, body: { ...body, dry_run: true } }))
  check("dry run reports the total", preview.total === 24, String(preview.total))
  check("dry run previews codes", preview.preview?.[0]?.bin_code === "L1B01", preview.preview?.[0]?.bin_code)
  check("dry run summarises the geometry", /3 rack/.test(preview.summary || ""), preview.summary)

  const afterPreview = await countBins(fixtures.tenantA.companyId, ZONE)
  check("dry run wrote nothing", afterPreview === 0, `bins=${afterPreview}`)

  // ---- generate ------------------------------------------------------------
  const created = must("generate", await api("/zone-layouts/generate", { method: "POST", token, body }))
  check("all bins created", created.created === 24, `created=${created.created} skipped=${created.skipped}`)

  const stored = await readBins(fixtures.tenantA.companyId, ZONE)
  check("bins persisted", stored.length === 24, String(stored.length))
  check("racks distinct", new Set(stored.map((b) => b.rack_code)).size === 3)
  check("capacity carried through", stored.every((b) => Number(b.capacity_units) === 50))
  check(
    "sort order reproduces the walk route",
    stored[0].bin_code === "L1B01" && stored[stored.length - 1].bin_code === "L2B04",
    `${stored[0].bin_code}..${stored[stored.length - 1].bin_code}`
  )

  // ---- re-running is idempotent -------------------------------------------
  const again = must("re-generate", await api("/zone-layouts/generate", { method: "POST", token, body }))
  check("re-run creates nothing and reports skips", again.created === 0 && again.skipped === 24, `created=${again.created} skipped=${again.skipped}`)
  const afterRerun = await countBins(fixtures.tenantA.companyId, ZONE)
  check("re-run did not duplicate bins", afterRerun === 24, `bins=${afterRerun}`)

  // ---- rejections ----------------------------------------------------------
  const inverted = await api("/zone-layouts/generate", {
    method: "POST",
    token,
    body: { ...body, zone_code: `${ZONE}X`, racks: { prefix: "R", from: 9, to: 2, pad: 2 } },
  })
  check("inverted range rejected over HTTP", inverted.res.status === 400, `status=${inverted.res.status}`)

  const huge = await api("/zone-layouts/generate", {
    method: "POST",
    token,
    body: {
      ...body,
      zone_code: `${ZONE}Y`,
      racks: { prefix: "R", from: 1, to: 100, pad: 3 },
      levels: { prefix: "L", from: 1, to: 10, pad: 2 },
      bins: { prefix: "B", from: 1, to: 10, pad: 2 },
    },
  })
  check("oversized generation rejected with 409", huge.res.status === 409, `status=${huge.res.status}`)

  const anon = await fetch(`${BASE_URL}/zone-layouts/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  check("unauthenticated generation rejected", anon.status === 401, `status=${anon.status}`)

  console.log("")
  if (failures > 0) {
    console.log(`Location generator: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log("Location generator: all checks passed.")
}

async function readBins(companyId, zoneCode) {
  return withDb(async (db) => {
    // Session-scoped (is_local = false): withDb hands out a dedicated client and
    // a transaction-local setting would be discarded before the next statement.
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
    const r = await db.query(
      `SELECT rack_code, bin_code, capacity_units, sort_order
       FROM warehouse_zone_layouts
       WHERE company_id = $1 AND zone_code = $2
       ORDER BY sort_order ASC`,
      [companyId, zoneCode]
    )
    return r.rows
  })
}

async function countBins(companyId, zoneCode) {
  return (await readBins(companyId, zoneCode)).length
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})