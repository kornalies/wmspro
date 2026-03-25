import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"

type StepSummary = {
  id: string
  title: string
  eta_mins: number
  status: "pending" | "done"
  detail: string
  href: string
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
      warehousesResult,
      clientsResult,
      itemsResult,
      usersResult,
      contractsResult,
      billingProfilesResult,
      portalMappingsResult,
    ] = await Promise.all([
      query(
        `SELECT id, company_code, company_name
         FROM companies
         WHERE id = $1
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
    ])

    const counts = {
      warehouses: Number(warehousesResult.rows[0]?.count || 0),
      clients: Number(clientsResult.rows[0]?.count || 0),
      items: Number(itemsResult.rows[0]?.count || 0),
      users: Number(usersResult.rows[0]?.count || 0),
      contracts: Number(contractsResult.rows[0]?.count || 0),
      billing_profiles: Number(billingProfilesResult.rows[0]?.count || 0),
      portal_mappings: Number(portalMappingsResult.rows[0]?.count || 0),
    }

    const steps: StepSummary[] = [
      {
        id: "company",
        title: "Verify Company Profile",
        eta_mins: 10,
        status: companyResult.rows.length ? "done" : "pending",
        detail: companyResult.rows.length
          ? `${companyResult.rows[0].company_name} (${companyResult.rows[0].company_code})`
          : "Create or configure company details",
        href: "/admin/companies",
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
      },
      {
        id: "clients",
        title: "Create Clients",
        eta_mins: 15,
        status: counts.clients > 0 ? "done" : "pending",
        detail:
          counts.clients > 0 ? `${counts.clients} client(s) active` : "Create at least one client",
        href: "/admin/clients",
      },
      {
        id: "items",
        title: "Load Item Master",
        eta_mins: 15,
        status: counts.items > 0 ? "done" : "pending",
        detail: counts.items > 0 ? `${counts.items} item(s) active` : "Import item master data",
        href: "/admin/items",
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
      },
      {
        id: "contracts",
        title: "Configure Contracts & Rates",
        eta_mins: 15,
        status: counts.contracts > 0 ? "done" : "pending",
        detail:
          counts.contracts > 0
            ? `${counts.contracts} active contract(s)`
            : "Configure at least one client contract",
        href: "/finance/contracts",
      },
      {
        id: "billing",
        title: "Set Billing Profiles",
        eta_mins: 10,
        status: counts.billing_profiles > 0 ? "done" : "pending",
        detail:
          counts.billing_profiles > 0
            ? `${counts.billing_profiles} billing profile(s)`
            : "Set billing profile for at least one client",
        href: "/finance/billing",
      },
      {
        id: "portal",
        title: "Map Portal Users to Clients",
        eta_mins: 5,
        status: counts.portal_mappings > 0 ? "done" : "pending",
        detail:
          counts.portal_mappings > 0
            ? `${counts.portal_mappings} active portal mapping(s)`
            : "Map client users for portal access",
        href: "/portal",
      },
    ]

    const doneCount = steps.filter((s) => s.status === "done").length
    const completionPct = Math.round((doneCount / steps.length) * 100)
    const remainingMins = steps
      .filter((s) => s.status === "pending")
      .reduce((sum, s) => sum + s.eta_mins, 0)

    return ok({
      completion_pct: completionPct,
      done_steps: doneCount,
      total_steps: steps.length,
      remaining_mins: remainingMins,
      counts,
      steps,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load onboarding summary"
    return fail("SERVER_ERROR", message, 500)
  }
}
