BEGIN;

CREATE TABLE IF NOT EXISTS integration_connectors (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  connector_code VARCHAR(60) NOT NULL,
  connector_name VARCHAR(150) NOT NULL,
  provider_type VARCHAR(20) NOT NULL,
  transport_type VARCHAR(20) NOT NULL,
  direction VARCHAR(20) NOT NULL DEFAULT 'BIDIRECTIONAL',
  endpoint_url TEXT,
  auth_type VARCHAR(20) NOT NULL DEFAULT 'NONE',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (timeout_seconds > 0 AND timeout_seconds <= 300),
  retry_limit INTEGER NOT NULL DEFAULT 3 CHECK (retry_limit >= 0 AND retry_limit <= 20),
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 60 CHECK (retry_backoff_seconds >= 5 AND retry_backoff_seconds <= 86400),
  dead_letter_after INTEGER NOT NULL DEFAULT 5 CHECK (dead_letter_after >= 1 AND dead_letter_after <= 50),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_connector_company_code UNIQUE (company_id, connector_code),
  CONSTRAINT ck_integration_connector_provider CHECK (provider_type IN ('EDI', 'CARRIER', 'ERP')),
  CONSTRAINT ck_integration_connector_transport CHECK (transport_type IN ('REST', 'SFTP', 'FTP', 'EMAIL', 'WEBHOOK')),
  CONSTRAINT ck_integration_connector_direction CHECK (direction IN ('INBOUND', 'OUTBOUND', 'BIDIRECTIONAL')),
  CONSTRAINT ck_integration_connector_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'ERROR')),
  CONSTRAINT ck_integration_connector_auth CHECK (auth_type IN ('NONE', 'API_KEY', 'BASIC', 'BEARER', 'OAUTH2'))
);

CREATE INDEX IF NOT EXISTS idx_integration_connectors_company_status
  ON integration_connectors(company_id, status, provider_type, connector_name);

CREATE TABLE IF NOT EXISTS integration_connector_credentials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  connector_id INTEGER NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  credential_key VARCHAR(80) NOT NULL,
  credential_value_encrypted TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_credential_key UNIQUE (company_id, connector_id, credential_key)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_company_connector
  ON integration_connector_credentials(company_id, connector_id, is_active);

CREATE TABLE IF NOT EXISTS integration_schema_mappings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  connector_id INTEGER NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL,
  direction VARCHAR(20) NOT NULL DEFAULT 'OUTBOUND',
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_mapping_version UNIQUE (company_id, connector_id, entity_type, direction, mapping_version),
  CONSTRAINT ck_integration_mapping_direction CHECK (direction IN ('INBOUND', 'OUTBOUND'))
);

CREATE INDEX IF NOT EXISTS idx_integration_mappings_company_connector_entity
  ON integration_schema_mappings(company_id, connector_id, entity_type, direction, is_active);

CREATE TABLE IF NOT EXISTS integration_mapping_fields (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  mapping_id INTEGER NOT NULL REFERENCES integration_schema_mappings(id) ON DELETE CASCADE,
  source_path VARCHAR(200) NOT NULL,
  target_path VARCHAR(200) NOT NULL,
  data_type VARCHAR(30) NOT NULL DEFAULT 'string',
  transform_rule VARCHAR(120),
  default_value TEXT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  sequence_no INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_mapping_field UNIQUE (mapping_id, source_path, target_path)
);

CREATE INDEX IF NOT EXISTS idx_integration_mapping_fields_mapping_seq
  ON integration_mapping_fields(mapping_id, sequence_no);

CREATE TABLE IF NOT EXISTS integration_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  connector_id INTEGER NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  mapping_id INTEGER REFERENCES integration_schema_mappings(id),
  direction VARCHAR(20) NOT NULL DEFAULT 'OUTBOUND',
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(120),
  idempotency_key VARCHAR(120),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_integration_event_direction CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  CONSTRAINT ck_integration_event_status CHECK (status IN ('QUEUED', 'PROCESSING', 'SUCCESS', 'RETRY', 'DEAD_LETTER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_event_idempotency
  ON integration_events(company_id, connector_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integration_events_company_status
  ON integration_events(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_events_retry
  ON integration_events(company_id, status, next_retry_at)
  WHERE status IN ('RETRY', 'DEAD_LETTER', 'QUEUED');

ALTER TABLE integration_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_connectors_tenant_isolation ON integration_connectors;
CREATE POLICY integration_connectors_tenant_isolation
  ON integration_connectors
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE integration_connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connector_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_connector_credentials_tenant_isolation ON integration_connector_credentials;
CREATE POLICY integration_connector_credentials_tenant_isolation
  ON integration_connector_credentials
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE integration_schema_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_schema_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_schema_mappings_tenant_isolation ON integration_schema_mappings;
CREATE POLICY integration_schema_mappings_tenant_isolation
  ON integration_schema_mappings
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE integration_mapping_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_mapping_fields FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_mapping_fields_tenant_isolation ON integration_mapping_fields;
CREATE POLICY integration_mapping_fields_tenant_isolation
  ON integration_mapping_fields
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_events_tenant_isolation ON integration_events;
CREATE POLICY integration_events_tenant_isolation
  ON integration_events
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

UPDATE tenant_settings
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object('integrations', true),
    config_version = config_version + 1,
    updated_at = NOW()
WHERE company_id IS NOT NULL
  AND COALESCE((feature_flags ->> 'integrations')::boolean, false) = false;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES
  ('integration.view', 'View Integrations', 'View integration connectors, mappings, and monitoring'),
  ('integration.manage', 'Manage Integrations', 'Manage integration connectors, credentials, mappings, and retries')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key IN ('integration.view', 'integration.manage')
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'WAREHOUSE_MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key = 'integration.view'
WHERE r.role_code IN ('SUPERVISOR')
ON CONFLICT DO NOTHING;

COMMIT;
