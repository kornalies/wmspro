BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(30) NOT NULL DEFAULT 'BASIC',
  ADD COLUMN IF NOT EXISTS storage_used_gb NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'TRIAL';

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_subscription_plan_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_subscription_plan_check
  CHECK (subscription_plan IN ('BASIC', 'PRO', 'ENTERPRISE'));

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_billing_status_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_billing_status_check
  CHECK (billing_status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'));

COMMIT;
