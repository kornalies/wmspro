BEGIN;

-- Migrations 017 and 032 created four portal tables without row level security,
-- while 030 enabled it on the four it added. The result is a portal whose SLA
-- policies and disputes are tenant-isolated at the database but whose
-- client mappings, feature grants, invites, and ASN requests are isolated only
-- by whatever WHERE clause the calling route remembered to write. Every app
-- connection runs as a non-BYPASSRLS role (lib/db.ts refuses to start
-- otherwise), so the policies below are the real boundary, not a formality.
--
-- The permission backfill runs FIRST, before RLS is enabled. It has to: this
-- migration executes with no app.company_id set, so once FORCE ROW LEVEL
-- SECURITY is on, the INSERT's WITH CHECK would reject every row.

-- ---------------------------------------------------------------------------
-- 1. Backfill feature grants for existing portal users.
-- ---------------------------------------------------------------------------
-- hasPortalFeaturePermission() currently treats "user has zero permission rows"
-- as "allow everything", so a portal user with a client mapping and no grants
-- sees every feature today. That default is about to be inverted, which would
-- silently strip access from every existing portal user. Granting them the full
-- key set preserves exactly what they can do right now and leaves the admin UI
-- to trim it. The write-capable keys are not the only gate on writes -- the
-- routes also check the RBAC permission via hasPortalPermission() -- so this is
-- not as broad as it reads.
--
-- Admins are skipped: they short-circuit to allowed regardless, and the mapping
-- auto-seed hands every admin every client, so seeding them here would write a
-- row per admin per key for no behavioural gain.
INSERT INTO portal_user_permissions (company_id, user_id, feature_key, is_allowed)
SELECT DISTINCT puc.company_id, puc.user_id, fk.feature_key, true
FROM portal_user_clients puc
JOIN users u
  ON u.id = puc.user_id
 AND u.company_id = puc.company_id
LEFT JOIN LATERAL (
  SELECT r.role_code
  FROM rbac_user_roles ur
  JOIN rbac_roles r ON r.id = ur.role_id
  WHERE ur.user_id = u.id
    AND r.is_active = true
  ORDER BY ur.is_primary DESC, r.role_code ASC
  LIMIT 1
) primary_role ON true
CROSS JOIN (
  VALUES
    ('portal.inventory.view'),
    ('portal.orders.view'),
    ('portal.billing.view'),
    ('portal.reports.view'),
    ('portal.sla.view'),
    ('portal.sla.manage'),
    ('portal.dispute.view'),
    ('portal.dispute.create'),
    ('portal.dispute.manage'),
    ('portal.asn.view'),
    ('portal.asn.create')
) AS fk(feature_key)
WHERE puc.is_active = true
  AND UPPER(COALESCE(primary_role.role_code, u.role)) NOT IN ('SUPER_ADMIN', 'ADMIN')
  AND NOT EXISTS (
    SELECT 1
    FROM portal_user_permissions existing
    WHERE existing.company_id = puc.company_id
      AND existing.user_id = puc.user_id
  )
ON CONFLICT (company_id, user_id, feature_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Tenant isolation on the four unprotected portal tables.
-- ---------------------------------------------------------------------------
ALTER TABLE portal_user_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_user_clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_user_clients_tenant_isolation ON portal_user_clients;
CREATE POLICY portal_user_clients_tenant_isolation
  ON portal_user_clients
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE client_portal_asn_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_asn_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_portal_asn_requests_tenant_isolation ON client_portal_asn_requests;
CREATE POLICY client_portal_asn_requests_tenant_isolation
  ON client_portal_asn_requests
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE portal_user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_user_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_user_permissions_tenant_isolation ON portal_user_permissions;
CREATE POLICY portal_user_permissions_tenant_isolation
  ON portal_user_permissions
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

-- Invites are the one portal table read without a session. Activation happens
-- before the user can log in, so /api/portal/invite/validate and /activate have
-- no company context to filter on -- they arrive holding only the token. A
-- straight company_id policy would 404 every invite and break activation
-- entirely.
--
-- So the read side also accepts a row whose token matches app.portal_invite_token,
-- a transaction-local setting those two routes populate from the URL. The token
-- is the credential: 120 characters, single-use, expiring, and matched by
-- equality against one row. When the setting is absent current_setting returns
-- NULL, NULLIF leaves it NULL, and `invite_token = NULL` is NULL rather than
-- true -- an unset context opens nothing.
--
-- WITH CHECK deliberately does NOT get the token escape hatch. Reading an invite
-- by token is the flow; writing one is not. Activation sets a real company
-- context before it marks the invite ACCEPTED, so the strict check passes there
-- and no token holder can insert or retarget a row across tenants.
ALTER TABLE portal_user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_user_invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_user_invites_tenant_isolation ON portal_user_invites;
CREATE POLICY portal_user_invites_tenant_isolation
  ON portal_user_invites
  USING (
    company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER
    OR invite_token = NULLIF(current_setting('app.portal_invite_token', true), '')
  )
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
