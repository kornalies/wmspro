// Covers the system cron entry point: POST /api/finance/jobs/scheduled-run.
//
// The interesting assertions here are the negative ones. This is the only route
// in the app that is reachable without a session, so "the secret actually gates
// it" and "an unset secret fails closed" matter more than the happy path -- a
// bug in either direction is a way to trigger tenant-wide billing anonymously.
//
// Requires a running app. BILLING_CRON_SECRET must match the server's.
import pg from "pg"
import process from "node:process"

const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"
const SECRET = process.env.BILLING_CRON_SECRET
// Today, deliberately -- exactly what the nightly cron sends.
//
// Do NOT put a far-future date here to keep the fixtures "out of the way". The
// cycle run is catch-up capable: a run_date in 2099 enumerates every closed
// period up to it, raises real invoices over whatever unbilled charges exist,
// and the storage snapshot writes a snapshot (and UNRATED storage charges) for
// that date. An earlier version of this file used 2099-12-31 and filled the dev
// invoice register with invoices dated 2099. Clean up with
// `npm run db:clean-test-data:apply` if that ever happens again.
const RUN_DATE = new Date().toISOString().slice(0, 10)

let failures = 0

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`)
}

function check(condition, label, detail) {
  if (condition) return pass(label, detail)
  failures += 1
  console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`)
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE_URL}/finance/jobs/scheduled-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

if (!SECRET) {
  console.error("BILLING_CRON_SECRET is not set; cannot exercise the authorised path.")
  console.error("Set it in .env.local (and restart the app) to run this suite.")
  process.exit(1)
}

const auth = { "x-cron-secret": SECRET }

console.log("== Authorisation ==")

const noSecret = await post({})
check(noSecret.status === 401, "request without the secret is rejected", `status=${noSecret.status}`)

const wrongSecret = await post({}, { "x-cron-secret": "not-the-secret" })
check(wrongSecret.status === 401, "wrong secret is rejected", `status=${wrongSecret.status}`)

// A secret of a different length takes the early-return branch rather than
// timingSafeEqual, so it is worth asserting separately.
const shortSecret = await post({}, { "x-cron-secret": "x" })
check(shortSecret.status === 401, "short secret is rejected", `status=${shortSecret.status}`)

console.log("\n== Input validation ==")

const badDate = await post({ run_date: "05-08-2026" }, auth)
check(badDate.status === 400, "malformed run_date rejected", `status=${badDate.status}`)

const badJob = await post({ jobs: ["drop-tables"] }, auth)
check(badJob.status === 400, "unknown job name rejected", `status=${badJob.status}`)

console.log("\n== Fan-out ==")

const run = await post({ run_date: RUN_DATE }, auth)
check(run.status === 200, "authorised run succeeds", `status=${run.status}`)

const data = run.json?.data
check((data?.company_count ?? 0) > 0, "run covers at least one tenant", `companies=${data?.company_count}`)
check(data?.failed_count === 0, "no tenant failed", `failed=${data?.failed_count}`)

// Order is load-bearing: storage charges must be snapshotted into
// billing_transactions before the cycle run sweeps them onto an invoice.
check(
  JSON.stringify(data?.jobs) === JSON.stringify(["storage-snapshot", "invoice-cycle-run"]),
  "storage snapshot runs before the invoice cycle",
  JSON.stringify(data?.jobs)
)

const perTenant = data?.results || []
const tenants = new Set(perTenant.map((r) => r.company_id))
check(
  perTenant.length === tenants.size * 2,
  "every tenant ran both jobs",
  `results=${perTenant.length} tenants=${tenants.size}`
)

console.log("\n== Sharding ==")

// The property that matters is not "sharding runs" but "sharding does not lose
// or duplicate a client". Asserting the union of the shards equals the unsharded
// population is the only check that catches an off-by-one in the modulo.
const unsharded = await post({ run_date: RUN_DATE, jobs: ["invoice-cycle-run"] }, auth)
const wholeProfiles = (unsharded.json?.data?.results ?? []).reduce(
  (sum, r) => sum + Number(r.detail?.profileCount ?? 0),
  0
)

