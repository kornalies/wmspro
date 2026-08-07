-- Track D remainder: lot master, genealogy and recall.
--
-- The batch model itself needs nothing new. stock_serial_numbers already carries
-- batch_number, manufacturing_date and expiry_date (adopted in migration 068),
-- and the genealogy chain is already recorded: grn_line_item_id upstream,
-- do_line_item_id downstream, with stock_movements holding the per-serial audit
-- trail in between. A lot master is therefore DERIVED from those rows rather
-- than stored -- a second copy of batch data would drift from the serials it
-- describes, and the drift would surface during a recall, which is the one
-- moment it must not.
--
-- What genuinely cannot be derived is a DECISION: "this batch is on hold" or
-- "this batch is recalled". That is new state, and it is all this migration
-- adds.
--
-- Without it a recall lookup is only a report. Allocation would keep handing out
-- the affected stock while someone works through the list, which is the failure
-- the lookup exists to prevent.

BEGIN;

CREATE TABLE IF NOT EXISTS stock_batch_status (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_number VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  reason TEXT,
  -- The customer/authority reference a recall is being run under, so the audit
  -- trail points at the outside world and not just at a row id.
  reference_no VARCHAR(60),
  raised_by INTEGER REFERENCES users(id),
  raised_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_by INTEGER REFERENCES users(id),
  released_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A batch number is only unique within a client's item, never globally: two
  -- clients can both receive "LOT-001" and they are different lots.
  CONSTRAINT uq_batch_status_company_client_item_batch
    UNIQUE (company_id, client_id, item_id, batch_number),
  CONSTRAINT ck_batch_status CHECK (status IN ('ACTIVE', 'ON_HOLD', 'RECALLED'))
);

-- Allocation consults this table on every pick, filtered by exactly these four
-- columns, so the unique constraint above is also the access path.
CREATE INDEX IF NOT EXISTS idx_batch_status_blocked
  ON stock_batch_status(company_id, client_id, item_id, batch_number)
  WHERE status <> 'ACTIVE';

ALTER TABLE stock_batch_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_batch_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_batch_status_tenant_isolation ON stock_batch_status;
CREATE POLICY stock_batch_status_tenant_isolation
  ON stock_batch_status
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_batch_status TO wms_app;
    GRANT USAGE, SELECT ON SEQUENCE public.stock_batch_status_id_seq TO wms_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_batch_status TO wms;
    GRANT USAGE, SELECT ON SEQUENCE public.stock_batch_status_id_seq TO wms;
  END IF;
END
$$;

COMMIT;
