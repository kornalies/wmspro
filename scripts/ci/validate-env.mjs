const mode = (process.env.DEPLOY_ENV || (process.env.GITHUB_ACTIONS === "true" ? "ci" : "local")).toLowerCase()
const isCi = process.env.GITHUB_ACTIONS === "true"
const deployModes = new Set(["staging", "production"])

const required = deployModes.has(mode)
  ? [
      "DATABASE_URL",
      "JWT_SECRET",
      "APP_URL",
      "WMS_API_BASE_URL",
      "WMS_COMPANY_CODE",
      "WMS_USERNAME",
      "WMS_PASSWORD",
    ]
  : [
      "DATABASE_URL",
      "WMS_COMPANY_CODE",
      "WMS_USERNAME",
      "WMS_PASSWORD",
    ]

const missing = required.filter((k) => {
  const v = process.env[k]
  return !v || String(v).trim().length === 0
})

if (missing.length) {
  if (isCi || deployModes.has(mode)) {
    console.error(`Missing required environment variables for ${mode}:`)
    for (const k of missing) console.error(` - ${k}`)
    process.exit(1)
  }
  console.warn("Local warning: missing CI env vars:")
  for (const k of missing) console.warn(` - ${k}`)
  process.exit(0)
}

const valueOf = (key) => String(process.env[key] || "").trim()

const suspicious = []
const placeholderPattern = /placeholder|change-this|your-|example|dummy|sample/i
const ciOnlyValues = new Set(["GWU", "DEFAULT", "wms_ci", "wms_ci_password", "wms_build", "wms_build_password"])

for (const key of required) {
  const value = valueOf(key)
  if (placeholderPattern.test(value)) suspicious.push(`${key} looks like a placeholder`)
}

if (deployModes.has(mode)) {
  const databaseUrl = valueOf("DATABASE_URL")
  const jwtSecret = valueOf("JWT_SECRET")
  const appUrl = valueOf("APP_URL")
  const apiUrl = valueOf("WMS_API_BASE_URL")

  if (/localhost|127\.0\.0\.1|wms_test|wms_build/i.test(databaseUrl)) {
    suspicious.push("DATABASE_URL points to a local/test/build database")
  }
  if (jwtSecret.length < 32) {
    suspicious.push("JWT_SECRET must be at least 32 characters for deployment")
  }
  if (!/^https:\/\//i.test(appUrl)) {
    suspicious.push("APP_URL must be an HTTPS URL for staging/production")
  }
  if (!/^https:\/\//i.test(apiUrl)) {
    suspicious.push("WMS_API_BASE_URL must be an HTTPS URL for staging/production")
  }
  for (const key of ["WMS_COMPANY_CODE", "WMS_USERNAME", "WMS_PASSWORD"]) {
    if (ciOnlyValues.has(valueOf(key))) {
      suspicious.push(`${key} is using an ephemeral CI/demo value`)
    }
  }
}

if (suspicious.length) {
  console.error(`Environment validation failed for ${mode}:`)
  for (const item of suspicious) console.error(` - ${item}`)
  process.exit(1)
}

console.log(`Environment validation passed for ${mode}.`)
