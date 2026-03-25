BEGIN;

CREATE TABLE IF NOT EXISTS client_contracts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  contract_code VARCHAR(50) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  storage_rate_per_unit NUMERIC(12,2) NOT NULL DEFAULT 0,
  handling_rate_per_unit NUMERIC(12,2) NOT NULL DEFAULT 0,
  minimum_guarantee_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_client_contracts_company_contract_code UNIQUE (company_id, contract_code),
  CONSTRAINT ck_client_contracts_billing_cycle CHECK (billing_cycle IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  CONSTRAINT ck_client_contracts_date_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_client_contracts_company_client_active
  ON client_contracts(company_id, client_id, is_active);

CREATE INDEX IF NOT EXISTS idx_client_contracts_effective_from
  ON client_contracts(effective_from DESC);

ALTER TABLE client_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_contracts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_contracts_tenant_isolation ON client_contracts;
CREATE POLICY client_contracts_tenant_isolation
  ON client_contracts
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
