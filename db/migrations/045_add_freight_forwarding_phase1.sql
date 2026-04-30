BEGIN;

CREATE TABLE IF NOT EXISTS ff_shipments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shipment_no VARCHAR(40) NOT NULL,
  mode VARCHAR(12) NOT NULL,
  direction VARCHAR(12) NOT NULL DEFAULT 'EXPORT',
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  client_id INTEGER REFERENCES clients(id),
  shipper_name VARCHAR(160),
  consignee_name VARCHAR(160),
  incoterm VARCHAR(20),
  origin VARCHAR(120) NOT NULL,
  destination VARCHAR(120) NOT NULL,
  etd TIMESTAMPTZ,
  eta TIMESTAMPTZ,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ff_shipments_company_no UNIQUE (company_id, shipment_no)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_shipments_mode'
  ) THEN
    ALTER TABLE ff_shipments
      ADD CONSTRAINT ck_ff_shipments_mode
      CHECK (mode IN ('AIR', 'SEA', 'ROAD'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_shipments_direction'
  ) THEN
    ALTER TABLE ff_shipments
      ADD CONSTRAINT ck_ff_shipments_direction
      CHECK (direction IN ('IMPORT', 'EXPORT', 'DOMESTIC'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_shipments_status'
  ) THEN
    ALTER TABLE ff_shipments
      ADD CONSTRAINT ck_ff_shipments_status
      CHECK (status IN ('DRAFT', 'BOOKED', 'IN_TRANSIT', 'CUSTOMS_HOLD', 'ARRIVED', 'DELIVERED', 'CANCELLED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ff_shipments_company_status_mode
  ON ff_shipments(company_id, status, mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ff_shipments_company_client
  ON ff_shipments(company_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ff_shipment_legs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shipment_id INTEGER NOT NULL REFERENCES ff_shipments(id) ON DELETE CASCADE,
  leg_no INTEGER NOT NULL,
  transport_mode VARCHAR(12) NOT NULL,
  carrier_name VARCHAR(160),
  vessel_or_flight VARCHAR(120),
  voyage_or_flight_no VARCHAR(80),
  from_location VARCHAR(120) NOT NULL,
  to_location VARCHAR(120) NOT NULL,
  etd TIMESTAMPTZ,
  eta TIMESTAMPTZ,
  atd TIMESTAMPTZ,
  ata TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ff_shipment_legs_company_shipment_leg UNIQUE (company_id, shipment_id, leg_no)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_shipment_legs_mode'
  ) THEN
    ALTER TABLE ff_shipment_legs
      ADD CONSTRAINT ck_ff_shipment_legs_mode
      CHECK (transport_mode IN ('AIR', 'SEA', 'ROAD'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_shipment_legs_status'
  ) THEN
    ALTER TABLE ff_shipment_legs
      ADD CONSTRAINT ck_ff_shipment_legs_status
      CHECK (status IN ('PLANNED', 'BOOKED', 'DEPARTED', 'ARRIVED', 'CANCELLED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ff_shipment_legs_company_shipment
  ON ff_shipment_legs(company_id, shipment_id, leg_no);

CREATE TABLE IF NOT EXISTS ff_milestones (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shipment_id INTEGER NOT NULL REFERENCES ff_shipments(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  planned_at TIMESTAMPTZ,
  actual_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_milestones_status'
  ) THEN
    ALTER TABLE ff_milestones
      ADD CONSTRAINT ck_ff_milestones_status
      CHECK (status IN ('PENDING', 'COMPLETED', 'DELAYED', 'CANCELLED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ff_milestones_company_shipment
  ON ff_milestones(company_id, shipment_id, planned_at);

CREATE TABLE IF NOT EXISTS ff_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  shipment_id INTEGER NOT NULL REFERENCES ff_shipments(id) ON DELETE CASCADE,
  doc_type VARCHAR(24) NOT NULL,
  doc_no VARCHAR(120) NOT NULL,
  issue_date DATE,
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  is_master BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ff_documents_company_shipment_doc UNIQUE (company_id, shipment_id, doc_type, doc_no)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ff_documents_doc_type'
  ) THEN
    ALTER TABLE ff_documents
      ADD CONSTRAINT ck_ff_documents_doc_type
      CHECK (doc_type IN ('HAWB', 'MAWB', 'HBL', 'MBL', 'INVOICE', 'PACKING_LIST', 'COO', 'BOE', 'OTHER'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ff_documents_company_shipment
  ON ff_documents(company_id, shipment_id, doc_type);

INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
VALUES
  ('freight.view', 'View Freight Shipments', true),
  ('freight.manage', 'Manage Freight Shipments', true),
  ('freight.docs.manage', 'Manage Freight Documents', true),
  ('freight.milestone.update', 'Update Freight Milestones', true)
ON CONFLICT (permission_key)
DO UPDATE SET
  permission_name = EXCLUDED.permission_name,
  is_active = true;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
JOIN rbac_permissions p ON p.permission_key IN (
  'freight.view',
  'freight.manage',
  'freight.docs.manage',
  'freight.milestone.update'
)
WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'WAREHOUSE_MANAGER', 'MANAGER')
ON CONFLICT DO NOTHING;

COMMIT;
