import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getUserAccessProfile } from "@/lib/rbac"
import { canAccessPermissions, getRequiredPermissionsForPath } from "@/lib/route-permissions"
import { syncInvoiceLedger } from "@/lib/finance-ledger"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

export const dynamic = "force-dynamic"
export const revalidate = 0

type DashboardSummary = {
  executive: {
    total_warehouses: number
    total_inventory_value: number
    today_grns: number
    today_dos: number
    stock_alerts: number
    capacity_utilization_pct: number
  }
  alerts: Array<{
    type: "warning" | "info" | "error"
    message: string
  }>
  drilldown: {
    today_grns_recent: Array<{
      id: number
      number: string
      warehouse_name: string
      href: string
    }>
    today_dos_recent: Array<{
      id: number
      number: string
      warehouse_name: string
      href: string
    }>
    capacity_by_warehouse: Array<{
      warehouse_id: number
      warehouse_name: string
      used_units: number
      total_capacity_units: number
      utilization_pct: number
      href: string
    }>
  }
  billing_snapshot: {
    total_billed: number
    total_paid: number
    total_pending: number
    overdue_invoices: number
    invoice_count: number
    href: string
  }
  recent_activity: Array<{
    action: string
    ref: string
    time: string
    href?: string
  }>
  meta: {
    inventory_value_source: "ledger_account_1200"
    inventory_value_as_of: string
  }
}

type CapacityRow = {
  warehouse_id: number
  warehouse_name: string
  used_units: number
  total_capacity_units: number
  utilization_pct: number
  href: string
}

