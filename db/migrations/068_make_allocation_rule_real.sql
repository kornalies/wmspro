-- Track D: make stock allocation honest.
--
-- The DO form has offered an allocation_rule of FIFO / FEFO / BATCH / SERIAL /
-- LOCATION for some time, but the choice was flattened into a free-text remarks
-- string (components/do/DOForm.tsx). There was no allocation_rule column
-- anywhere, and every allocation path ordered by received_date. Choosing FEFO
-- wrote the words "Allocation rule: FEFO" into remarks and shipped FIFO.
--
-- For the food / pharma / chemicals clients this matters to, that is a control
-- asserting something untrue about how their stock leaves the building. This
-- migration gives the rule somewhere to live so it can be honoured.
--
-- The batch and expiry columns this depends on ALREADY EXIST and already carry
-- data (1001 of 1791 serials in the dev database have batch_number, expiry_date,
-- manufacturing_date and remaining_shelf_life_days). Like the cycle-count tables
-- in migration 067, they arrived from the mobile service and were never in
-- db/migrations, so a clean install had none of them. They are declared here
-- with IF NOT EXISTS so a fresh deploy matches an existing database and no
-- populated column is touched.

BEGIN;

-- ---------------------------------------------------------------------------
-- Adopt the existing batch / expiry model.
-- ---------------------------------------------------------------------------

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS is_batch_tracked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_expiry_tracked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_shelf_life_days INTEGER,
  -- The minimum remaining shelf life a customer will accept on receipt. Stock
  -- inside this window is still saleable but must not be auto-allocated, which
  -- is the rule that actually prevents a rejected delivery.
  ADD COLUMN IF NOT EXISTS min_shelf_life_days INTEGER;

ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS manufacturing_date DATE,
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS remaining_shelf_life_days INTEGER;

-- FEFO orders by expiry across a warehouse/client/item slice, and the allocation
-- path runs FOR UPDATE SKIP LOCKED under contention, so this index is doing real
-- work rather than being decorative.
CREATE INDEX IF NOT EXISTS idx_stock_serial_expiry
  ON stock_serial_numbers(company_id, warehouse_id, client_id, item_id, expiry_date)
  WHERE status IN ('IN_STOCK', 'RESERVED');

CREATE INDEX IF NOT EXISTS idx_stock_serial_batch
  ON stock_serial_numbers(company_id, item_id, batch_number)
  WHERE batch_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Somewhere for the allocation rule to live.
-- ---------------------------------------------------------------------------

ALTER TABLE do_header
  ADD COLUMN IF NOT EXISTS allocation_rule VARCHAR(20) NOT NULL DEFAULT 'FIFO';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'do_header'::regclass
      AND conname = 'ck_do_allocation_rule'
  ) THEN
    -- SERIAL and LOCATION are accepted because the form already offers them and
    -- rejecting a value the UI can produce would break DO creation. They are not
    -- yet distinct strategies: lib/allocation.ts treats them as FIFO and says so
    -- rather than pretending otherwise.
    ALTER TABLE do_header
      ADD CONSTRAINT ck_do_allocation_rule
      CHECK (allocation_rule IN ('FIFO', 'FEFO', 'BATCH', 'SERIAL', 'LOCATION'));
  END IF;
END
$$;

COMMIT;