import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { syncInvoiceLedger } from "@/lib/finance-ledger"
import { openInvoicesForClient, receivablesByClient } from "@/lib/finance-receivables"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"

/**
 * Client-wise outstanding with aging.
 *
 * Aggregates in SQL rather than reusing /api/finance/invoices, which loads every
 * invoice with its line items and payment history as JSON — right for a paged
 * table, wrong as the basis of an AR summary.
 *
 * With `client_id` the response also carries that client's open items, so the
 * drill-down is one request rather than a second round trip per expanded row.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "billing")
    if (policy.permissions.includes("billing.view")) {
      requirePolicyPermission(policy, "billing.view")
    } else {
      requirePolicyPermission(policy, "finance.view")
    }

    const { searchParams } = new URL(request.url)
    const asOf = searchParams.get("as_of")
    const warehouseRaw = searchParams.get("warehouse_id")
    const clientRaw = searchParams.get("client_id")
    const warehouseId = warehouseRaw && warehouseRaw !== "all" ? Number(warehouseRaw) : null
    const clientId = clientRaw && clientRaw !== "all" ? Number(clientRaw) : null

    if (warehouseRaw && warehouseRaw !== "all" && !Number.isInteger(warehouseId)) {
      return fail("VALIDATION_ERROR", "Invalid warehouse_id", 400)
    }
    if (clientRaw && clientRaw !== "all" && !Number.isInteger(clientId)) {
      return fail("VALIDATION_ERROR", "Invalid client_id", 400)
    }
    // A narrow-scoped user asking for a site or client outside their scope is
    // refused rather than silently served an empty list.
    if (warehouseId) requireScope(policy, "warehouse", warehouseId)
    if (clientId) requireScope(policy, "client", clientId)

    // Balances are only as current as the last ledger sync; the invoices screen
    // does the same before reading, and AR is the screen people trust.
    await syncInvoiceLedger(session.companyId, session.userId)

    const { rows, totals, asOf: resolvedAsOf } = await receivablesByClient(session.companyId, {
      asOf,
      warehouseId,
      clientId,
    })

    const openItems = clientId
      ? (await openInvoicesForClient(session.companyId, clientId, { asOf, warehouseId })).rows
      : []

    return ok({ rows, totals, openItems, asOf: resolvedAsOf })
  } catch (error: unknown) {
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch receivables"
    return fail("SERVER_ERROR", message, 500)
  }
}
