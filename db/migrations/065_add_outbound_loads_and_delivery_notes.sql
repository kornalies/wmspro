-- Track A / A3: Loading and Delivery Note.
--
--   ISSUED -> [pack units loaded onto a vehicle] -> LOADED
--          -> [delivery note finalized]          -> COMPLETED / PARTIALLY_FULFILLED
--
-- Delivery-note finalize is the ONLY step in the new tail that touches stock.
-- Everything before it is paperwork over already-picked inventory. Finalize
-- commits serials to DISPATCHED and increments do_line_items.quantity_dispatched
-- through the same shared helper the legacy dispatch route uses
-- (lib/outbound-stock.ts), so there is exactly one implementation of the
-- stock-commit rules.
--
-- One load carries one vehicle (eFreight's constraint, and it matches how a
-- loading bay actually works). A pack unit can be loaded once --
-- uq_load_pack_unit -- which is what stops a pallet being shipped twice.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.outbound_load_number_seq;
CREATE SEQUENCE IF NOT EXISTS public.delivery_note_number_seq;

CREATE TABLE IF NOT EXISTS outbound_loads (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  load_number VARCHAR(64) NOT NULL,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  goods_issue_id INTEGER REFERENCES goods_issue_header(id) ON DELETE SET NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  vehicle_number VARCHAR(50),
  container_number VARCHAR(50),
  seal_number VARCHAR(50),
  driver_name VARCHAR(120),
  driver_phone VARCHAR(40),
  transport_company VARCHAR(150),
  loading_bay VARCHAR(50),
  loaded_at TIMESTAMP,
  loaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  CONSTRAINT uq_load_company_number UNIQUE (company_id, load_number),
  CONSTRAINT ck_load_status CHECK (status IN ('OPEN', 'LOADED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS outbound_load_pack_units (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  load_id INTEGER NOT NULL REFERENCES outbound_loads(id) ON DELETE CASCADE,
  pack_unit_id INTEGER NOT NULL REFERENCES do_pack_units(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  loaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_load_pack_unit UNIQUE (company_id, pack_unit_id)
);

CREATE TABLE IF NOT EXISTS delivery_note_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  delivery_note_number VARCHAR(64) NOT NULL,
  load_id INTEGER NOT NULL REFERENCES outbound_loads(id) ON DELETE CASCADE,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  total_pack_units INTEGER NOT NULL DEFAULT 0 CHECK (total_pack_units >= 0),
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  finalized_at TIMESTAMP,
  finalized_by INTEGER REFERENCES users(id),
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_dn_company_number UNIQUE (company_id, delivery_note_number),
  CONSTRAINT ck_dn_status CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  -- A load produces at most one delivery note.
  CONSTRAINT uq_dn_load UNIQUE (company_id, load_id)
);

CREATE TABLE IF NOT EXISTS delivery_note_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  delivery_note_id INTEGER NOT NULL REFERENCES delivery_note_header(id) ON DELETE CASCADE,
  do_line_item_id INTEGER NOT NULL REFERENCES do_line_items(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_loads_company_do ON outbound_loads(company_id, do_header_id, status);
CREATE INDEX IF NOT EXISTS idx_loads_company_status ON outbound_loads(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_load_pack_units_load ON outbound_load_pack_units(company_id, load_id);
CREATE INDEX IF NOT EXISTS idx_dn_company_do ON delivery_note_header(company_id, do_header_id, status);
CREATE INDEX IF NOT EXISTS idx_dn_lines_dn ON delivery_note_lines(company_id, delivery_note_id);

ALTER TABLE outbound_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_loads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_loads_tenant_isolation ON outbound_loads;
CREATE POLICY outbound_loads_tenant_isolation
  ON outbound_loads
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE outbound_load_pack_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_load_pack_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_load_pack_units_tenant_isolation ON outbound_load_pack_units;
CREATE POLICY outbound_load_pack_units_tenant_isolation
  ON outbound_load_pack_units
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE delivery_note_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_note_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_note_header_tenant_isolation ON delivery_note_header;
CREATE POLICY delivery_note_header_tenant_isolation
  ON delivery_note_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE delivery_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_note_lines_tenant_isolation ON delivery_note_lines;
CREATE POLICY delivery_note_lines_tenant_isolation
  ON delivery_note_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.outbound_loads,
      public.outbound_load_pack_units,
      public.delivery_note_header,
      public.delivery_note_lines
      TO wms_app;
    GRANT USAGE, SELECT ON SEQUENCE
      public.outbound_loads_id_seq,
      public.outbound_load_pack_units_id_seq,
      public.delivery_note_header_id_seq,
      public.delivery_note_lines_id_seq
      TO wms_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE
      public.outbound_load_number_seq,
      public.delivery_note_number_seq
      TO wms_app;
  END IF;
END
$$;

COMMIT;