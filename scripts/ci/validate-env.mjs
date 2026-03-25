const required = [
  "DATABASE_URL",
  "WMS_COMPANY_CODE",
  "WMS_USERNAME",
  "WMS_PASSWORD",
]

const isCi = process.env.GITHUB_ACTIONS === "true"

const missing = required.filter((k) => {
  const v = process.env[k]
  return !v || String(v).trim().length === 0
})

if (missing.length) {
  if (isCi) {
    console.error("Missing required environment variables for CI:")
    for (const k of missing) console.error(` - ${k}`)
    process.exit(1)
  }
  console.warn("Local warning: missing CI env vars:")
  for (const k of missing) console.warn(` - ${k}`)
  process.exit(0)
}

console.log("Environment validation passed.")
