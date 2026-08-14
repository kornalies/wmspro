import { TokenPayload } from "@/lib/auth"
import { query } from "@/lib/db"

export { PORTAL_FEATURE_KEYS, type PortalFeatureKey } from "@/lib/portal-features"

type TenantAwareClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

/**
 * Open the token-scoped read window on portal_user_invites for this transaction.
 *
 * Invite validation and activation both run before the user has a session, so
 * they have no company context and RLS would otherwise hide the row they were
 * sent to look up. The policy added in migration 080 accepts a row whose token
 * matches this setting; the token itself is the credential. Transaction-local
 * (set_config's third argument), so it cannot leak to the next borrower of a
 * pooled connection.
 */
export async function setInviteTokenContext(client: TenantAwareClient, token: string) {
  await client.query("SELECT set_config('app.portal_invite_token', $1, true)", [String(token || "")])
}

export async function resolvePermittedClientIds(session: TokenPayload): Promise<number[]> {
  // company_id is redundant with the RLS policy and stated anyway: this is the
  // query that decides which clients a portal user can see, and it should not
  // depend on the tenant context having been applied to be correct.
  const mapped = await query(
    `SELECT client_id
     FROM portal_user_clients
     WHERE company_id = $1
       AND user_id = $2
       AND is_active = true
     ORDER BY client_id`,
    [session.companyId, session.userId]
  )
  return mapped.rows
    .map((r: { client_id: number }) => Number(r.client_id))
    .filter((v: number) => Number.isFinite(v))
}

export async function canAccessClient(session: TokenPayload, clientId: number): Promise<boolean> {
  const ids = await resolvePermittedClientIds(session)
  return ids.includes(clientId)
}

export async function resolvePortalFeaturePermissions(session: TokenPayload): Promise<string[]> {
  const result = await query(
    `SELECT feature_key
     FROM portal_user_permissions
     WHERE company_id = $1
       AND user_id = $2
       AND is_allowed = true
     ORDER BY feature_key ASC`,
    [session.companyId, session.userId]
  )
  return result.rows.map((row: { feature_key: string }) => String(row.feature_key))
}
