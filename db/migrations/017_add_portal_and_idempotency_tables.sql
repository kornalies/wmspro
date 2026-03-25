BEGIN;

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  attachment_type VARCHAR(80) NOT NULL,
  reference_type VARCHAR(80) NOT NULL,
  reference_no VARCHAR(120) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(120),
  file_size_bytes BIGINT,
  remarks TEXT,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attachments_company_reference
  ON attachments(company_id, reference_type, reference_no);

CREATE TABLE IF NOT EXISTS portal_user_clients (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_clients_lookup
  ON portal_user_clients(company_id, user_id, client_id, is_active);

CREATE TABLE IF NOT EXISTS client_portal_asn_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  request_number VARCHAR(80) NOT NULL,
  expected_date DATE,
  remarks TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
  requested_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, request_number)
);

CREATE INDEX IF NOT EXISTS idx_client_portal_asn_company_client
  ON client_portal_asn_requests(company_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  key_hash VARCHAR(120) NOT NULL,
  route_key VARCHAR(160) NOT NULL,
  response_body JSONB NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 200,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, key_hash, route_key)
);

COMMIT;