function toRelativeTime(dateValue: string | Date): string {
  const then = new Date(dateValue).getTime()
  const now = Date.now()
  const diffMs = Math.max(0, now - then)
  const diffMinutes = Math.floor(diffMs / 60000)

  if (diffMinutes < 1) return "just now"
  if (diffMinutes < 60) return `${diffMinutes} min ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} hr ago`

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function resolveRange(range: string) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const to = formatDate(today)

  if (range === "month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1)
    return { from: formatDate(start), to }
  }

  if (range === "week") {
    const start = new Date(today)
    start.setDate(start.getDate() - 6)
    return { from: formatDate(start), to }
  }

  return { from: to, to }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    const requiredPermissions = getRequiredPermissionsForPath("/dashboard")
    const access = await getUserAccessProfile(session.userId, session.role)
    const canViewDashboard = canAccessPermissions(
      { role: session.role, permissions: access.permissions },
      requiredPermissions
    )
    if (!canViewDashboard) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const { searchParams } = new URL(request.url)
    const range = (searchParams.get("range") || "today").toLowerCase()
    const fallback = resolveRange(range)
    const fromParam = searchParams.get("from") || ""
    const toParam = searchParams.get("to") || ""
    const hasCustom = fromParam && toParam && isIsoDate(fromParam) && isIsoDate(toParam)
    const from = hasCustom ? fromParam : fallback.from
    const to = hasCustom ? toParam : fallback.to
    const companyId = session.companyId

    await syncInvoiceLedger(companyId, session.userId)

    const [executiveResult, lowStockResult, todayOpsResult, capacityResult, drilldownResult, recentResult] = await Promise.all([
      query(
        `SELECT
          (SELECT COUNT(*)::int FROM warehouses w WHERE w.is_active = true AND w.company_id = $1) AS total_warehouses,
          (
            SELECT COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0)::numeric
            FROM journal_lines jl
            JOIN journal_entries je
              ON je.id = jl.journal_entry_id
             AND je.company_id = jl.company_id
            JOIN chart_of_accounts coa
              ON coa.id = jl.account_id
             AND coa.company_id = jl.company_id
            WHERE jl.company_id = $1
              AND coa.account_code = '1200'
              AND je.entry_date <= $2::date
          ) AS total_inventory_value`,
        [companyId, to]
      ),
      query(
        `SELECT COUNT(*)::int AS low_stock_count
         FROM (
           SELECT
             i.id,
             i.min_stock_alert,
             COUNT(*) FILTER (WHERE ssn.status = 'IN_STOCK') AS in_stock_count
           FROM items i
           LEFT JOIN stock_serial_numbers ssn ON ssn.item_id = i.id AND ssn.company_id = i.company_id
           WHERE i.min_stock_alert IS NOT NULL
             AND i.company_id = $1
           GROUP BY i.id, i.min_stock_alert
         ) x
         WHERE x.in_stock_count < x.min_stock_alert`,
        [companyId]
      ),
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM grn_header gh WHERE gh.company_id = $1 AND gh.grn_date BETWEEN $2::date AND $3::date) AS today_grns,
           (SELECT COUNT(*)::int FROM do_header dh WHERE dh.company_id = $1 AND dh.request_date BETWEEN $2::date AND $3::date) AS today_dos`,
        [companyId, from, to]
      ),
      query(
        `SELECT
           w.id AS warehouse_id,
           w.warehouse_name,
           COALESCE(SUM(CASE WHEN ssn.status = 'IN_STOCK' THEN 1 ELSE 0 END), 0)::int AS used_units,
           COALESCE(SUM(COALESCE(zl.capacity_units, 0)), 0)::int AS total_capacity_units
         FROM warehouses w
         LEFT JOIN warehouse_zone_layouts zl
           ON zl.warehouse_id = w.id
          AND zl.company_id = w.company_id
          AND zl.is_active = true
         LEFT JOIN stock_serial_numbers ssn
           ON ssn.warehouse_id = w.id
          AND ssn.company_id = w.company_id
          AND ssn.zone_layout_id = zl.id
         WHERE w.is_active = true
           AND w.company_id = $1
         GROUP BY w.id, w.warehouse_name
         ORDER BY w.warehouse_name ASC`,
        [companyId]
      ),
      query(
        `SELECT
          (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT gh.id, gh.grn_number AS number, w.warehouse_name, CONCAT('/grn/', gh.id) AS href
            FROM grn_header gh
            JOIN warehouses w ON w.id = gh.warehouse_id AND w.company_id = gh.company_id
            WHERE gh.company_id = $1
              AND gh.grn_date BETWEEN $2::date AND $3::date
            ORDER BY gh.created_at DESC
            LIMIT 10
          ) t) AS today_grns_recent,
          (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT dh.id, dh.do_number AS number, w.warehouse_name, CONCAT('/do?search=', dh.do_number) AS href
            FROM do_header dh
            JOIN warehouses w ON w.id = dh.warehouse_id AND w.company_id = dh.company_id
            WHERE dh.company_id = $1
              AND dh.request_date BETWEEN $2::date AND $3::date
            ORDER BY dh.created_at DESC
            LIMIT 10
          ) t) AS today_dos_recent`,
        [companyId, from, to]
      ),
      query(
        `SELECT action, ref, href, created_at
         FROM (
           SELECT
             'GRN Created'::text AS action,
             gh.grn_number::text AS ref,
             CONCAT('/grn/', gh.id)::text AS href,
             gh.created_at
            FROM grn_header gh
            WHERE gh.company_id = $1
           UNION ALL
           SELECT
             'DO Created'::text AS action,
             dh.do_number::text AS ref,
             CONCAT('/do?search=', dh.do_number)::text AS href,
             dh.created_at
            FROM do_header dh
            WHERE dh.company_id = $1
           UNION ALL
           SELECT
             'Gate In'::text AS action,
             gi.gate_in_number::text AS ref,
             CONCAT('/gate/in/', gi.id)::text AS href,
             gi.created_at
            FROM gate_in gi
            WHERE gi.company_id = $1
         ) e
         WHERE e.created_at::date BETWEEN $2::date AND $3::date
         ORDER BY created_at DESC
         LIMIT 8`,
        [companyId, from, to]
      ),
    ])

    const executiveRow = executiveResult.rows[0] ?? {}
    const lowStockCount = Number(lowStockResult.rows[0]?.low_stock_count || 0)
    const todayRow = todayOpsResult.rows[0] ?? {}
    const todayGrns = Number(todayRow.today_grns || 0)
    const todayDos = Number(todayRow.today_dos || 0)

    const capacityByWarehouse: CapacityRow[] = capacityResult.rows.map((row: {
      warehouse_id: number
      warehouse_name: string
      used_units: number
      total_capacity_units: number
    }) => {
      const usedUnits = Number(row.used_units || 0)
      const totalCapacity = Number(row.total_capacity_units || 0)
      const utilization = totalCapacity > 0 ? (usedUnits / totalCapacity) * 100 : 0
      return {
        warehouse_id: Number(row.warehouse_id),
        warehouse_name: String(row.warehouse_name),
        used_units: usedUnits,
        total_capacity_units: totalCapacity,
        utilization_pct: Number(utilization.toFixed(1)),
        href: "/admin/zone-layouts",
      }
    })

    const totalUsed = capacityByWarehouse.reduce((sum: number, row: CapacityRow) => sum + row.used_units, 0)
    const totalCap = capacityByWarehouse.reduce((sum: number, row: CapacityRow) => sum + row.total_capacity_units, 0)
    const companyUtilizationPct = totalCap > 0 ? Number(((totalUsed / totalCap) * 100).toFixed(1)) : 0

    const alerts: DashboardSummary["alerts"] = []
    if (lowStockCount > 0) {
      alerts.push({
        type: "warning",
        message: `${lowStockCount} item${lowStockCount > 1 ? "s" : ""} below min stock level`,
      })
    }
    if (todayGrns > 0 || todayDos > 0) {
      alerts.push({
        type: "info",
        message: `Today: ${todayGrns} GRN${todayGrns !== 1 ? "s" : ""}, ${todayDos} DO${todayDos !== 1 ? "s" : ""}`,
      })
    }
    if (alerts.length === 0) {
      alerts.push({
        type: "info",
        message: "No active alerts",
      })
    }

    const drilldownRow = drilldownResult.rows[0] ?? {
      today_grns_recent: [],
      today_dos_recent: [],
    }

    const recentActivity = recentResult.rows.map((row: { action: unknown; ref: unknown; href?: unknown; created_at: string | Date }) => ({
      action: String(row.action),
      ref: String(row.ref),
      href: row.href ? String(row.href) : undefined,
      time: toRelativeTime(row.created_at),
    }))

    const invoicesTable = await query(`SELECT to_regclass('public.invoices') AS table_name`)
    let billingSnapshot: DashboardSummary["billing_snapshot"]

    if (invoicesTable.rows[0]?.table_name) {
      const billingResult = await query(
        `SELECT
           COUNT(*)::int AS invoice_count,
           COALESCE(SUM(COALESCE(i.total_amount, 0)), 0)::numeric AS total_billed,
           COALESCE(SUM(COALESCE(i.paid_amount, 0)), 0)::numeric AS total_paid,
           COALESCE(SUM(COALESCE(i.balance, COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0))), 0)::numeric AS total_pending,
           COUNT(*) FILTER (
             WHERE COALESCE(i.balance, COALESCE(i.total_amount, 0) - COALESCE(i.paid_amount, 0)) > 0
               AND i.due_date::date < CURRENT_DATE
           )::int AS overdue_invoices
         FROM invoices i
         WHERE i.company_id = $1
           AND i.invoice_date::date BETWEEN $2::date AND $3::date`,
        [companyId, from, to]
      )
      const row = billingResult.rows[0] ?? {}
      billingSnapshot = {
        total_billed: Number(row.total_billed || 0),
        total_paid: Number(row.total_paid || 0),
        total_pending: Number(row.total_pending || 0),
        overdue_invoices: Number(row.overdue_invoices || 0),
        invoice_count: Number(row.invoice_count || 0),
        href: "/finance/billing",
      }
    } else {
      const fallbackBilling = await query(
        `WITH invoice_like AS (
           SELECT
             DATE_TRUNC('month', dh.request_date)::date AS invoice_date,
             (DATE_TRUNC('month', dh.request_date)::date + INTERVAL '27 day')::date AS due_date,
             COALESCE(SUM(dli.quantity_dispatched * COALESCE(i.standard_mrp, 0)), 0)::numeric AS total_amount
           FROM do_header dh
           LEFT JOIN do_line_items dli ON dli.do_header_id = dh.id AND dli.company_id = dh.company_id
           LEFT JOIN items i ON i.id = dli.item_id AND i.company_id = dli.company_id
           WHERE dh.company_id = $1
             AND dh.request_date BETWEEN $2::date AND $3::date
           GROUP BY DATE_TRUNC('month', dh.request_date), dh.client_id
         )
         SELECT
           COUNT(*)::int AS invoice_count,
           COALESCE(SUM(total_amount), 0)::numeric AS total_billed,
           0::numeric AS total_paid,
           COALESCE(SUM(total_amount), 0)::numeric AS total_pending,
           COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue_invoices
         FROM invoice_like`,
        [companyId, from, to]
      )
      const row = fallbackBilling.rows[0] ?? {}
      billingSnapshot = {
        total_billed: Number(row.total_billed || 0),
        total_paid: Number(row.total_paid || 0),
        total_pending: Number(row.total_pending || 0),
        overdue_invoices: Number(row.overdue_invoices || 0),
        invoice_count: Number(row.invoice_count || 0),
        href: "/finance/billing",
      }
    }

    const data: DashboardSummary = {
      executive: {
        total_warehouses: Number(executiveRow.total_warehouses || 0),
        total_inventory_value: Number(executiveRow.total_inventory_value || 0),
        today_grns: todayGrns,
        today_dos: todayDos,
        stock_alerts: lowStockCount,
        capacity_utilization_pct: companyUtilizationPct,
      },
      alerts,
      drilldown: {
        today_grns_recent: Array.isArray(drilldownRow.today_grns_recent) ? drilldownRow.today_grns_recent : [],
        today_dos_recent: Array.isArray(drilldownRow.today_dos_recent) ? drilldownRow.today_dos_recent : [],
        capacity_by_warehouse: capacityByWarehouse,
      },
      billing_snapshot: billingSnapshot,
      recent_activity: recentActivity,
      meta: {
        inventory_value_source: "ledger_account_1200",
        inventory_value_as_of: to,
      },
    }

    return ok(data, undefined, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store",
      },
    })
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch dashboard summary"
    return fail("SERVER_ERROR", message, 500)
  }
}
