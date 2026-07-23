-- 061_add_invoice_payments_rls.sql
--
-- invoice_payments was created ad-hoc at runtime (ensurePaymentSchema in the payments
-- route) and NEVER had row-level security, unlike every other billing table which is
-- FORCE RLS. Tenant isolation therefore rested entirely on each query remembering an
-- explicit "AND company_id = $1" filter -- one omission would leak/corrupt across tenants
-- (migration 060's header comment already flagged this).
--
-- This migration (1) guarantees the table exists for fresh databases so it stops depending
-- on the runtime bootstrap, and (2) enables FORCE row-level security with the same
-- tenant-isolation policy the sibling billing tables use. All access paths already set
-- app.company_id: query() applies it per request inside its own transaction, and the
-- getClient()-based routes / ledger sync call setTenantContext before touching the table.

BEGIN;

CREATE TABLE IF NOT EXISTS invoice_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  invoice_id INTEGER NOT NULL REFERENCES invoice_header(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode VARCHAR(30),
  reference_no VARCHAR(120),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_invoice
  ON invoice_payments(company_id, invoice_id);

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_payments_tenant_isolation ON invoice_payments;
CREATE POLICY invoice_payments_tenant_isolation
  ON invoice_payments
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
