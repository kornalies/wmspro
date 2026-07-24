-- Track A / A1: pack units (the Distribution/Packing step).
--
-- A pack unit is the physical thing that leaves the building: a built pallet, a
-- carton, or -- for bulk outbound -- the source LP passed straight through.
-- Packing sits between picking and staging:
--
--   PICKED -> [pack units built + closed] -> PACKED -> STAGED
--
-- Non-palletised tenants are not forced through it: the API auto-creates one
-- closed BULK pack unit per picked line, so a bulk flow costs zero extra taps
-- and PICKED -> STAGED stays legal (see lib/do-status.ts).
--
-- Serial linkage lives on do_pack_unit_serials rather than a serial column on
-- the line, because one pack unit can mix serials from several source LPs and a
-- serial must never appear in two pack units. The unique constraint on
-- serial_id enforces that directly.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.pack_unit_code_seq;

CREATE TABLE IF NOT EXISTS do_pack_units (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  pack_code VARCHAR(64) NOT NULL,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  wave_id INTEGER REFERENCES do_wave_header(id) ON DELETE SET NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  pack_type VARCHAR(20) NOT NULL DEFAULT 'PALLET',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  source_lp_record_id TEXT,
  gross_weight_kg NUMERIC(12, 3),
  volume_cbm NUMERIC(12, 4),
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  closed_at TIMESTAMP,
  closed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  CONSTRAINT uq_pack_unit_company_code UNIQUE (company_id, pack_code),
  CONSTRAINT ck_pack_unit_type CHECK (pack_type IN ('PALLET', 'CARTON', 'BULK')),
  CONSTRAINT ck_pack_unit_status CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS do_pack_unit_serials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  pack_unit_id INTEGER NOT NULL REFERENCES do_pack_units(id) ON DELETE CASCADE,
  do_line_item_id INTEGER NOT NULL REFERENCES do_line_items(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  serial_id INTEGER NOT NULL REFERENCES stock_serial_numbers(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A serial exists in at most one pack unit, company-wide. This is the
  -- structural guard against the same stock being shipped on two pallets.
  CONSTRAINT uq_pack_unit_serial UNIQUE (company_id, serial_id)
);

CREATE INDEX IF NOT EXISTS idx_pack_units_company_do ON do_pack_units(company_id, do_header_id, status);
CREATE INDEX IF NOT EXISTS idx_pack_units_company_status ON do_pack_units(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pack_unit_serials_unit ON do_pack_unit_serials(company_id, pack_unit_id);
CREATE INDEX IF NOT EXISTS idx_pack_unit_serials_line ON do_pack_unit_serials(company_id, do_line_item_id);

ALTER TABLE do_pack_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_pack_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_pack_units_tenant_isolation ON do_pack_units;
CREATE POLICY do_pack_units_tenant_isolation
  ON do_pack_units
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE do_pack_unit_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_pack_unit_serials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_pack_unit_serials_tenant_isolation ON do_pack_unit_serials;
CREATE POLICY do_pack_unit_serials_tenant_isolation
  ON do_pack_unit_serials
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.do_pack_units, public.do_pack_unit_serials TO wms_app;
    GRANT USAGE, SELECT ON SEQUENCE public.do_pack_units_id_seq, public.do_pack_unit_serials_id_seq TO wms_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.pack_unit_code_seq TO wms_app;
  END IF;
END
$$;

COMMIT;