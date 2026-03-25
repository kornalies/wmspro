ALTER TABLE client_rate_details
  ADD COLUMN IF NOT EXISTS slab_mode VARCHAR(20) NOT NULL DEFAULT 'ABSOLUTE';

ALTER TABLE client_rate_details
  DROP CONSTRAINT IF EXISTS ck_crd_slab_mode;

ALTER TABLE client_rate_details
  ADD CONSTRAINT ck_crd_slab_mode CHECK (slab_mode IN ('ABSOLUTE', 'MARGINAL'));