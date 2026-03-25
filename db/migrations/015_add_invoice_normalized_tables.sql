BEGIN;

CREATE TABLE IF NOT EXISTS billing_invoice_seq (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  last_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_number VARCHAR(80) NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  billing_period VARCHAR(30),
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  draft_run_key VARCHAR(120),
  finalized_at TIMESTAMP,
  finalized_by INTEGER REFERENCES users(id),
  sent_at TIMESTAMP,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_invoice_header_company_number UNIQUE (company_id, invoice_number),
  CONSTRAINT uq_invoice_header_company_client_period UNIQUE (company_id, client_id, period_from, period_to),
  CONSTRAINT ck_ih_billing_cycle CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY')),
  CONSTRAINT ck_ih_status CHECK (status IN ('DRAFT', 'FINALIZED', 'SENT', 'PAID', 'VOID')),
  CONSTRAINT ck_ih_period CHECK (period_to >= period_from),
  CONSTRAINT ck_ih_amounts CHECK (
    taxable_amount >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND
    total_tax_amount >= 0 AND grand_total >= 0 AND paid_amount >= 0 AND balance_amount >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_ih_company_client_date
  ON invoice_header(company_id, client_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_ih_company_status_date
  ON invoice_header(company_id, status, invoice_date DESC);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  charge_type VARCHAR(30) NOT NULL,
  description TEXT NOT NULL,
  source_type VARCHAR(20),
  source_doc_id INTEGER,
  source_line_id INTEGER,
  source_ref_no VARCHAR(120),
  period_from DATE,
  period_to DATE,
  uom VARCHAR(20) NOT NULL DEFAULT 'UNIT',
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_code VARCHAR(30) NOT NULL DEFAULT 'GST',
  gst_rate NUMERIC(6,3) NOT NULL DEFAULT 18,
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_invoice_lines_invoice_line_no UNIQUE (invoice_id, line_no),
  CONSTRAINT ck_il_charge_type CHECK (
    charge_type IN ('INBOUND_HANDLING', 'OUTBOUND_HANDLING', 'STORAGE', 'VAS', 'FIXED', 'MINIMUM', 'ADJUSTMENT')
  ),
  CONSTRAINT ck_il_source_type CHECK (
    source_type IS NULL OR source_type IN ('GRN', 'DO', 'VAS', 'STORAGE', 'MANUAL')
  ),
  CONSTRAINT ck_il_amounts CHECK (
    quantity >= 0 AND rate >= 0 AND amount >= 0 AND
    gst_rate >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND
    total_tax_amount >= 0 AND gross_amount >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_il_company_invoice
  ON invoice_lines(company_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_il_company_source
  ON invoice_lines(company_id, source_type, source_doc_id);

CREATE TABLE IF NOT EXISTS invoice_tax_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id) ON DELETE CASCADE,
  invoice_line_id INTEGER REFERENCES invoice_lines(id) ON DELETE CASCADE,
  tax_type VARCHAR(20) NOT NULL,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_itl_tax_type CHECK (tax_type IN ('CGST', 'SGST', 'IGST', 'CESS', 'OTHER')),
  CONSTRAINT ck_itl_amounts CHECK (tax_rate >= 0 AND taxable_amount >= 0 AND tax_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_itl_company_invoice
  ON invoice_tax_lines(company_id, invoice_id);

ALTER TABLE billing_transactions
  ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoice_header(id);

CREATE INDEX IF NOT EXISTS idx_bt_company_invoice
  ON billing_transactions(company_id, invoice_id);

ALTER TABLE invoice_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_header_tenant_isolation ON invoice_header;
CREATE POLICY invoice_header_tenant_isolation
  ON invoice_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_lines_tenant_isolation ON invoice_lines;
CREATE POLICY invoice_lines_tenant_isolation
  ON invoice_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE invoice_tax_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_tax_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_tax_lines_tenant_isolation ON invoice_tax_lines;
CREATE POLICY invoice_tax_lines_tenant_isolation
  ON invoice_tax_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE billing_invoice_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_invoice_seq_tenant_isolation ON billing_invoice_seq;
CREATE POLICY billing_invoice_seq_tenant_isolation
  ON billing_invoice_seq
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
