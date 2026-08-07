-- Stock Transfer Note and Inventory Adjustment Report.
--
-- These were descoped from the EDDS document work because they are not missing
-- documents -- they are missing records. There was nowhere to store an
-- inter-warehouse transfer or an approved adjustment, so there was nothing for a
-- document builder to render. Today a bin-to-bin put-away writes a TRANSFER
-- movement and cycle counting writes LOST movements, but a movement row is an
-- effect: it cannot carry an intent, an approver, or a state.
--
-- Two headers, therefore, each with lines:
--
--   stock_transfer_header  -- stock moving between warehouses, in transit for a
--     while, received (possibly short) at the other end.
--   inventory_adjustment_header -- stock written off or added outside the normal
--     inbound/outbound flow, with a reason and an approver.
--
-- Serials get an IN_TRANSIT status. It has to be a real state rather than
-- "still IN_STOCK at the source": stock on a truck must stop being allocatable
-- the moment it leaves, and every allocation path already filters on
-- IN_STOCK/RESERVED, so a new status is excluded from them by construction.

BEGIN;

-- ---------------------------------------------------------------------------
-- In-transit stock
-- ---------------------------------------------------------------------------

ALTER TABLE stock_serial_numbers DROP CONSTRAINT IF EXISTS stock_serial_numbers_status_check;
ALTER TABLE stock_serial_numbers
  ADD CONSTRAINT stock_serial_numbers_status_check
  CHECK (status IN ('IN_STOCK', 'RESERVED', 'IN_TRANSIT', 'DISPATCHED', 'CANCELLED'));

-- ---------------------------------------------------------------------------
-- Stock transfers
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS stock_transfer_number_seq;

CREATE TABLE IF NOT EXISTS stock_transfer_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  transfer_number VARCHAR(40) NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  reason TEXT,
  transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  vehicle_number VARCHAR(40),
  driver_name VARCHAR(120),
  remarks TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMP,
  dispatched_by INTEGER REFERENCES users(id),
  dispatched_at TIMESTAMP,
  received_by INTEGER REFERENCES users(id),
  received_at TIMESTAMP,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stn_company_number UNIQUE (company_id, transfer_number),
  CONSTRAINT ck_stn_status CHECK (
    status IN ('DRAFT', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')
  ),
  -- A transfer to the warehouse it came from is a data-entry slip, and it would
  -- produce a pair of movements that cancel out while looking like real work.
  CONSTRAINT ck_stn_distinct_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  transfer_id INTEGER NOT NULL REFERENCES stock_transfer_header(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity_requested INTEGER NOT NULL,
  -- Sent and received are tracked separately because they genuinely differ: a
  -- short receipt is the case the document exists to evidence.
  quantity_sent INTEGER NOT NULL DEFAULT 0,
  quantity_received INTEGER NOT NULL DEFAULT 0,
  uom VARCHAR(20) NOT NULL DEFAULT 'PCS',
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stn_line UNIQUE (transfer_id, line_number),
  CONSTRAINT ck_stn_line_qty CHECK (quantity_requested > 0),
  CONSTRAINT ck_stn_line_sent CHECK (quantity_sent >= 0 AND quantity_sent <= quantity_requested),
  CONSTRAINT ck_stn_line_received CHECK (quantity_received >= 0 AND quantity_received <= quantity_sent)
);

-- Which units are on the truck. Without this a short receipt could not say WHICH
-- units failed to arrive, only how many -- and for batch-tracked stock that is
-- the difference between a usable record and a number.
CREATE TABLE IF NOT EXISTS stock_transfer_serials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  transfer_id INTEGER NOT NULL REFERENCES stock_transfer_header(id) ON DELETE CASCADE,
  transfer_line_id INTEGER NOT NULL REFERENCES stock_transfer_lines(id) ON DELETE CASCADE,
  serial_id INTEGER NOT NULL REFERENCES stock_serial_numbers(id),
  received BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stn_serial UNIQUE (transfer_id, serial_id)
);

CREATE INDEX IF NOT EXISTS idx_stn_company_status
  ON stock_transfer_header(company_id, status, transfer_date DESC);
