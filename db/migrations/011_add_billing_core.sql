BEGIN;

CREATE TABLE IF NOT EXISTS client_billing_profile (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  billing_day_of_week SMALLINT,
  billing_day_of_month SMALLINT NOT NULL DEFAULT 1,
  storage_billing_method VARCHAR(20) NOT NULL DEFAULT 'SNAPSHOT',
  storage_grace_days INTEGER NOT NULL DEFAULT 0,
  credit_days INTEGER NOT NULL DEFAULT 30,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'INV',
  minimum_billing_enabled BOOLEAN NOT NULL DEFAULT false,
  minimum_billing_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  auto_finalize BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_client_billing_profile_company_client UNIQUE (company_id, client_id),
  CONSTRAINT ck_cbp_billing_cycle CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY')),
  CONSTRAINT ck_cbp_day_of_week CHECK (billing_day_of_week IS NULL OR billing_day_of_week BETWEEN 1 AND 7),
  CONSTRAINT ck_cbp_day_of_month CHECK (billing_day_of_month BETWEEN 1 AND 28),
  CONSTRAINT ck_cbp_storage_method CHECK (storage_billing_method IN ('SNAPSHOT', 'DURATION')),
  CONSTRAINT ck_cbp_storage_grace CHECK (storage_grace_days >= 0),
  CONSTRAINT ck_cbp_credit_days CHECK (credit_days >= 0),
  CONSTRAINT ck_cbp_min_amount CHECK (minimum_billing_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cbp_company_client_active
  ON client_billing_profile(company_id, client_id, is_active);

CREATE TABLE IF NOT EXISTS client_rate_master (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  rate_card_code VARCHAR(50) NOT NULL,
  rate_card_name VARCHAR(120) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  tax_inclusive BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_crm_company_client_code UNIQUE (company_id, client_id, rate_card_code),
  CONSTRAINT ck_crm_billing_cycle CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY')),
  CONSTRAINT ck_crm_priority CHECK (priority >= 0),
  CONSTRAINT ck_crm_date_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_crm_company_client_active_dates
  ON client_rate_master(company_id, client_id, is_active, effective_from DESC);

CREATE TABLE IF NOT EXISTS client_rate_details (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  rate_master_id INTEGER NOT NULL REFERENCES client_rate_master(id) ON DELETE CASCADE,
  charge_type VARCHAR(30) NOT NULL,
  calc_method VARCHAR(20) NOT NULL DEFAULT 'PER_UNIT',
  uom VARCHAR(20) NOT NULL DEFAULT 'UNIT',
  min_qty NUMERIC(14,3),
  max_qty NUMERIC(14,3),
  free_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_rate NUMERIC(14,4) NOT NULL DEFAULT 0,
  min_charge NUMERIC(14,2) NOT NULL DEFAULT 0,
  max_charge NUMERIC(14,2),
  tax_code VARCHAR(30) NOT NULL DEFAULT 'GST',
  gst_rate NUMERIC(6,3) NOT NULL DEFAULT 18,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_crd_charge_type CHECK (
    charge_type IN ('INBOUND_HANDLING', 'OUTBOUND_HANDLING', 'STORAGE', 'VAS', 'FIXED', 'MINIMUM')
  ),
  CONSTRAINT ck_crd_calc_method CHECK (calc_method IN ('FLAT', 'PER_UNIT', 'SLAB', 'PERCENT')),
  CONSTRAINT ck_crd_qty_range CHECK (
    (min_qty IS NULL OR min_qty >= 0) AND
    (max_qty IS NULL OR max_qty >= 0) AND
    (max_qty IS NULL OR min_qty IS NULL OR max_qty >= min_qty)
  ),
  CONSTRAINT ck_crd_amounts CHECK (
    free_qty >= 0 AND unit_rate >= 0 AND min_charge >= 0 AND (max_charge IS NULL OR max_charge >= 0)
  ),
  CONSTRAINT ck_crd_gst_rate CHECK (gst_rate >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crd_company_master_charge_slab
  ON client_rate_details(
    company_id,
    rate_master_id,
    charge_type,
    uom,
    COALESCE(min_qty, 0),
    COALESCE(max_qty, 999999999)
  );

CREATE INDEX IF NOT EXISTS idx_crd_company_master_active
  ON client_rate_details(company_id, rate_master_id, is_active);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  charge_type VARCHAR(30) NOT NULL,
  source_type VARCHAR(20) NOT NULL,
  source_doc_id INTEGER,
  source_line_id INTEGER,
  source_ref_no VARCHAR(120),
  event_date DATE NOT NULL,
  period_from DATE,
  period_to DATE,
  uom VARCHAR(20) NOT NULL DEFAULT 'UNIT',
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  tax_code VARCHAR(30) NOT NULL DEFAULT 'GST',
  gst_rate NUMERIC(6,3) NOT NULL DEFAULT 18,
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'UNBILLED',
  billed_at TIMESTAMP,
  billed_by INTEGER REFERENCES users(id),
  rate_master_id INTEGER REFERENCES client_rate_master(id),
  rate_detail_id INTEGER REFERENCES client_rate_details(id),
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_bt_charge_type CHECK (
    charge_type IN ('INBOUND_HANDLING', 'OUTBOUND_HANDLING', 'STORAGE', 'VAS', 'FIXED', 'MINIMUM', 'ADJUSTMENT')
  ),
  CONSTRAINT ck_bt_source_type CHECK (
    source_type IN ('GRN', 'DO', 'VAS', 'STORAGE', 'MANUAL')
  ),
  CONSTRAINT ck_bt_status CHECK (
    status IN ('UNBILLED', 'BILLED', 'VOID')
  ),
  CONSTRAINT ck_bt_qty_rate_amount CHECK (
    quantity >= 0 AND rate >= 0 AND amount >= 0
  ),
  CONSTRAINT ck_bt_tax_non_negative CHECK (
    gst_rate >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND total_tax_amount >= 0 AND gross_amount >= 0
  ),
  CONSTRAINT ck_bt_period_range CHECK (
    period_to IS NULL OR period_from IS NULL OR period_to >= period_from
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_company_event_key
  ON billing_transactions(
    company_id,
    source_type,
    COALESCE(source_doc_id, 0),
    COALESCE(source_line_id, 0),
    charge_type,
    event_date,
    COALESCE(period_from, event_date),
    COALESCE(period_to, event_date)
  );

CREATE INDEX IF NOT EXISTS idx_bt_company_status_event_date
  ON billing_transactions(company_id, status, event_date);

CREATE INDEX IF NOT EXISTS idx_bt_company_client_event_date
  ON billing_transactions(company_id, client_id, event_date);

CREATE INDEX IF NOT EXISTS idx_bt_company_charge_type
  ON billing_transactions(company_id, charge_type);

CREATE TABLE IF NOT EXISTS storage_snapshot (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  snapshot_date DATE NOT NULL,
  item_id INTEGER REFERENCES items(id),
  uom VARCHAR(20) NOT NULL DEFAULT 'UNIT',
  units_in_stock INTEGER NOT NULL DEFAULT 0,
  pallets_in_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  volume_cbm NUMERIC(14,3) NOT NULL DEFAULT 0,
  weight_kg NUMERIC(14,3) NOT NULL DEFAULT 0,
  storage_days INTEGER NOT NULL DEFAULT 1,
  source_mode VARCHAR(20) NOT NULL DEFAULT 'SNAPSHOT',
  job_run_ref VARCHAR(120),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_ss_source_mode CHECK (source_mode IN ('SNAPSHOT', 'DURATION')),
  CONSTRAINT ck_ss_non_negative CHECK (
    units_in_stock >= 0 AND pallets_in_stock >= 0 AND volume_cbm >= 0 AND weight_kg >= 0 AND storage_days >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ss_company_daily_grain
  ON storage_snapshot(
    company_id,
    client_id,
    warehouse_id,
    snapshot_date,
    COALESCE(item_id, 0)
  );

CREATE INDEX IF NOT EXISTS idx_ss_company_client_date
  ON storage_snapshot(company_id, client_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_ss_company_warehouse_date
  ON storage_snapshot(company_id, warehouse_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS billing_job_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  job_type VARCHAR(40) NOT NULL,
  run_key VARCHAR(120) NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id),
  CONSTRAINT uq_bjr_company_job_key UNIQUE (company_id, job_type, run_key),
  CONSTRAINT ck_bjr_status CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS idx_bjr_company_job_started
  ON billing_job_runs(company_id, job_type, started_at DESC);

ALTER TABLE client_billing_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_billing_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_billing_profile_tenant_isolation ON client_billing_profile;
CREATE POLICY client_billing_profile_tenant_isolation
  ON client_billing_profile
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE client_rate_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_rate_master FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_rate_master_tenant_isolation ON client_rate_master;
CREATE POLICY client_rate_master_tenant_isolation
  ON client_rate_master
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE client_rate_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_rate_details FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_rate_details_tenant_isolation ON client_rate_details;
CREATE POLICY client_rate_details_tenant_isolation
  ON client_rate_details
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_transactions_tenant_isolation ON billing_transactions;
CREATE POLICY billing_transactions_tenant_isolation
  ON billing_transactions
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE storage_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_snapshot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS storage_snapshot_tenant_isolation ON storage_snapshot;
CREATE POLICY storage_snapshot_tenant_isolation
  ON storage_snapshot
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE billing_job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_job_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_job_runs_tenant_isolation ON billing_job_runs;
CREATE POLICY billing_job_runs_tenant_isolation
  ON billing_job_runs
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
