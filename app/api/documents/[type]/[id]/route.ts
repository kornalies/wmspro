import { NextRequest } from "next/server"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import {
  guardToFailResponse,
  requireFeature,
  requirePolicyPermission,
  requireScope,
} from "@/lib/policy/guards"
import { DocumentNotFoundError, buildDocument } from "@/lib/documents/builders"
import { isDocumentType } from "@/lib/documents/types"

/**
 * Serves any document in the engine as a DocumentModel. Rendering lives in the
 * client (components/documents/document-sheet.tsx) so there is exactly one
 * layout for every document type; this route only decides what data the caller
 * is allowed to see.
 *
 * The `[id]` means different things per type — a wave for a pick list, a load
 * for a consignment note. See DOCUMENT_SUBJECT in lib/documents/builders.ts.
 */

type RouteContext = {
  params: Promise<{ type: string; id: string }>
}

export async function GET(_: NextRequest, context: RouteContext) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "do.manage")
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    requireFeature(policy, "do")
    requirePolicyPermission(policy, "do.manage")

    const { type, id } = await context.params
    if (!isDocumentType(type)) {
      return fail("VALIDATION_ERROR", `Unknown document type '${type}'`, 400)
    }
    const subjectId = Number(id)
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return fail("VALIDATION_ERROR", "Invalid document id", 400)
    }

    // is_local = true: the tenant setting only survives inside a transaction.
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    const { model, scope } = await buildDocument(db, session.companyId, type, subjectId)

    // Scope is enforced from the document's own warehouse/client rather than
    // from the URL, so a user with a narrow scope cannot read another site's
    // paperwork by guessing an id.
    requireScope(policy, "warehouse", scope.warehouseId)
    requireScope(policy, "client", scope.clientId)

    await db.query("COMMIT")
    return ok(model)
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    if (error instanceof DocumentNotFoundError) return fail("NOT_FOUND", error.message, 404)
    const message = error instanceof Error ? error.message : "Failed to build document"
    return fail("DOCUMENT_BUILD_FAILED", message, 400)
  } finally {
    db.release()
  }
}