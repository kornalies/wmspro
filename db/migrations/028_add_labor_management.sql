BEGIN;

CREATE TABLE IF NOT EXISTS labor_standards (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  operation_code VARCHAR(50) NOT NULL,
  operation_name VARCHAR(150) NOT NULL,
  unit_of_measure VARCHAR(20) NOT NULL DEFAULT 'UNITS',
  standard_units_per_hour NUMERIC(10,2) NOT NULL CHECK (standard_units_per_hour > 0),
  warning_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 85 CHECK (warning_threshold_pct > 0 AND warning_threshold_pct <= 200),
  critical_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 65 CHECK (critical_threshold_pct > 0 AND critical_threshold_pct <= 200),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_labor_standard_company_operation UNIQUE (company_id, operation_code)
);

CREATE INDEX IF NOT EXISTS idx_labor_standards_company_active
  ON labor_standards(company_id, is_active, operation_name);

CREATE TABLE IF NOT EXISTS labor_shifts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shift_code VARCHAR(30) NOT NULL,
  shift_name VARCHAR(120) NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  planned_headcount INTEGER NOT NULL DEFAULT 1 CHECK (planned_headcount > 0),
  break_minutes INTEGER NOT NULL DEFAULT 30 CHECK (break_minutes >= 0),
  is_overnight BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_labor_shift_company_code UNIQUE (company_id, shift_code)
);

CREATE INDEX IF NOT EXISTS idx_labor_shifts_company_active
  ON labor_shifts(company_id, is_active, shift_name);

CREATE TABLE IF NOT EXISTS labor_shift_assignments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES labor_shifts(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_role VARCHAR(50) NOT NULL DEFAULT 'OPERATOR',
  assignment_status VARCHAR(20) NOT NULL DEFAULT 'ASSIGNED',
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_labor_shift_assignment UNIQUE (company_id, shift_id, shift_date, user_id),
  CONSTRAINT ck_labor_assignment_status CHECK (assignment_status IN ('ASSIGNED', 'ABSENT', 'REPLACED', 'OFF'))
);

CREATE INDEX IF NOT EXISTS idx_labor_shift_assignments_company_date
  ON labor_shift_assignments(company_id, shift_date DESC, shift_id);

CREATE TABLE IF NOT EXISTS labor_productivity_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  standard_id INTEGER NOT NULL REFERENCES labor_standards(id),
  shift_id INTEGER REFERENCES labor_shifts(id),
  assignment_id INTEGER REFERENCES labor_shift_assignments(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  client_id INTEGER REFERENCES clients(id),
  user_id INTEGER REFERENCES users(id),
  source_type VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  source_ref VARCHAR(120),
  event_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  duration_minutes NUMERIC(10,2) NOT NULL CHECK (duration_minutes > 0),
  quality_score NUMERIC(5,2) CHECK (quality_score >= 0 AND quality_score <= 100),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_labor_productivity_source CHECK (source_type IN ('MANUAL', 'TASK', 'SCAN'))
);

CREATE INDEX IF NOT EXISTS idx_labor_productivity_company_event_ts
  ON labor_productivity_events(company_id, event_ts DESC);

CREATE INDEX IF NOT EXISTS idx_labor_productivity_company_user
  ON labor_productivity_events(company_id, user_id, event_ts DESC);

ALTER TABLE labor_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_standards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labor_standards_tenant_isolation ON labor_standards;
CREATE POLICY labor_standards_tenant_isolation
  ON labor_standards
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE labor_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_shifts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labor_shifts_tenant_isolation ON labor_shifts;
CREATE POLICY labor_shifts_tenant_isolation
  ON labor_shifts
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE labor_shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_shift_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labor_shift_assignments_tenant_isolation ON labor_shift_assignments;
CREATE POLICY labor_shift_assignments_tenant_isolation
  ON labor_shift_assignments
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE labor_productivity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_productivity_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labor_productivity_events_tenant_isolation ON labor_productivity_events;
CREATE POLICY labor_productivity_events_tenant_isolation
  ON labor_productivity_events
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

UPDATE tenant_settings
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object('labor', true),
    config_version = config_version + 1,
    updated_at = NOW()
WHERE company_id IS NOT NULL
  AND COALESCE((feature_flags ->> 'labor')::boolean, false) = false;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES
  ('labor.view', 'View Labor Metrics', 'View labor standards, shifts, and productivity dashboards'),
  ('labor.manage', 'Manage Labor Operations', 'Manage labor standards, shifts, and productivity records')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key IN ('labor.view', 'labor.manage')
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'WAREHOUSE_MANAGER', 'SUPERVISOR', 'OPERATIONS')
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = 'labor.view'
WHERE r.role_code IN ('OPERATOR', 'FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
