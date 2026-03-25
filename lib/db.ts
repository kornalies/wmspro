import { Pool } from "pg"
import { cookies } from "next/headers"
import { headers } from "next/headers"

import { verifyTokenWithoutSession } from "@/lib/auth"
import { resolvePgSsl } from "@/lib/pg-ssl"

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePgSsl(),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

let dbRoleSafetyVerified = false

export async function query(text: string, params?: unknown[]) {
  const start = Date.now()
  const client = await pool.connect()
  try {
    await ensureSafeDbRole(client)
    await client.query("BEGIN")
    const headerStore = await headers()
    const requestId =
      headerStore.get("x-request-id") ||
      headerStore.get("x-correlation-id") ||
      crypto.randomUUID()
    await applyTenantContextFromRequest(client)
    const res = await client.query(text, params)
    await client.query("COMMIT")
    const duration = Date.now() - start
    console.log("Executed query", { requestId, duration, rows: res.rowCount })
    return res
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Ignore rollback errors and surface the original query error.
    }
    console.error("Database query error:", error)
    throw error
  } finally {
    client.release()
  }
}

export async function getClient() {
  const client = await pool.connect()
  await ensureSafeDbRole(client)
  return client
}

type TenantAwareClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

export async function setTenantContext(client: TenantAwareClient, companyId?: number | null) {
  const value = companyId ? String(companyId) : ""
  await client.query("SELECT set_config('app.company_id', $1, true)", [value])
}

async function applyTenantContextFromRequest(client: TenantAwareClient) {
  try {
    const headerStore = await headers()
    const authHeader = headerStore.get("authorization")
    const bearerToken = authHeader?.toLowerCase().startsWith("bearer ")
      ? authHeader.split(" ")[1]
      : null

    if (bearerToken) {
      const payload = await verifyTokenWithoutSession(bearerToken)
      await setTenantContext(client, payload?.companyId ?? null)
      return
    }

    const cookieStore = await cookies()
    const token = cookieStore.get("token")?.value
    if (!token) {
      await setTenantContext(client, null)
      return
    }

    const payload = await verifyTokenWithoutSession(token)
    await setTenantContext(client, payload?.companyId ?? null)
  } catch {
    await setTenantContext(client, null)
  }
}

async function ensureSafeDbRole(client: TenantAwareClient) {
  if (dbRoleSafetyVerified) return

  const result = await client.query(
    "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
  ) as { rows?: Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }> }

  const row = result?.rows?.[0]
  if (!row) {
    throw new Error("Unable to verify database role security posture")
  }

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `Insecure DB role '${row.current_user}' detected. App connections must not use SUPERUSER or BYPASSRLS roles in multi-tenant mode.`
    )
  }

  dbRoleSafetyVerified = true
}

export default pool
