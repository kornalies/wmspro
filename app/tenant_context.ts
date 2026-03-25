type PlanCode = "BASIC" | "ADVANCE" | "ENTERPRISE"

type TenantContext = {
  companyId: number
  planCode: PlanCode
  tenantSchema?: string | null
  databaseUrl?: string | null
}

const SCHEMA_RE = /^tenant_[a-z0-9_]{3,48}$/

type TenantContextClient = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
  release: () => void
}

type TenantContextPool = {
  connect: () => Promise<TenantContextClient>
}

export function assertValidCompanyId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid company id: ${value}`)
  }
  return value
}

export function assertValidTenantSchema(value: string): string {
  if (!SCHEMA_RE.test(value)) {
    throw new Error(`Invalid tenant schema: ${value}`)
  }
  return value
}

export async function assertSafeRuntimeRole(client: TenantContextClient): Promise<void> {
  const res = await client.query<{
    rolsuper: boolean
    rolbypassrls: boolean
    role_name: string
  }>(
    `
    SELECT rolsuper, rolbypassrls, current_user AS role_name
    FROM pg_roles
    WHERE rolname = current_user
    `
  )

  const row = res.rows[0]
  if (!row) throw new Error("Unable to verify runtime role")
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `Unsafe runtime role '${row.role_name}'. Expected NOSUPERUSER and NOBYPASSRLS.`
    )
  }
}

async function applyBasicContext(client: TenantContextClient, companyId: number): Promise<void> {
  assertValidCompanyId(companyId)
  await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])
}

async function applyAdvanceContext(
  client: TenantContextClient,
  companyId: number,
  tenantSchema?: string | null
): Promise<void> {
  assertValidCompanyId(companyId)

  let schema = tenantSchema ?? null
  if (!schema) {
    const result = await client.query<{ schema_name: string }>(
      `
      SELECT schema_name
      FROM public.tenant_registry
      WHERE company_id = $1
        AND plan_code = 'ADVANCE'
        AND status = 'ACTIVE'
      LIMIT 1
      `,
      [companyId]
    )

    schema = result.rows[0]?.schema_name ?? null
    if (!schema) {
      throw new Error(`No active ADVANCE schema registered for company ${companyId}`)
    }
  }

  schema = assertValidTenantSchema(schema)
  await client.query(`SET LOCAL search_path = ${quoteIdent(schema)}, public`)
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

export async function withTenantTransaction<T>(
  pool: TenantContextPool,
  context: TenantContext,
  fn: (client: TenantContextClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await assertSafeRuntimeRole(client)

    if (context.planCode === "BASIC") {
      await applyBasicContext(client, context.companyId)
    }

    if (context.planCode === "ADVANCE") {
      await applyAdvanceContext(client, context.companyId, context.tenantSchema)
    }

    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export function getEnterpriseDatabaseUrl(context: TenantContext): string {
  if (context.planCode !== "ENTERPRISE") {
    throw new Error("Enterprise database URL is only valid for ENTERPRISE plan")
  }

  const url = context.databaseUrl?.trim()
  if (!url) {
    throw new Error(`Missing enterprise database URL for company ${context.companyId}`)
  }

  return url
}


