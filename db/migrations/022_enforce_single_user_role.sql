BEGIN;

-- Ensure every users.role value exists in role master.
INSERT INTO rbac_roles (role_code, role_name, is_system, description)
SELECT DISTINCT u.role, INITCAP(REPLACE(u.role, '_', ' ')), false, 'Backfilled from users.role'
FROM users u
WHERE u.role IS NOT NULL
ON CONFLICT (role_code) DO NOTHING;

-- Ensure every user has an assignment for users.role.
INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
SELECT u.id, r.id, true
FROM users u
JOIN rbac_roles r ON r.role_code = u.role
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Remove stale role assignments so each user keeps only selected users.role.
DELETE FROM rbac_user_roles ur
USING users u
JOIN rbac_roles r ON r.role_code = u.role
WHERE ur.user_id = u.id
  AND ur.role_id <> r.id;

-- Remaining assignment is the effective primary role.
UPDATE rbac_user_roles
SET is_primary = true;

-- Enforce one-role-per-user at database level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rbac_user_roles_user_id
  ON rbac_user_roles (user_id);

COMMIT;
