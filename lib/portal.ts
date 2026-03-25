import { TokenPayload } from "@/lib/auth"
import { query } from "@/lib/db"

let portalBootstrapAttempted = false

function isInsufficientPrivilege(error: unknown) {
  if (!(error instanceof Error)) return false
  return /permission denied|insufficient privilege/i.test(error.message)
}

export async function ensurePortalTables() {
  if (portalBootstrapAttempted) return
  portalBootstrapAttempted = true
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS portal_user_clients (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        client_id INTEGER NOT NULL REFERENCES clients(id),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (company_id, user_id, client_id)
      )
    `)

    await query(`
      CREATE TABLE IF NOT EXISTS client_portal_asn_requests (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        client_id INTEGER NOT NULL REFERENCES clients(id),
        request_number VARCHAR(80) NOT NULL,
        expected_date DATE,
        remarks TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
        requested_by INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (company_id, request_number)
      )
    `)

    await query(
      "CREATE INDEX IF NOT EXISTS idx_portal_user_clients_lookup ON portal_user_clients(company_id, user_id, client_id, is_active)"
    )
    await query(
      "CREATE INDEX IF NOT EXISTS idx_client_portal_asn_company_client ON client_portal_asn_requests(company_id, client_id, created_at DESC)"
    )
    await query(`
      CREATE TABLE IF NOT EXISTS portal_user_permissions (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        feature_key VARCHAR(80) NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (company_id, user_id, feature_key)
      )
    `)
    await query(
      "CREATE INDEX IF NOT EXISTS idx_portal_user_permissions_lookup ON portal_user_permissions(company_id, user_id, feature_key, is_allowed)"
    )
    await query(`
      CREATE TABLE IF NOT EXISTS portal_user_invites (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        invite_token VARCHAR(120) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        expires_at TIMESTAMP NOT NULL,
        accepted_at TIMESTAMP NULL,
        invited_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (company_id, invite_token)
      )
    `)
    await query(
      "CREATE INDEX IF NOT EXISTS idx_portal_user_invites_lookup ON portal_user_invites(company_id, user_id, status, expires_at DESC)"
    )
  } catch (error) {
    if (!isInsufficientPrivilege(error)) {
      throw error
    }
  }
}

export async function resolvePermittedClientIds(session: TokenPayload): Promise<number[]> {
  await ensurePortalTables()
  const mapped = await query(
    `SELECT client_id
     FROM portal_user_clients
     WHERE user_id = $1 AND is_active = true
     ORDER BY client_id`,
    [session.userId]
  )
  return mapped.rows
    .map((r: { client_id: number }) => Number(r.client_id))
    .filter((v: number) => Number.isFinite(v))
}

export async function canAccessClient(session: TokenPayload, clientId: number): Promise<boolean> {
  const ids = await resolvePermittedClientIds(session)
  return ids.includes(clientId)
}

export async function resolvePortalFeaturePermissions(session: TokenPayload): Promise<string[]> {
  await ensurePortalTables()
  const result = await query(
    `SELECT feature_key
     FROM portal_user_permissions
     WHERE company_id = $1
       AND user_id = $2
       AND is_allowed = true
     ORDER BY feature_key ASC`,
    [session.companyId, session.userId]
  )
  return result.rows.map((row: { feature_key: string }) => String(row.feature_key))
}

export async function hasExplicitPortalPermissions(session: TokenPayload): Promise<boolean> {
  await ensurePortalTables()
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM portal_user_permissions
     WHERE company_id = $1
       AND user_id = $2`,
    [session.companyId, session.userId]
  )
  return Number(result.rows[0]?.count || 0) > 0
}
