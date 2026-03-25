import { query } from "@/lib/db"

type AuditActorType = "web" | "mobile" | "portal" | "system"

type AuditInsert = {
  companyId: number
  actorUserId?: number | null
  actorType?: AuditActorType
  action: string
  entityType?: string | null
  entityId?: string | number | null
  before?: unknown
  after?: unknown
  req?: Request
}

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

function readIp(req?: Request): string | null {
  if (!req) return null
  const xff = req.headers.get("x-forwarded-for")
  if (xff?.trim()) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") || null
}

function readUa(req?: Request): string | null {
  if (!req) return null
  return req.headers.get("user-agent") || null
}

export async function writeAudit(payload: AuditInsert, db?: Queryable) {
  const executor = db?.query
    ? db.query.bind(db)
    : (text: string, params?: unknown[]) => query(text, params)

  await executor(
    `INSERT INTO audit_logs (
      company_id,
      actor_user_id,
      actor_type,
      action,
      entity_type,
      entity_id,
      before,
      after,
      ip,
      user_agent
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::inet,$10)`,
    [
      payload.companyId,
      payload.actorUserId ?? null,
      payload.actorType || "system",
      payload.action,
      payload.entityType ?? null,
      payload.entityId != null ? String(payload.entityId) : null,
      payload.before != null ? JSON.stringify(payload.before) : null,
      payload.after != null ? JSON.stringify(payload.after) : null,
      readIp(payload.req),
      readUa(payload.req),
    ]
  )
}
