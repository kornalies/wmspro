ALTER TABLE client_billing_profile
  DROP CONSTRAINT IF EXISTS ck_cbp_billing_cycle;

ALTER TABLE client_billing_profile
  ADD CONSTRAINT ck_cbp_billing_cycle
  CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'));

ALTER TABLE client_rate_master
  DROP CONSTRAINT IF EXISTS ck_crm_billing_cycle;

ALTER TABLE client_rate_master
  ADD CONSTRAINT ck_crm_billing_cycle
  CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'));

ALTER TABLE invoice_header
  DROP CONSTRAINT IF EXISTS ck_ih_billing_cycle;

ALTER TABLE invoice_header
  ADD CONSTRAINT ck_ih_billing_cycle
  CHECK (billing_cycle IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'));

