BEGIN;

CREATE TABLE IF NOT EXISTS credit_note_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  note_number VARCHAR(80) NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  note_date DATE NOT NULL,
  reason TEXT NOT NULL,
  taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_cnh_company_note_number UNIQUE (company_id, note_number),
  CONSTRAINT ck_cnh_status CHECK (status IN ('ISSUED', 'APPLIED', 'VOID')),
  CONSTRAINT ck_cnh_amounts CHECK (
    taxable_amount >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND total_tax_amount >= 0 AND grand_total >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_cnh_company_invoice
  ON credit_note_header(company_id, invoice_id, note_date DESC);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  credit_note_id INTEGER NOT NULL REFERENCES credit_note_header(id) ON DELETE CASCADE,
  invoice_line_id INTEGER REFERENCES invoice_lines(id),
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  CONSTRAINT uq_cnl_note_line UNIQUE (credit_note_id, line_no),
  CONSTRAINT ck_cnl_amounts CHECK (
    quantity >= 0 AND rate >= 0 AND amount >= 0 AND tax_rate >= 0 AND tax_amount >= 0 AND gross_amount >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_cnl_company_credit_note
  ON credit_note_lines(company_id, credit_note_id);

CREATE TABLE IF NOT EXISTS debit_note_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  note_number VARCHAR(80) NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  note_date DATE NOT NULL,
  reason TEXT NOT NULL,
  taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_dnh_company_note_number UNIQUE (company_id, note_number),
  CONSTRAINT ck_dnh_status CHECK (status IN ('ISSUED', 'APPLIED', 'VOID')),
  CONSTRAINT ck_dnh_amounts CHECK (
    taxable_amount >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND total_tax_amount >= 0 AND grand_total >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_dnh_company_invoice
  ON debit_note_header(company_id, invoice_id, note_date DESC);

CREATE TABLE IF NOT EXISTS debit_note_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  debit_note_id INTEGER NOT NULL REFERENCES debit_note_header(id) ON DELETE CASCADE,
  invoice_line_id INTEGER REFERENCES invoice_lines(id),
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  CONSTRAINT uq_dnl_note_line UNIQUE (debit_note_id, line_no),
  CONSTRAINT ck_dnl_amounts CHECK (
    quantity >= 0 AND rate >= 0 AND amount >= 0 AND tax_rate >= 0 AND tax_amount >= 0 AND gross_amount >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_dnl_company_debit_note
  ON debit_note_lines(company_id, debit_note_id);

ALTER TABLE credit_note_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_note_header_tenant_isolation ON credit_note_header;
CREATE POLICY credit_note_header_tenant_isolation
  ON credit_note_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_note_lines_tenant_isolation ON credit_note_lines;
CREATE POLICY credit_note_lines_tenant_isolation
  ON credit_note_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE debit_note_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE debit_note_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debit_note_header_tenant_isolation ON debit_note_header;
CREATE POLICY debit_note_header_tenant_isolation
  ON debit_note_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE debit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE debit_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debit_note_lines_tenant_isolation ON debit_note_lines;
CREATE POLICY debit_note_lines_tenant_isolation
  ON debit_note_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
