BEGIN;

CREATE TABLE IF NOT EXISTS tenant_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  config_version INTEGER NOT NULL DEFAULT 1,
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
  security_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
  mobile_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
  ui_branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_scopes (
  id UUID PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('warehouse', 'zone', 'client')),
  scope_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_user_scopes_company_user_scope_type
  ON user_scopes(company_id, user_id, scope_type);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL DEFAULT 'web' CHECK (actor_type IN ('web', 'mobile', 'portal', 'system')),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS company_id INTEGER,
  ADD COLUMN IF NOT EXISTS actor_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id TEXT,
  ADD COLUMN IF NOT EXISTS before JSONB,
  ADD COLUMN IF NOT EXISTS after JSONB,
  ADD COLUMN IF NOT EXISTS ip INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE audit_logs
SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
WHERE company_id IS NULL;

ALTER TABLE audit_logs
  ALTER COLUMN company_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_logs_company_fk'
  ) THEN
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_logs_actor_user_fk'
  ) THEN
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_actor_user_fk
      FOREIGN KEY (actor_user_id) REFERENCES users(id);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_created_at
  ON audit_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_action_created_at
  ON audit_logs(company_id, action, created_at DESC);

INSERT INTO tenant_settings (
  company_id,
  feature_flags,
  workflow_policies,
  security_policies,
  mobile_policies,
  ui_branding
)
SELECT
  c.id,
  jsonb_build_object(
    'dashboard', true,
    'grn', true,
    'do', true,
    'gate', true,
    'stock', true,
    'reports', true,
    'billing', true,
    'finance', true,
    'portal', true,
    'mobile', true,
    'admin', true
  ),
  jsonb_build_object(
    'requireGateInBeforeGrn', false,
    'requireQc', false,
    'disallowDispatchIfPaymentHold', false
  ),
  jsonb_build_object(
    'mfaRequired', false,
    'sessionTimeoutMins', 60
  ),
  jsonb_build_object(
    'offlineEnabled', true,
    'scanMode', 'serial_only'
  ),
  jsonb_build_object(
    'logoUrl', '',
    'primaryColor', '#2563eb',
    'labels', '{}'::jsonb
  )
FROM companies c
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES
  ('settings.read', 'Read Tenant Settings', 'View tenant policy settings'),
  ('settings.update', 'Update Tenant Settings', 'Update tenant policy settings'),
  ('scopes.read', 'Read User Scopes', 'View scope assignments'),
  ('scopes.update', 'Update User Scopes', 'Manage scope assignments'),
  ('audit.view', 'View Audit Logs', 'View tenant audit logs'),
  ('stock.adjust', 'Adjust Stock', 'Adjust stock inventory'),
  ('billing.view', 'View Billing', 'View billing and invoice data'),
  ('billing.generate_invoice', 'Generate Billing Invoice', 'Generate billing invoices'),
  ('billing.export', 'Export Billing', 'Export billing reports')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = ANY(
  ARRAY[
    'settings.read',
    'settings.update',
    'scopes.read',
    'scopes.update',
    'audit.view',
    'stock.adjust',
    'billing.view',
    'billing.generate_invoice',
    'billing.export'
  ]::text[]
)
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = 'stock.adjust'
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'WAREHOUSE_MANAGER', 'SUPERVISOR', 'OPERATOR', 'OPERATIONS')
ON CONFLICT DO NOTHING;

COMMIT;
