import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")

    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get("client_id")

    const params: Array<unknown> = [session.companyId]
    let clientFilter = ""
    if (clientId && clientId !== "all") {
      params.push(Number(clientId))
      clientFilter = ` AND c.id = $${params.length}`
    }

    // Billing reads invoice_header, the table the rest of finance uses, and
    // excludes DRAFT and VOID so this screen agrees with the receivables screen
    // and the client portal (lib/finance-receivables.ts, portal/reports).
    //
    // It used to prefer a legacy `public.invoices` table whenever that table
    // still existed. On a database carrying both, that meant Client Analysis
    // reported one stale row as the entire book: one client showed 899,990
    // against 118 actually billed, and every other client showed zero while
    // being invoiced. The legacy table is not read here at all any more.
    const result = await query(
      `SELECT
        c.id AS client_id,
        c.client_name AS name,
        (SELECT COUNT(*)
           FROM stock_serial_numbers ssn
          WHERE ssn.client_id = c.id
            AND ssn.company_id = c.company_id
            AND ssn.status = 'IN_STOCK')::int AS stock,
        (SELECT COALESCE(SUM(COALESCE(ih.grand_total, 0)), 0)
           FROM invoice_header ih
          WHERE ih.client_id = c.id
            AND ih.company_id = c.company_id
            AND COALESCE(ih.status, '') <> ALL (ARRAY['DRAFT', 'VOID']))::numeric AS billing,
        (SELECT COUNT(*)
           FROM grn_header gh
          WHERE gh.client_id = c.id
            AND gh.company_id = c.company_id
            AND gh.status <> 'CANCELLED')::int AS grns,
        (SELECT COUNT(*)
           FROM do_header dh
          WHERE dh.client_id = c.id
            AND dh.company_id = c.company_id
            AND dh.status <> 'CANCELLED')::int AS dos
      FROM clients c
      WHERE c.company_id = $1${clientFilter}
      ORDER BY c.client_name`,
      params
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const message = error instanceof Error ? error.message : "Failed to fetch analytics report"
    return fail("SERVER_ERROR", message, 500)
  }
}
