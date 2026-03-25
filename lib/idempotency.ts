import { query } from "@/lib/db"

let idempotencyBootstrapAttempted = false

function isInsufficientPrivilege(error: unknown) {
  if (!(error instanceof Error)) return false
  return /permission denied|insufficient privilege|must be owner of (table|relation|function|schema)/i.test(error.message)
}

export async function ensureIdempotencyTable() {
  if (idempotencyBootstrapAttempted) return
  idempotencyBootstrapAttempted = true
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS api_idempotency_keys (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        key_hash VARCHAR(120) NOT NULL,
        route_key VARCHAR(160) NOT NULL,
        response_body JSONB NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 200,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (company_id, key_hash, route_key)
      )
    `)
  } catch (error) {
    if (!isInsufficientPrivilege(error)) {
      throw error
    }
  }
}

export async function getIdempotentResponse(args: { companyId: number; key: string; routeKey: string }) {
  await ensureIdempotencyTable()
  const existing = await query(
    `SELECT response_body, status_code
     FROM api_idempotency_keys
     WHERE company_id = $1
       AND key_hash = md5($2)
       AND route_key = $3
     LIMIT 1`,
    [args.companyId, args.key, args.routeKey]
  )
  if (!existing.rows.length) return null
  return {
    body: existing.rows[0].response_body,
    statusCode: Number(existing.rows[0].status_code) || 200,
  }
}

export async function saveIdempotentResponse(args: {
  companyId: number
  key: string
  routeKey: string
  responseBody: unknown
  statusCode?: number
}) {
  await ensureIdempotencyTable()
  await query(
    `INSERT INTO api_idempotency_keys (company_id, key_hash, route_key, response_body, status_code)
     VALUES ($1, md5($2), $3, $4::jsonb, $5)
     ON CONFLICT (company_id, key_hash, route_key) DO NOTHING`,
    [args.companyId, args.key, args.routeKey, JSON.stringify(args.responseBody), args.statusCode || 200]
  )
}
