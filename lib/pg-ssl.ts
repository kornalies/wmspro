type PgSslConfig = false | { rejectUnauthorized: boolean }

function parseBooleanEnv(value?: string): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return null
}

export function resolvePgSsl(): PgSslConfig {
  const sslMode = process.env.PGSSLMODE?.trim().toLowerCase()

  if (sslMode === "disable") return false
  if (["require", "verify-ca", "verify-full"].includes(sslMode || "")) {
    const rejectUnauthorized = parseBooleanEnv(process.env.DB_SSL_REJECT_UNAUTHORIZED) ?? false
    return { rejectUnauthorized }
  }

  const dbSsl = parseBooleanEnv(process.env.DB_SSL)
  if (dbSsl !== null) {
    if (!dbSsl) return false
    const rejectUnauthorized = parseBooleanEnv(process.env.DB_SSL_REJECT_UNAUTHORIZED) ?? false
    return { rejectUnauthorized }
  }

  return process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
}

