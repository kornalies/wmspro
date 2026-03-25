BEGIN;

-- Allow dynamic role codes instead of hardcoded role set.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role ~ '^[A-Z0-9_]{2,50}$');

CREATE TABLE IF NOT EXISTS rbac_roles (
  id SERIAL PRIMARY KEY,
  role_code VARCHAR(50) NOT NULL UNIQUE,
  role_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rbac_permissions (
  id SERIAL PRIMARY KEY,
  permission_key VARCHAR(100) NOT NULL UNIQUE,
  permission_name VARCHAR(150) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS rbac_user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by INTEGER REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

INSERT INTO rbac_roles (role_code, role_name, description)
SELECT role_code, role_name, description
FROM (
  VALUES
    ('SUPER_ADMIN', 'Super Admin', 'Platform-level administrator'),
    ('ADMIN', 'Admin', 'Company administrator'),
    ('WAREHOUSE_MANAGER', 'Warehouse Manager', 'Warehouse operations manager'),
    ('SUPERVISOR', 'Supervisor', 'Operations supervisor'),
    ('OPERATOR', 'Operator', 'Operations operator'),
    ('OPERATIONS', 'Operations', 'Legacy operations role'),
    ('GATE_STAFF', 'Gate Staff', 'Legacy gate role'),
    ('FINANCE', 'Finance', 'Legacy finance role')
) AS seed(role_code, role_name, description)
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
SELECT permission_key, permission_name, description
FROM (
  VALUES
    ('admin.users.manage', 'Manage Users', 'Create/update/deactivate users'),
    ('admin.companies.manage', 'Manage Companies', 'Create/update/deactivate companies'),
    ('master.data.manage', 'Manage Master Data', 'Manage clients/items/warehouses/zones'),
    ('grn.manage', 'Manage GRN', 'Create/update/confirm GRN'),
    ('grn.mobile.approve', 'Approve Mobile GRN', 'Approve/reject mobile GRN captures'),
    ('do.manage', 'Manage Delivery Orders', 'Create and dispatch delivery orders'),
    ('gate.in.create', 'Create Gate In', 'Create gate in entries'),
    ('gate.out.create', 'Create Gate Out', 'Create gate out entries'),
    ('stock.putaway.manage', 'Manage Putaway', 'Perform putaway transfers'),
    ('reports.view', 'View Reports', 'View analytics and reports'),
    ('finance.view', 'View Finance', 'View finance and billing pages')
) AS seed(permission_key, permission_name, description)
ON CONFLICT (permission_key) DO NOTHING;

-- Role-permission assignments
WITH map AS (
  SELECT
    r.id AS role_id,
    p.id AS permission_id
  FROM rbac_roles r
  JOIN rbac_permissions p ON (
    r.role_code = 'SUPER_ADMIN'
    OR (r.role_code = 'ADMIN' AND p.permission_key IN (
      'admin.users.manage','admin.companies.manage','master.data.manage','grn.manage','grn.mobile.approve',
      'do.manage','gate.in.create','gate.out.create','stock.putaway.manage','reports.view','finance.view'
    ))
    OR (r.role_code = 'WAREHOUSE_MANAGER' AND p.permission_key IN (
      'master.data.manage','grn.manage','grn.mobile.approve','do.manage','gate.in.create','gate.out.create',
      'stock.putaway.manage','reports.view'
    ))
    OR (r.role_code = 'SUPERVISOR' AND p.permission_key IN (
      'grn.manage','grn.mobile.approve','do.manage','gate.in.create','gate.out.create','stock.putaway.manage','reports.view'
    ))
    OR (r.role_code = 'OPERATOR' AND p.permission_key IN (
      'grn.manage','do.manage','gate.in.create','gate.out.create','stock.putaway.manage'
    ))
    OR (r.role_code = 'OPERATIONS' AND p.permission_key IN (
      'grn.manage','grn.mobile.approve','do.manage','gate.in.create','gate.out.create','stock.putaway.manage','reports.view'
    ))
    OR (r.role_code = 'GATE_STAFF' AND p.permission_key IN (
      'gate.in.create','gate.out.create'
    ))
    OR (r.role_code = 'FINANCE' AND p.permission_key IN (
      'finance.view','reports.view'
    ))
  )
)
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT role_id, permission_id FROM map
ON CONFLICT DO NOTHING;

-- Backfill user assignments from legacy users.role values
INSERT INTO rbac_roles (role_code, role_name, is_system, description)
SELECT DISTINCT u.role, INITCAP(REPLACE(u.role, '_', ' ')), false, 'Backfilled from users.role'
FROM users u
WHERE u.role IS NOT NULL
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
SELECT u.id, r.id, true
FROM users u
JOIN rbac_roles r ON r.role_code = u.role
ON CONFLICT (user_id, role_id) DO NOTHING;

COMMIT;