const shardCount = 3
let shardedProfiles = 0
const shardedClients = new Set()
for (let index = 0; index < shardCount; index++) {
  const res = await post(
    { run_date: RUN_DATE, jobs: ["invoice-cycle-run"], shard: { index, count: shardCount } },
    auth
  )
  if (res.status !== 200) {
    check(false, `shard ${index} runs`, `status=${res.status} ${JSON.stringify(res.json)}`)
    continue
  }
  for (const row of res.json?.data?.results ?? []) {
    shardedProfiles += Number(row.detail?.profileCount ?? 0)
    for (const skipped of row.detail?.skipped ?? []) {
      shardedClients.add(`${row.company_id}:${skipped.clientId}`)
    }
  }
}

check(
  shardedProfiles === wholeProfiles,
  "the shards together cover every client exactly once",
  `sharded=${shardedProfiles} whole=${wholeProfiles}`
)
check(
  shardedClients.size === shardedProfiles,
  "no client is counted in two shards",
  `distinct=${shardedClients.size} counted=${shardedProfiles}`
)

const badShard = await post({ shard: { index: 3, count: 3 } }, auth)
check(badShard.status === 400, "a shard index outside its count is rejected", `status=${badShard.status}`)

// Shard 0 owns the storage snapshot; the others must not repeat it.
const shardZero = await post({ run_date: RUN_DATE, shard: { index: 0, count: 2 } }, auth)
const shardOne = await post({ run_date: RUN_DATE, shard: { index: 1, count: 2 } }, auth)
check(
  (shardZero.json?.data?.jobs ?? []).includes("storage-snapshot") &&
    !(shardOne.json?.data?.jobs ?? []).includes("storage-snapshot"),
  "only shard 0 takes the storage snapshot",
  `s0=${JSON.stringify(shardZero.json?.data?.jobs)} s1=${JSON.stringify(shardOne.json?.data?.jobs)}`
)

console.log("\n== Audit trail ==")

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const companyId = perTenant[0]?.company_id
  await client.query("BEGIN")
  await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])
  const rows = await client.query(
    `SELECT job_type, status, finished_at IS NOT NULL AS finished, details->>'trigger' AS trigger
       FROM billing_job_runs
      WHERE company_id = $1 AND run_key LIKE $2
      ORDER BY job_type`,
    [companyId, `CRON-%-${RUN_DATE}`]
  )
  await client.query("COMMIT")

  check(rows.rows.length === 2, "both jobs recorded a run", `rows=${rows.rows.length}`)
  check(
    rows.rows.every((r) => r.status === "SUCCESS" && r.finished),
    "recorded runs are SUCCESS and finished",
    rows.rows.map((r) => `${r.job_type}=${r.status}`).join(", ")
  )
  check(
    rows.rows.every((r) => r.trigger === "cron"),
    "runs are attributed to the cron trigger",
    rows.rows.map((r) => r.trigger).join(", ")
  )

  // Re-running the same key must neither duplicate the audit row nor raise a
  // second invoice: the whole point of the schedule is that a retry is safe.
  const rerun = await post({ run_date: RUN_DATE }, auth)
  check(rerun.status === 200, "re-run succeeds", `status=${rerun.status}`)

  await client.query("BEGIN")
  await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])
  const after = await client.query(
    `SELECT COUNT(*)::int AS n FROM billing_job_runs WHERE company_id = $1 AND run_key LIKE $2`,
    [companyId, `CRON-%-${RUN_DATE}`]
  )
  await client.query("COMMIT")
  check(after.rows[0].n === 2, "re-run did not duplicate the audit rows", `rows=${after.rows[0].n}`)
} finally {
  await client.end()
}

console.log("")
if (failures) {
  console.error(`Billing cron: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log("Billing cron: all checks passed.")
