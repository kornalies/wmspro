import { spawnSync } from "node:child_process"

const env = {
  ...process.env,
  WMS_COMPANY_CODE: process.env.WMS_COMPANY_CODE || "GWU",
  WMS_USERNAME: process.env.WMS_USERNAME || "wms_ci",
  WMS_PASSWORD: process.env.WMS_PASSWORD || "wms_ci_password",
  WMS_API_BASE_URL: process.env.WMS_API_BASE_URL || "http://localhost:3000/api",
}

const result = spawnSync(process.execPath, ["scripts/db/run-with-env.mjs", "scripts/api-contract-smoke.mjs"], {
  stdio: "inherit",
  env,
})

process.exit(result.status ?? 1)