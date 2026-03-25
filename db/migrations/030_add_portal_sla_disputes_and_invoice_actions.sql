BEGIN;

CREATE TABLE IF NOT EXISTS portal_client_sla_policies (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  dispatch_target_hours NUMERIC(8,2) NOT NULL DEFAULT 48 CHECK (dispatch_target_hours > 0),
  invoice_approval_due_days INTEGER NOT NULL DEFAULT 5 CHECK (invoice_approval_due_days >= 0),
  dispute_resolution_hours NUMERIC(8,2) NOT NULL DEFAULT 72 CHECK (dispute_resolution_hours > 0),
  warning_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 90 CHECK (warning_threshold_pct > 0 AND warning_threshold_pct <= 200),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_sla_company_client UNIQUE (company_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_sla_company_client_active
  ON portal_client_sla_policies(company_id, client_id, is_active);

ALTER TABLE invoice_header
  ADD COLUMN IF NOT EXISTS client_action_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS client_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_last_action_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_invoice_header_client_action_status'
  ) THEN
    ALTER TABLE invoice_header
      ADD CONSTRAINT ck_invoice_header_client_action_status
      CHECK (client_action_status IN ('PENDING', 'APPROVED', 'DISPUTED', 'PARTIALLY_PAID', 'PAID'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS portal_invoice_disputes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id) ON DELETE CASCADE,
  dispute_number VARCHAR(80) NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'BILLING_AMOUNT',
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  dispute_reason TEXT NOT NULL,
  dispute_amount NUMERIC(14,2),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  raised_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  resolution_notes TEXT,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_dispute_company_number UNIQUE (company_id, dispute_number),
  CONSTRAINT ck_portal_dispute_category CHECK (category IN ('BILLING_AMOUNT', 'SERVICE_QUALITY', 'MISSING_DOCS', 'OTHER')),
  CONSTRAINT ck_portal_dispute_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT ck_portal_dispute_status CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_portal_disputes_company_client_status
  ON portal_invoice_disputes(company_id, client_id, status, raised_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_disputes_company_invoice
  ON portal_invoice_disputes(company_id, invoice_id, raised_at DESC);

CREATE TABLE IF NOT EXISTS portal_invoice_dispute_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  dispute_id INTEGER NOT NULL REFERENCES portal_invoice_disputes(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL DEFAULT 'COMMENT',
  from_status VARCHAR(20),
  to_status VARCHAR(20),
  comment TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_portal_dispute_event_type CHECK (event_type IN ('CREATED', 'STATUS_CHANGE', 'COMMENT', 'ATTACHMENT'))
);

CREATE INDEX IF NOT EXISTS idx_portal_dispute_events_company_dispute
  ON portal_invoice_dispute_events(company_id, dispute_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portal_invoice_actions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id) ON DELETE CASCADE,
  action_type VARCHAR(20) NOT NULL,
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_portal_invoice_action_type CHECK (action_type IN ('APPROVE', 'DISPUTE', 'PAY', 'COMMENT'))
);

CREATE INDEX IF NOT EXISTS idx_portal_invoice_actions_company_invoice
  ON portal_invoice_actions(company_id, invoice_id, created_at DESC);

ALTER TABLE portal_client_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_client_sla_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_client_sla_policies_tenant_isolation ON portal_client_sla_policies;
CREATE POLICY portal_client_sla_policies_tenant_isolation
  ON portal_client_sla_policies
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE portal_invoice_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invoice_disputes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_invoice_disputes_tenant_isolation ON portal_invoice_disputes;
CREATE POLICY portal_invoice_disputes_tenant_isolation
  ON portal_invoice_disputes
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE portal_invoice_dispute_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invoice_dispute_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_invoice_dispute_events_tenant_isolation ON portal_invoice_dispute_events;
CREATE POLICY portal_invoice_dispute_events_tenant_isolation
  ON portal_invoice_dispute_events
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE portal_invoice_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invoice_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_invoice_actions_tenant_isolation ON portal_invoice_actions;
CREATE POLICY portal_invoice_actions_tenant_isolation
  ON portal_invoice_actions
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES
  ('portal.sla.view', 'View Portal SLA', 'View portal SLA policy and KPI'),
  ('portal.sla.manage', 'Manage Portal SLA', 'Create and update portal SLA policy'),
  ('portal.dispute.create', 'Create Portal Dispute', 'Raise invoice disputes from portal'),
  ('portal.dispute.manage', 'Manage Portal Dispute', 'Review and resolve portal disputes'),
  ('portal.billing.action', 'Portal Invoice Actions', 'Approve/dispute/pay invoice from portal')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p
  ON p.permission_key IN ('portal.sla.view', 'portal.sla.manage', 'portal.dispute.create', 'portal.dispute.manage', 'portal.billing.action')
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p
  ON p.permission_key IN ('portal.sla.view', 'portal.dispute.create', 'portal.billing.action')
WHERE r.role_code IN ('CLIENT', 'VIEWER')
ON CONFLICT DO NOTHING;

COMMIT;
