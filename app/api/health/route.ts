import { NextResponse } from "next/server"

import { getClient, setTenantContext } from "@/lib/db"
import { securityTelemetry } from "@/lib/security-telemetry"

export async function GET() {
  const startedAt = Date.now()
  const client = await getClient().catch(() => null)

  if (!client) {
    return NextResponse.json(
      {
        status: "error",
        service: "wms-frontend",
        error: "DB_UNREACHABLE",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }

  try {
    await client.query("BEGIN")

    const ping = (await client.query("SELECT 1 AS ok")) as { rows?: Array<{ ok: number }> }
    if (!ping.rows?.length || Number(ping.rows[0].ok) !== 1) {
      throw new Error("DB ping failed")
    }

    // Validate tenant context mechanics used by request-scoped queries.
    await setTenantContext(client, 1)
    const tenantCheck = (await client.query(
      "SELECT current_setting('app.company_id', true) AS company_id"
    )) as { rows?: Array<{ company_id: string }> }
    if (!tenantCheck.rows?.length || tenantCheck.rows[0].company_id !== "1") {
      throw new Error("Tenant context check failed")
    }

    await client.query("ROLLBACK")
    return NextResponse.json(
      {
        status: "ok",
        service: "wms-frontend",
        checks: {
          db: "ok",
          tenant_context: "ok",
        },
        securityTelemetry: securityTelemetry.snapshot(),
        securityStatus: securityTelemetry.status(),
        duration_ms: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    )
  } catch {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Ignore rollback errors for health endpoint.
    }

    return NextResponse.json(
      {
        status: "error",
        service: "wms-frontend",
        error: "DB_OR_TENANT_CONTEXT_UNHEALTHY",
        securityTelemetry: securityTelemetry.snapshot(),
        securityStatus: securityTelemetry.status(),
        duration_ms: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  } finally {
    client.release()
  }
}
