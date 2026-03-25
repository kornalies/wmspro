import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

const script = process.argv[2]
const extraArgs = process.argv.slice(3)

if (!script) {
  console.error("Usage: node scripts/db/run-with-env.mjs <script-path> [...args]")
  process.exit(1)
}

const envFile = path.resolve(process.cwd(), ".env.local")
const nodeArgs = fs.existsSync(envFile)
  ? ["--env-file=.env.local", script, ...extraArgs]
  : [script, ...extraArgs]

const child = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: process.env,
})

if (child.error) {
  console.error(child.error.message)
  process.exit(1)
}

process.exit(child.status ?? 1)
