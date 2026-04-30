BEGIN;

CREATE TABLE IF NOT EXISTS tenant_products (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_code VARCHAR(16) NOT NULL,
  plan_code VARCHAR(40) NOT NULL DEFAULT 'STANDARD',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  starts_at TIMESTAMPTZ NULL,
  ends_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER NULL REFERENCES users(id),
  updated_by INTEGER NULL REFERENCES users(id),
  CONSTRAINT uq_tenant_products_company_product UNIQUE (company_id, product_code)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_tenant_products_code'
  ) THEN
    ALTER TABLE tenant_products
      ADD CONSTRAINT ck_tenant_products_code
      CHECK (product_code IN ('WMS', 'FF'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_tenant_products_status'
  ) THEN
    ALTER TABLE tenant_products
      ADD CONSTRAINT ck_tenant_products_status
      CHECK (status IN ('ACTIVE', 'TRIAL', 'INACTIVE', 'SUSPENDED'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_tenant_products_date_window'
  ) THEN
    ALTER TABLE tenant_products
      ADD CONSTRAINT ck_tenant_products_date_window
      CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_products_company_status
  ON tenant_products (company_id, status, product_code);

CREATE INDEX IF NOT EXISTS idx_tenant_products_company_product
  ON tenant_products (company_id, product_code);

INSERT INTO tenant_products (company_id, product_code, plan_code, status)
SELECT c.id, 'WMS', 'STANDARD', 'ACTIVE'
FROM companies c
WHERE c.is_active = true
ON CONFLICT (company_id, product_code) DO UPDATE
SET
  status = EXCLUDED.status,
  updated_at = NOW();

COMMIT;
