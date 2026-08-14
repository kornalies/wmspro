// Runs every database-backed suite in one pass and prints a single summary.
//
// Chaining these with `&&` would stop at the first failure and hide the state of
// everything after it, which is exactly the wrong shape for a CI gate: one broken
// suite would mask five more. This runs them all, remembers which failed, and
// exits non-zero at the end.
//
// All of these except `billing-cycle` drive the app over HTTP, so a server must
// already be listening on WMS_API_BASE_URL (CI starts one; locally use the dev
// server on :3000).
import { spawnSync } from "node:child_process"
import process from "node:process"

// Ordered cheapest-first so an obvious breakage reports in seconds, with the
// long chaos suites last.
const SUITES = [
  "test:billing-cycle",
  "test:migration-targets",
  "test:billing-cron",
  "test:portal",
  "test:locations",
  "test:allocation",
  "test:lots",
  "test:stock-docs",
  "test:cycle-count",
  "test:documents",
  "test:outbound-tail",
  "test:finance-hardening",
  "test:chaos",
]

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const results = []

for (const suite of SUITES) {
  console.log(`\n===== ${suite} =====`)
  const started = Date.now()
  const child = spawnSync(npm, ["run", suite], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  })
  results.push({
    suite,
    ok: child.status === 0,
    seconds: Math.round((Date.now() - started) / 1000),
  })
}

console.log("\n===== SUMMARY =====")
for (const { suite, ok, seconds } of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${suite} (${seconds}s)`)
}

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\n${failed.length} suite(s) failed: ${failed.map((r) => r.suite).join(", ")}`)
  process.exit(1)
}
console.log(`\nAll ${results.length} suites passed.`)
