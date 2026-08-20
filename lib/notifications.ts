/**
 * Writing notifications from the web app.
 *
 * Until now every row in `notifications` came from the mobile service; this repo
 * only ever read them (see docs/notifications-contract.md). These helpers are the
 * first web-side writer, and they follow the same contract:
 *
 *   - one row per recipient, never a shared row, because read_at lives on the row
 *     and a shared one would let the first reader hide it for everybody else;
 *   - `source` identifies the origin -- 'web' here, as opposed to 'mobile';
 *   - `type` is dot-namespaced for later filtering;
 *   - `data` carries enough to deep-link from, even though the current UI does not.
 *
 * Nothing here is allowed to break the thing it is announcing. A notification is
 * a courtesy: if the insert fails, the ASN was still accepted and the GRN was
 * still booked. Every function swallows its errors after logging, and callers
 * invoke them after COMMIT rather than inside the transaction.
 */
import { query } from "@/lib/db"

type DBClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type NotificationInput = {
  companyId: number
  userIds: number[]
  type: string
  title: string
  body?: string
  data?: Record<string, unknown>
  source?: string
}

/**
 * Insert one notification per recipient.
 *
 * Deliberately non-throwing. The alternative -- letting a failed insert bubble --
 * would mean a full inbox or a bad user id could roll back a receipt, which is a
 * far worse outcome than a missing bell icon.
 */
export async function notifyUsers(input: NotificationInput, db: DBClient = { query }) {
  const recipients = Array.from(new Set(input.userIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)))
  if (!recipients.length) return 0

  try {
    // One statement, one row per recipient, rather than a loop: this runs on the
    // request path after a commit and there is no reason to pay N round trips.
    const result = await db.query(
      `INSERT INTO notifications (company_id, user_id, source, type, title, body, data)
       SELECT $1, uid, $2, $3, $4, $5, $6::jsonb
       FROM UNNEST($7::int[]) AS uid
       RETURNING id`,
      [
        input.companyId,
        input.source || "web",
        input.type,
        input.title,
        input.body || null,
        JSON.stringify(input.data || {}),
        recipients,
      ]
    )
    return result.rows.length
  } catch (error) {
    console.error("Failed to write notifications", { type: input.type, error })
    return 0
  }
}

/**
 * Every active user in a company who holds a permission, plus the admins.
 *
 * The admin arm is not redundant. Permissions come from rbac_user_roles, but the
 * app treats SUPER_ADMIN and ADMIN as implicitly able to do everything --
 * requirePermission short-circuits on SUPER_ADMIN, and canReviewAsn() on both.
 * Resolving recipients by the RBAC join alone would silently skip the very
 * people most likely to be watching a queue on a small tenant, where the admin
 * often is the warehouse manager.
 */
export async function resolveUsersWithPermission(
  companyId: number,
  permissionKey: string,
  db: DBClient = { query }
): Promise<number[]> {
  try {
    const result = await db.query(
      `SELECT DISTINCT u.id
       FROM users u
       LEFT JOIN rbac_user_roles ur ON ur.user_id = u.id
       LEFT JOIN rbac_roles r ON r.id = ur.role_id AND r.is_active = true
       LEFT JOIN rbac_role_permissions rp ON rp.role_id = r.id
       LEFT JOIN rbac_permissions p ON p.id = rp.permission_id AND p.is_active = true
       WHERE u.company_id = $1
         AND u.is_active = true
         AND (
           p.permission_key = $2
           OR UPPER(COALESCE(u.role, '')) IN ('SUPER_ADMIN', 'ADMIN')
         )`,
      [companyId, permissionKey]
    )
    return result.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id))
  } catch (error) {
    console.error("Failed to resolve notification recipients", { permissionKey, error })
    return []
  }
}
