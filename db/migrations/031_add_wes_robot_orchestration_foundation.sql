BEGIN;

CREATE TABLE IF NOT EXISTS wes_equipment (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  equipment_code VARCHAR(60) NOT NULL,
  equipment_name VARCHAR(150) NOT NULL,
  equipment_type VARCHAR(30) NOT NULL,
  adapter_type VARCHAR(30) NOT NULL DEFAULT 'MOCK',
  warehouse_id INTEGER REFERENCES warehouses(id),
  zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id),
  status VARCHAR(20) NOT NULL DEFAULT 'IDLE',
  safety_mode BOOLEAN NOT NULL DEFAULT FALSE,
  heartbeat_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (heartbeat_timeout_seconds BETWEEN 10 AND 600),
  last_heartbeat_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wes_equipment_company_code UNIQUE (company_id, equipment_code),
  CONSTRAINT ck_wes_equipment_type CHECK (equipment_type IN ('AMR', 'CONVEYOR', 'SORTER', 'ASRS', 'SHUTTLE', 'PICK_ARM', 'OTHER')),
  CONSTRAINT ck_wes_adapter_type CHECK (adapter_type IN ('MOCK', 'REST', 'MQTT', 'PLC', 'OPCUA')),
  CONSTRAINT ck_wes_equipment_status CHECK (status IN ('OFFLINE', 'IDLE', 'READY', 'BUSY', 'CHARGING', 'PAUSED', 'FAULT', 'ESTOP'))
);

CREATE INDEX IF NOT EXISTS idx_wes_equipment_company_status
  ON wes_equipment(company_id, warehouse_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS wes_command_queue (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES wes_equipment(id) ON DELETE CASCADE,
  command_type VARCHAR(40) NOT NULL,
  command_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id VARCHAR(120),
  requested_by INTEGER REFERENCES users(id),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_wes_command_status CHECK (status IN ('QUEUED', 'DISPATCHING', 'ACKED', 'DONE', 'RETRY', 'DEAD_LETTER', 'CANCELLED')),
  CONSTRAINT ck_wes_command_type CHECK (command_type IN ('MOVE', 'PICK', 'DROP', 'CHARGE', 'PAUSE', 'RESUME', 'RESET', 'ESTOP', 'CUSTOM'))
);

CREATE INDEX IF NOT EXISTS idx_wes_command_queue_company_status
  ON wes_command_queue(company_id, status, priority ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_wes_command_queue_retry
  ON wes_command_queue(company_id, status, next_attempt_at)
  WHERE status IN ('RETRY', 'QUEUED');

CREATE TABLE IF NOT EXISTS wes_event_log (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  equipment_id INTEGER REFERENCES wes_equipment(id) ON DELETE SET NULL,
  command_id BIGINT REFERENCES wes_command_queue(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type VARCHAR(20) NOT NULL DEFAULT 'SYSTEM',
  source_ref VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_wes_event_type CHECK (event_type IN ('HEARTBEAT', 'STATUS', 'COMMAND_ACCEPTED', 'COMMAND_FAILED', 'COMMAND_DONE', 'SAFETY_TRIP', 'FAILOVER', 'ALARM', 'CUSTOM')),
  CONSTRAINT ck_wes_event_source CHECK (source_type IN ('SYSTEM', 'ADAPTER', 'OPERATOR', 'DEVICE'))
);

CREATE INDEX IF NOT EXISTS idx_wes_event_log_company_created
  ON wes_event_log(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wes_failover_incidents (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  equipment_id INTEGER REFERENCES wes_equipment(id) ON DELETE SET NULL,
  command_id BIGINT REFERENCES wes_command_queue(id) ON DELETE SET NULL,
  incident_type VARCHAR(30) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'HIGH',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  reason TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id),
  resolution_notes TEXT,
  CONSTRAINT ck_wes_incident_type CHECK (incident_type IN ('COMMAND_RETRY_EXHAUSTED', 'HEARTBEAT_TIMEOUT', 'SAFETY_TRIP', 'STATE_MACHINE_GUARD', 'ADAPTER_FAILURE')),
  CONSTRAINT ck_wes_incident_severity CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT ck_wes_incident_status CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_wes_failover_company_status
  ON wes_failover_incidents(company_id, status, opened_at DESC);

ALTER TABLE wes_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE wes_equipment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wes_equipment_tenant_isolation ON wes_equipment;
CREATE POLICY wes_equipment_tenant_isolation
  ON wes_equipment
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE wes_command_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE wes_command_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wes_command_queue_tenant_isolation ON wes_command_queue;
CREATE POLICY wes_command_queue_tenant_isolation
  ON wes_command_queue
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE wes_event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE wes_event_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wes_event_log_tenant_isolation ON wes_event_log;
CREATE POLICY wes_event_log_tenant_isolation
  ON wes_event_log
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE wes_failover_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wes_failover_incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wes_failover_incidents_tenant_isolation ON wes_failover_incidents;
CREATE POLICY wes_failover_incidents_tenant_isolation
  ON wes_failover_incidents
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

UPDATE tenant_settings
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object('wes', true),
    config_version = config_version + 1,
    updated_at = NOW()
WHERE company_id IS NOT NULL
  AND COALESCE((feature_flags ->> 'wes')::boolean, false) = false;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES
  ('wes.view', 'View WES Orchestration', 'View equipment states, queues, and failover incidents'),
  ('wes.manage', 'Manage WES Orchestration', 'Dispatch commands, process queue, and manage safety/failover')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key IN ('wes.view', 'wes.manage')
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'WAREHOUSE_MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = 'wes.view'
WHERE r.role_code IN ('SUPERVISOR')
ON CONFLICT DO NOTHING;

COMMIT;
