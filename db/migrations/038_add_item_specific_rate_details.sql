ALTER TABLE client_rate_details
  ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);

CREATE INDEX IF NOT EXISTS idx_crd_company_master_charge_item
  ON client_rate_details(company_id, rate_master_id, charge_type, item_id, is_active);

