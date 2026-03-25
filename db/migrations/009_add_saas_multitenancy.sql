-- SaaS multitenancy foundation for shared-database model.
-- Strategy:
-- 1) Introduce companies table.
-- 2) Add company_id to tenant-owned tables.
-- 3) Backfill all existing rows to a default company.
-- 4) Enforce FK + NOT NULL + scoped uniques.
-- 5) Enable RLS isolation by current_setting('app.company_id').

BEGIN;

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_code VARCHAR(50) NOT NULL UNIQUE,
  company_name VARCHAR(150) NOT NULL,
  domain VARCHAR(150),
  storage_bucket VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO companies (company_code, company_name, storage_bucket, is_active)
SELECT 'DEFAULT', 'Default Company', 'default', true
WHERE NOT EXISTS (SELECT 1 FROM companies);

DO $$
DECLARE
  tenant_tables text[] := ARRAY[
    'users',
    'clients',
    'warehouses',
    'items',
    'asn_header',
    'asn_line_items',
    'asn_carton_details',
    'client_contacts',
    'client_documents',
    'customer_label_templates',
    'daily_kpi_summary',
    'do_header',
    'do_line_items',
    'edi_transactions',
    'gate_in',
    'gate_out',
    'grn_header',
    'grn_line_items',
    'item_categories',
    'mobile_grn_captures',
    'printed_labels_log',
    'sequence_counters',
    'stock_movements',
    'stock_putaway_movements',
    'stock_serial_numbers',
    'system_settings',
    'warehouse_zone_layouts',
    'warehouse_zones',
    'workforce_tasks'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tenant_tables
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER',
      t
    );
    EXECUTE format(
      'UPDATE %I SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)',
      t, t || '_company_fk'
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I(company_id)',
      'idx_' || t || '_company_id', t
    );
  END LOOP;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

-- Scope global uniques by company
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_company_username ON users(company_id, username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_company_email ON users(company_id, email);

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_client_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_company_code ON clients(company_id, client_code);

ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_warehouse_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_company_code ON warehouses(company_id, warehouse_code);

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_company_code ON items(company_id, item_code);

ALTER TABLE grn_header DROP CONSTRAINT IF EXISTS grn_header_grn_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_grn_header_company_grn_number ON grn_header(company_id, grn_number);

ALTER TABLE do_header DROP CONSTRAINT IF EXISTS do_header_do_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_do_header_company_do_number ON do_header(company_id, do_number);

ALTER TABLE gate_in DROP CONSTRAINT IF EXISTS gate_in_gate_in_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_in_company_number ON gate_in(company_id, gate_in_number);

ALTER TABLE gate_out DROP CONSTRAINT IF EXISTS gate_out_gate_out_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_out_company_number ON gate_out(company_id, gate_out_number);

ALTER TABLE asn_header DROP CONSTRAINT IF EXISTS asn_header_asn_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_asn_header_company_asn_number ON asn_header(company_id, asn_number);

ALTER TABLE mobile_grn_captures DROP CONSTRAINT IF EXISTS mobile_grn_captures_capture_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_grn_capture_company_ref ON mobile_grn_captures(company_id, capture_ref);

-- RLS policies
DO $$
DECLARE
  rls_tables text[] := ARRAY[
    'clients','warehouses','items','asn_header','asn_line_items','asn_carton_details',
    'client_contacts','client_documents','customer_label_templates','daily_kpi_summary',
    'do_header','do_line_items','edi_transactions','gate_in','gate_out','grn_header',
    'grn_line_items','item_categories','mobile_grn_captures','printed_labels_log',
    'sequence_counters','stock_movements','stock_putaway_movements','stock_serial_numbers',
    'system_settings','warehouse_zone_layouts','warehouse_zones','workforce_tasks'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY rls_tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER) WITH CHECK (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