CREATE INDEX IF NOT EXISTS idx_stn_lines_transfer ON stock_transfer_lines(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stn_serials_transfer ON stock_transfer_serials(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stn_serials_serial ON stock_transfer_serials(serial_id);

-- ---------------------------------------------------------------------------
-- Inventory adjustments
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS inventory_adjustment_number_seq;

CREATE TABLE IF NOT EXISTS inventory_adjustment_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  adjustment_number VARCHAR(40) NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  reason_code VARCHAR(40) NOT NULL,
  reason TEXT,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_no VARCHAR(60),
  -- Set when cycle counting is the origin, so the adjustment register can show
  -- count-driven write-offs beside manual ones instead of pretending the two
  -- populations are unrelated.
  source_module VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
  source_ref VARCHAR(60),
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMP,
  rejected_by INTEGER REFERENCES users(id),
  rejected_at TIMESTAMP,
  rejection_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_iar_company_number UNIQUE (company_id, adjustment_number),
  CONSTRAINT ck_iar_status CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT ck_iar_reason CHECK (
    reason_code IN ('DAMAGE', 'LOSS', 'FOUND', 'EXPIRY', 'COUNT_VARIANCE', 'SYSTEM_CORRECTION', 'OTHER')
  ),
  CONSTRAINT ck_iar_source CHECK (source_module IN ('MANUAL', 'CYCLE_COUNT', 'QC'))
);

CREATE TABLE IF NOT EXISTS inventory_adjustment_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  adjustment_id INTEGER NOT NULL REFERENCES inventory_adjustment_header(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  -- DECREASE writes off named serials; INCREASE brings named serials in. Both
  -- directions name their units: WMS refuses to invent a serial number it was
  -- not given, which is the same rule cycle counting settled on for overages.
  direction VARCHAR(10) NOT NULL,
  quantity INTEGER NOT NULL,
  -- Required for INCREASE. stock_serial_numbers.grn_line_item_id is NOT NULL --
  -- every unit in this system traces back to a receipt line, which is what the
  -- lot genealogy walks. Found stock has to declare which receipt it belongs to
  -- rather than appearing from nowhere and leaving a hole in that trail.
  grn_line_item_id INTEGER REFERENCES grn_line_items(id),
  batch_number VARCHAR(100),
  expiry_date DATE,
  bin_location VARCHAR(60),
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_iar_line UNIQUE (adjustment_id, line_number),
  CONSTRAINT ck_iar_line_direction CHECK (direction IN ('INCREASE', 'DECREASE')),
  CONSTRAINT ck_iar_line_qty CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS inventory_adjustment_serials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  adjustment_id INTEGER NOT NULL REFERENCES inventory_adjustment_header(id) ON DELETE CASCADE,
  adjustment_line_id INTEGER NOT NULL REFERENCES inventory_adjustment_lines(id) ON DELETE CASCADE,
  -- For DECREASE this points at the serial being written off. For INCREASE it is
  -- null until approval creates the row, and serial_number carries what the
  -- operator declared.
  serial_id INTEGER REFERENCES stock_serial_numbers(id),
  serial_number VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_iar_serial UNIQUE (adjustment_id, serial_number)
);

-- Added after the table above shipped in this same migration during development;
-- kept as a separate statement so a database created from the earlier version
-- picks it up too.
ALTER TABLE inventory_adjustment_lines
  ADD COLUMN IF NOT EXISTS grn_line_item_id INTEGER REFERENCES grn_line_items(id);

CREATE INDEX IF NOT EXISTS idx_iar_company_status
  ON inventory_adjustment_header(company_id, status, adjustment_date DESC);
CREATE INDEX IF NOT EXISTS idx_iar_lines_adjustment ON inventory_adjustment_lines(adjustment_id);
CREATE INDEX IF NOT EXISTS idx_iar_serials_adjustment ON inventory_adjustment_serials(adjustment_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_transfer_header',
    'stock_transfer_lines',
    'stock_transfer_serials',
    'inventory_adjustment_header',
    'inventory_adjustment_lines',
    'inventory_adjustment_serials'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER) WITH CHECK (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['wms_app', 'wms'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON
        public.stock_transfer_header, public.stock_transfer_lines, public.stock_transfer_serials,
        public.inventory_adjustment_header, public.inventory_adjustment_lines,
        public.inventory_adjustment_serials TO %I', r);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE
        public.stock_transfer_header_id_seq, public.stock_transfer_lines_id_seq,
        public.stock_transfer_serials_id_seq, public.inventory_adjustment_header_id_seq,
        public.inventory_adjustment_lines_id_seq, public.inventory_adjustment_serials_id_seq,
        public.stock_transfer_number_seq, public.inventory_adjustment_number_seq TO %I', r);
    END IF;
  END LOOP;
END
$$;

COMMIT;
