-- Track A / A2: Goods Issue.
--
-- Goods Issue is the commercial hand-off: the warehouse declares a set of closed
-- pack units as issued to the client. Stock is committed-out but still
-- physically in the building -- it does not leave until the delivery note is
-- finalized (A3).
--
--   PACKED -> STAGED -> [goods issue generated] -> ISSUED
--
-- This is the point outbound handling revenue is recognised when the tenant has
-- opted into outbound_billing_trigger = 'GOODS_ISSUE' (see A5). Tenants left on
-- the default 'DISPATCH' keep billing at dispatch and this document is purely
-- operational, so the migration changes no revenue behaviour on its own.
--
-- A pack unit may be issued exactly once: uq_gi_pack_unit enforces it rather
-- than leaving it to application checks.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.goods_issue_number_seq;

CREATE TABLE IF NOT EXISTS goods_issue_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  gi_number VARCHAR(64) NOT NULL,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status VARCHAR(20) NOT NULL DEFAULT 'GENERATED',
  total_pack_units INTEGER NOT NULL DEFAULT 0 CHECK (total_pack_units >= 0),
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_by INTEGER REFERENCES users(id),
  cancelled_at TIMESTAMP,
  cancelled_by INTEGER REFERENCES users(id),
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_gi_company_number UNIQUE (company_id, gi_number),
  CONSTRAINT ck_gi_status CHECK (status IN ('GENERATED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS goods_issue_pack_units (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  goods_issue_id INTEGER NOT NULL REFERENCES goods_issue_header(id) ON DELETE CASCADE,
  pack_unit_id INTEGER NOT NULL REFERENCES do_pack_units(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_gi_pack_unit UNIQUE (company_id, pack_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_gi_company_do ON goods_issue_header(company_id, do_header_id, status);
CREATE INDEX IF NOT EXISTS idx_gi_company_status ON goods_issue_header(company_id, status, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_gi_pack_units_gi ON goods_issue_pack_units(company_id, goods_issue_id);

ALTER TABLE goods_issue_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_issue_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_issue_header_tenant_isolation ON goods_issue_header;
CREATE POLICY goods_issue_header_tenant_isolation
  ON goods_issue_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE goods_issue_pack_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_issue_pack_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_issue_pack_units_tenant_isolation ON goods_issue_pack_units;
CREATE POLICY goods_issue_pack_units_tenant_isolation
  ON goods_issue_pack_units
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods_issue_header, public.goods_issue_pack_units TO wms_app;
    GRANT USAGE, SELECT ON SEQUENCE public.goods_issue_header_id_seq, public.goods_issue_pack_units_id_seq TO wms_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.goods_issue_number_seq TO wms_app;
  END IF;
END
$$;

COMMIT;