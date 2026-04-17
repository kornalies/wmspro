-- Ensure portal-facing roles are present and active across environments.
-- This is idempotent and safe to run multiple times.

INSERT INTO rbac_roles (role_code, role_name, description, is_system, is_active)
VALUES
  ('CLIENT', 'Client', 'Client portal role', true, true),
  ('VIEWER', 'Viewer', 'Read-only client portal role', true, true)
ON CONFLICT (role_code)
DO UPDATE SET
  role_name = EXCLUDED.role_name,
  description = EXCLUDED.description,
  is_system = EXCLUDED.is_system,
  is_active = true;

INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
VALUES ('portal.client.view', 'Access Client Portal', true)
ON CONFLICT (permission_key)
DO UPDATE SET
  permission_name = EXCLUDED.permission_name,
  is_active = true;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = 'portal.client.view'
WHERE r.role_code IN ('CLIENT', 'VIEWER')
ON CONFLICT DO NOTHING;
