import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, setTenantContext } from "@/lib/db"
import { DocumentNotFoundError, buildDocument } from "@/lib/documents/builders"
import { isDocumentType, type DocumentType } from "@/lib/documents/types"

import {
  guardPortalProductError,
  hasPortalFeaturePermission,
  parseAndAuthorizeClientId,
} from "@/app/api/portal/_utils"

/**
 * The two finance documents, for the client they belong to.
 *
 * The engine has rendered a commercial invoice and a statement of account for a
 * while, but only /api/documents served them, and that route gates on
 * `finance.view` -- a staff RBAC permission no portal user holds. So a client
 * could see that they owed money and had no way to obtain the paper saying so,
 * while "Download snapshot" handed them raw JSON no finance team would open.
 *
 * This is a separate route rather than a loosened gate on the existing one.
 * Widening /api/documents to accept portal users would have put every portal
 * check into a route that operators also use, where a later edit could quietly
 * drop one. Here the portal rules are the only rules, and the engine is reused
 * untouched, so both surfaces render identical paper.
 *
 * Only two types are exposed. The operating paperwork -- pick lists, gate
 * passes, manifests -- describes how the warehouse works internally and is not
 * the client's to read.
 */

const PORTAL_DOCUMENT_TYPES: DocumentType[] = ["commercial-invoice", "client-statement"]

type RouteContext = { params: Promise<{ type: string; id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)

    const { type, id } = await context.params
    if (!isDocumentType(type) || !PORTAL_DOCUMENT_TYPES.includes(type)) {
      return fail("VALIDATION_ERROR", `Document type '${type}' is not available in the portal`, 400)
    }

    // Both documents are billing paper, so both answer to the billing grant.
    if (!(await hasPortalFeaturePermission(session, "portal.billing.view"))) {
      return fail("FORBIDDEN", "No portal billing permission", 403)
    }

    const clientIdCheck = await parseAndAuthorizeClientId(
      session,
      new URL(request.url).searchParams.get("client_id")
    )
    if (!clientIdCheck.ok) {
      return fail(clientIdCheck.code, clientIdCheck.message, clientIdCheck.status)
    }
    const clientId = clientIdCheck.clientId

    const subjectId = Number(id)
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return fail("VALIDATION_ERROR", "Invalid document id", 400)
    }

    // A statement is keyed on the client itself, so its subject must BE the
    // client in scope -- otherwise the id in the URL would choose whose
    // statement gets printed, which is the whole gate.
    if (type === "client-statement" && subjectId !== clientId) {
      return fail("FORBIDDEN", "No access to this statement", 403)
    }

    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const { model, scope } = await buildDocument(db, session.companyId, type, subjectId)

    // Ownership is checked against the document the engine actually built, not
    // against the URL: an invoice id belonging to another client of the same
    // tenant passes every check above and is caught only here.
    if (scope.clientId !== clientId) {
      await db.query("ROLLBACK")
      return fail("FORBIDDEN", "No access to this document", 403)
    }

    await db.query("COMMIT")
    return ok(model)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const productGuarded = guardPortalProductError(error)
    if (productGuarded) return productGuarded
    if (error instanceof DocumentNotFoundError) return fail("NOT_FOUND", error.message, 404)
    const message = error instanceof Error ? error.message : "Failed to build document"
    return fail("DOCUMENT_BUILD_FAILED", message, 400)
  } finally {
    db.release()
  }
}
