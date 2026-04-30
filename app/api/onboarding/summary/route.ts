import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

type StepSummary = {
  id: string
  title: string
  eta_mins: number
  status: "pending" | "done" | "blocked" | "review"
  detail: string
  href: string
  phase: "Tenant Setup" | "Master Data" | "Billing" | "Portal" | "Validation" | "Go Live"
  owner: string
  dependency?: string
  evidence?: string
}

type ValidationCheck = {
  id: string
  title: string
  status: "passed" | "warning" | "blocked"
  detail: string
  href?: string
}

function hasOnboardingAccess(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return false
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return true
  if (session.permissions?.includes("master.data.manage")) return true
  if (session.permissions?.includes("admin.companies.manage")) return true
  if (session.permissions?.includes("admin.users.manage")) return true
  return false
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!hasOnboardingAccess(session)) {
      return fail("FORBIDDEN", "Insufficient permissions", 403)
    }

    const [
      companyResult,
      productsResult,
      ownerResult,
      warehousesResult,
      clientsResult,
      itemsResult,
      usersResult,
      contractsResult,
      billingProfilesResult,
      portalMappingsResult,
      stockResult,
      auditResult,
    ] = await Promise.all([
      query(
        `SELECT
           id,
           company_code,
           company_name,
           domain,
           storage_bucket,
           subscription_plan,
           billing_status,
           is_active,
           created_at,
           updated_at
         FROM companies
         WHERE id = $1
         LIMIT 1`,
        [session.companyId]
      ),
      query(
        `SELECT product_code
         FROM tenant_products
         WHERE company_id = $1
           AND status IN ('ACTIVE', 'TRIAL')
         ORDER BY product_code`,
        [session.companyId]
      ),
      query(
        `SELECT full_name, email
         FROM users
         WHERE company_id = $1
           AND role IN ('SUPER_ADMIN', 'ADMIN')
           AND is_active = true
         ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
        [session.companyId]
      ),
      query(`SELECT COUNT(*)::int AS count FROM warehouses WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM clients WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM items WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM users WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM client_contracts WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM client_billing_profile WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM portal_user_clients WHERE is_active = true`),
      query(`SELECT COUNT(*)::int AS count FROM stock_serial_numbers`),
      query(
        `SELECT
           action,
           entity_type,
           entity_id,
           after,
           created_at
         FROM audit_logs
         WHERE company_id = $1
           AND (
             action LIKE 'onboarding.%'
             OR action LIKE 'company.%'
             OR action LIKE 'tenant.%'
           )
         ORDER BY created_at DESC
         LIMIT 20`,
        [session.companyId]
      ),
    ])

    const counts = {
      warehouses: Number(warehousesResult.rows[0]?.count || 0),
      clients: Number(clientsResult.rows[0]?.count || 0),
      items: Number(itemsResult.rows[0]?.count || 0),
      users: Number(usersResult.rows[0]?.count || 0),
      contracts: Number(contractsResult.rows[0]?.count || 0),
      billing_profiles: Number(billingProfilesResult.rows[0]?.count || 0),
      portal_mappings: Number(portalMappingsResult.rows[0]?.count || 0),
      opening_stock: Number(stockResult.rows[0]?.count || 0),
    }

    const company = companyResult.rows[0] || null
    const productCodes = productsResult.rows.map((row) => String(row.product_code))
    const owner = ownerResult.rows[0] || null

    const steps: StepSummary[] = [
      {
        id: "company",
        title: "Verify Company Profile",
        eta_mins: 10,
        status: company ? "done" : "pending",
        detail: company
          ? `${company.company_name} (${company.company_code})`
          : "Create or configure company details",
        href: "/admin/companies",
        phase: "Tenant Setup",
        owner: "Platform Admin",
        evidence: company ? "Company profile exists" : undefined,
      },
      {
        id: "warehouse",
        title: "Create Warehouse",
        eta_mins: 10,
        status: counts.warehouses > 0 ? "done" : "pending",
        detail:
          counts.warehouses > 0
            ? `${counts.warehouses} warehouse(s) active`
            : "At least one warehouse required",
        href: "/admin/warehouses",
        phase: "Tenant Setup",
        owner: "Implementation",
        dependency: "Company profile",
        evidence: counts.warehouses > 0 ? "Active warehouse available" : undefined,
      },
      {
        id: "clients",
        title: "Create Clients",
        eta_mins: 15,
        status: counts.clients > 0 ? "done" : "pending",
        detail:
          counts.clients > 0 ? `${counts.clients} client(s) active` : "Create at least one client",
        href: "/admin/clients",
        phase: "Master Data",
        owner: "Implementation",
        dependency: "Warehouse",
        evidence: counts.clients > 0 ? "Client master has active records" : undefined,
      },
      {
        id: "items",
        title: "Load Item Master",
        eta_mins: 15,
        status: counts.items > 0 ? "done" : "pending",
        detail: counts.items > 0 ? `${counts.items} item(s) active` : "Import item master data",
        href: "/admin/items",
        phase: "Master Data",
        owner: "Implementation",
        dependency: "Client master",
        evidence: counts.items > 0 ? "Item master has active records" : undefined,
      },
      {
        id: "users",
        title: "Create Tenant Users",
        eta_mins: 10,
        status: counts.users >= 2 ? "done" : "pending",
        detail:
          counts.users >= 2
            ? `${counts.users} active user(s)`
            : "Create at least admin + operations user",
        href: "/admin/users",
        phase: "Tenant Setup",
        owner: "Platform Admin",
        dependency: "Company profile",
        evidence: counts.users >= 2 ? "Admin and tenant users exist" : undefined,
      },
      {
        id: "contracts",
        title: "Configure Contracts & Rates",
        eta_mins: 15,
        status: counts.clients > 0 ? (counts.contracts > 0 ? "done" : "pending") : "blocked",
        detail:
          counts.contracts > 0
            ? `${counts.contracts} active contract(s)`
            : "Configure at least one client contract",
        href: "/finance/contracts",
        phase: "Billing",
        owner: "Finance",
        dependency: "Clients",
        evidence: counts.contracts > 0 ? "Contract configured" : undefined,
      },
      {
        id: "billing",
        title: "Set Billing Profiles",
        eta_mins: 10,
        status: counts.contracts > 0 ? (counts.billing_profiles > 0 ? "done" : "pending") : "blocked",
        detail:
          counts.billing_profiles > 0
            ? `${counts.billing_profiles} billing profile(s)`
            : "Set billing profile for at least one client",
        href: "/finance/billing",
        phase: "Billing",
        owner: "Finance",
        dependency: "Contracts & rates",
        evidence: counts.billing_profiles > 0 ? "Billing profile configured" : undefined,
      },
      {
        id: "portal",
        title: "Map Portal Users to Clients",
        eta_mins: 5,
        status: counts.clients > 0 && counts.users > 0 ? (counts.portal_mappings > 0 ? "done" : "pending") : "blocked",
        detail:
          counts.portal_mappings > 0
            ? `${counts.portal_mappings} active portal mapping(s)`
            : "Map client users for portal access",
        href: "/portal",
        phase: "Portal",
        owner: "Platform Admin",
        dependency: "Clients and users",
        evidence: counts.portal_mappings > 0 ? "Portal users mapped to clients" : undefined,
      },
      {
        id: "smoke-test",
        title: "Smoke Test Core Flow",
        eta_mins: 5,
        status:
          counts.warehouses > 0 &&
          counts.clients > 0 &&
          counts.items > 0 &&
          counts.users >= 2 &&
          counts.contracts > 0 &&
          counts.billing_profiles > 0
            ? "review"
            : "blocked",
        detail: "Run one Gate In, GRN, DO, billing, and portal sign-in check",
        href: "/dashboard",
        phase: "Validation",
        owner: "Implementation",
        dependency: "Tenant setup, master data, billing, portal",
      },
      {
        id: "go-live",
        title: "Approve Go Live",
        eta_mins: 5,
        status:
          counts.warehouses > 0 &&
          counts.clients > 0 &&
          counts.items > 0 &&
          counts.users >= 2 &&
          counts.contracts > 0 &&
          counts.billing_profiles > 0 &&
          counts.portal_mappings > 0
            ? "review"
            : "blocked",
        detail: "Review validation evidence and approve tenant launch",
        href: "/admin/audit",
        phase: "Go Live",
        owner: "Platform Admin",
        dependency: "Smoke test evidence",
      },
    ]

    const doneCount = steps.filter((s) => s.status === "done").length
    const completionPct = Math.round((doneCount / steps.length) * 100)
    const remainingMins = steps
      .filter((s) => s.status === "pending")
      .reduce((sum, s) => sum + s.eta_mins, 0)
    const blockedCount = steps.filter((s) => s.status === "blocked").length
    const reviewCount = steps.filter((s) => s.status === "review").length
    const readinessStatus = blockedCount > 0 ? "Blocked" : reviewCount > 0 ? "Needs Review" : "Ready"
    const environmentStatus = company?.is_active ? "Pilot" : "Sandbox"

    const validationChecks: ValidationCheck[] = [
      {
        id: "tenant-profile",
        title: "Tenant profile",
        status: company?.domain && company?.storage_bucket ? "passed" : "warning",
        detail: company?.domain && company?.storage_bucket
          ? "Domain and storage bucket configured"
          : "Add tenant domain and storage bucket before production launch",
        href: "/admin/companies",
      },
      {
        id: "data-isolation",
        title: "Data isolation baseline",
        status: company ? "passed" : "blocked",
        detail: company ? `Scoped to company ${company.company_code}` : "Company context missing",
        href: "/admin/companies",
      },
      {
        id: "master-data",
        title: "Master data completeness",
        status: counts.warehouses > 0 && counts.clients > 0 && counts.items > 0 ? "passed" : "blocked",
        detail: `${counts.warehouses} warehouse(s), ${counts.clients} client(s), ${counts.items} item(s)`,
      },
      {
        id: "billing",
        title: "Billing readiness",
        status: counts.contracts > 0 && counts.billing_profiles > 0 ? "passed" : "blocked",
        detail: `${counts.contracts} contract(s), ${counts.billing_profiles} billing profile(s)`,
        href: "/finance/billing",
      },
      {
        id: "portal",
        title: "Portal access mapping",
        status: counts.portal_mappings > 0 ? "passed" : "warning",
        detail: `${counts.portal_mappings} active mapping(s)`,
        href: "/admin/onboarding",
      },
      {
        id: "products",
        title: "Product entitlements",
        status: productCodes.length > 0 ? "passed" : "blocked",
        detail: productCodes.length ? productCodes.join(", ") : "No active products enabled",
        href: "/admin/companies",
      },
    ]

    const importHistory = auditResult.rows
      .filter((row) => String(row.action).startsWith("onboarding.import."))
      .map((row) => ({
        action: row.action,
        type: String(row.action).replace("onboarding.import.", ""),
        file_name: row.after?.file_name || "CSV import",
        total_rows: row.after?.total_rows || 0,
        inserted: row.after?.inserted || 0,
        updated: row.after?.updated || 0,
        errors: row.after?.errors || 0,
        created_at: row.created_at,
      }))

    return ok({
      completion_pct: completionPct,
      done_steps: doneCount,
      total_steps: steps.length,
      remaining_mins: remainingMins,
      readiness_status: readinessStatus,
      environment_status: environmentStatus,
      blocked_steps: blockedCount,
      review_steps: reviewCount,
      tenant: company
        ? {
            id: company.id,
            company_code: company.company_code,
            company_name: company.company_name,
            domain: company.domain,
            storage_bucket: company.storage_bucket,
            subscription_plan: company.subscription_plan,
            billing_status: company.billing_status,
            is_active: company.is_active,
            products: productCodes,
            owner_name: owner?.full_name || null,
            owner_email: owner?.email || null,
            created_at: company.created_at,
            updated_at: company.updated_at,
          }
        : null,
      counts,
      steps,
      validation_checks: validationChecks,
      import_history: importHistory,
      activity: auditResult.rows.map((row) => ({
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        created_at: row.created_at,
        after: row.after,
      })),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load onboarding summary"
    return fail("SERVER_ERROR", message, 500)
  }
}
