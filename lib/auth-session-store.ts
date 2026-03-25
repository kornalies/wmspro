import { Pool } from "pg"
import { resolvePgSsl } from "@/lib/pg-ssl"

type SessionActorType = "web" | "mobile" | "portal" | "system"

type CreateAuthSessionInput = {
  userId: number
  companyId: number
  actorType: SessionActorType
  deviceId?: string
  deviceName?: string
  ipAddress?: string
  userAgent?: string
  expiresAt?: Date
}

const sessionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePgSsl(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

export async function createAuthSession(input: CreateAuthSessionInput): Promise<string> {
  const sessionId = crypto.randomUUID()
  await sessionPool.query(
    `INSERT INTO user_sessions (
       id, user_id, company_id, actor_type, device_id, device_name, ip_address, user_agent, expires_at
     ) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9)`,
    [
      sessionId,
      input.userId,
      input.companyId,
      input.actorType,
      input.deviceId || "",
      input.deviceName || "",
      input.ipAddress || "",
      input.userAgent || "",
      input.expiresAt ?? null,
    ]
  )
  return sessionId
}

export async function isAuthSessionActive(sessionId: string): Promise<boolean> {
  const result = await sessionPool.query(
    `SELECT 1
     FROM user_sessions
     WHERE id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
     LIMIT 1`,
    [sessionId]
  )
  return result.rows.length > 0
}

export async function touchAuthSession(sessionId: string): Promise<void> {
  await sessionPool.query(
    `UPDATE user_sessions
     SET last_seen_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND revoked_at IS NULL
       AND last_seen_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`,
    [sessionId]
  )
}

export async function revokeAuthSession(sessionId: string, reason = "logout"): Promise<void> {
  await sessionPool.query(
    `UPDATE user_sessions
     SET revoked_at = CURRENT_TIMESTAMP,
         revoked_reason = $2
     WHERE id = $1
       AND revoked_at IS NULL`,
    [sessionId, reason]
  )
}

type RevokeAllSessionsInput = {
  userId: number
  exceptSessionId?: string
  actorType?: SessionActorType
}

export async function revokeAllAuthSessionsForUser(
  input: RevokeAllSessionsInput,
  reason = "logout_all"
): Promise<number> {
  const values: Array<string | number> = [input.userId, reason]
  const conditions = ["user_id = $1", "revoked_at IS NULL"]

  if (input.actorType) {
    values.push(input.actorType)
    conditions.push(`actor_type = $${values.length}`)
  }

  if (input.exceptSessionId) {
    values.push(input.exceptSessionId)
    conditions.push(`id <> $${values.length}`)
  }

  const result = await sessionPool.query(
    `UPDATE user_sessions
     SET revoked_at = CURRENT_TIMESTAMP,
         revoked_reason = $2
     WHERE ${conditions.join(" AND ")}`,
    values
  )

  return result.rowCount || 0
}
