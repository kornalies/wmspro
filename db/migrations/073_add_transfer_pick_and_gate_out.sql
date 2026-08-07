-- Split dispatch into a pick and a gate-out.
--
-- "Dispatch" was one button doing three jobs: choosing the serials, picking
-- them, and sending them. Nobody walked the floor in between, so the first time
-- a human touched the stock was after the system had already recorded it as
-- gone. If the units were not where the system thought, the paperwork was
-- already wrong.
--
-- PICKED sits between APPROVED and IN_TRANSIT. Stock in this state has been
-- found and staged but has NOT left: it is still IN_STOCK, still in the
-- building, still billable, and the transfer can still be cancelled. Only
-- gate-out moves it, and gate-out is where the vehicle and driver are captured
-- -- columns that have existed since 070 and were never once written, because
-- there was no step in the flow that knew them.
--
-- quantity_picked is its own column rather than reusing quantity_sent. They
-- differ in the case that matters: units found and staged, then not loaded.
-- Collapsing them would make a short load indistinguishable from a short pick,
-- and those are different failures with different owners -- one is a warehouse
-- problem, the other is a transport problem.

BEGIN;

ALTER TABLE stock_transfer_header DROP CONSTRAINT IF EXISTS ck_stn_status;
ALTER TABLE stock_transfer_header
  ADD CONSTRAINT ck_stn_status CHECK (
    status IN ('DRAFT', 'APPROVED', 'PICKED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')
  );

ALTER TABLE stock_transfer_header
  ADD COLUMN IF NOT EXISTS picked_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS picked_at TIMESTAMP;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS quantity_picked INTEGER NOT NULL DEFAULT 0;

-- Transfers that shipped before this migration were picked implicitly, at the
-- moment they were sent. Backfilling from quantity_sent keeps the invariant
-- below true for them instead of retroactively describing them as unpicked.
UPDATE stock_transfer_lines SET quantity_picked = quantity_sent WHERE quantity_picked < quantity_sent;

ALTER TABLE stock_transfer_lines DROP CONSTRAINT IF EXISTS ck_stn_line_picked;
ALTER TABLE stock_transfer_lines
  ADD CONSTRAINT ck_stn_line_picked
  CHECK (quantity_picked >= 0 AND quantity_picked <= quantity_requested);

-- You cannot send more than you picked. The old constraint compared sent
-- against requested, which allowed the impossible middle: a line that shipped
-- units nobody had found.
ALTER TABLE stock_transfer_lines DROP CONSTRAINT IF EXISTS ck_stn_line_sent;
ALTER TABLE stock_transfer_lines
  ADD CONSTRAINT ck_stn_line_sent
  CHECK (quantity_sent >= 0 AND quantity_sent <= quantity_picked);

-- Set when the unit is scanned onto the transfer, so a pick in progress is
-- distinguishable from one that is complete.
ALTER TABLE stock_transfer_serials
  ADD COLUMN IF NOT EXISTS picked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

COMMIT;
