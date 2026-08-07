-- Make an approved transfer a real hold on the stock.
--
-- Until now APPROVED was a signature over nothing. Phase 0 added a check at
-- approval -- "does the source have this today?" -- but a check is not a hold: a
-- delivery order could allocate the same serials the next minute, and the
-- transfer failed at dispatch anyway, which is the confusion the check was meant
-- to remove.
--
-- THE SHAPE OF THE HOLD, AND WHY IT IS NOT A STATUS
--
-- Delivery orders hold stock by flipping status to RESERVED and pinning
-- do_line_item_id. Copying that here would have been the obvious move and it is
-- wrong, because `status` is overloaded: roughly fifteen queries treat
-- status = 'IN_STOCK' as "on hand", and one of them is the storage snapshot in
-- lib/billing-service.ts that decides what the client is billed for. Stock
-- reserved for a transfer has not moved, has not left, and is still occupying
-- the rack -- flipping its status would silently stop billing storage on it,
-- drop it out of client-facing inventory, and hide it from cycle counts, none of
-- which is true of stock that is simply spoken for.
--
-- So the hold is its own column. `status` keeps meaning where the unit is;
-- transfer_line_id means who has claimed it. Every counting query stays correct
-- untouched, and only the paths that CHOOSE stock have to learn the new rule --
-- which is the small, greppable, testable set.
--
-- ON DELETE SET NULL: cancelling a transfer releases its stock through
-- lib/stock-transfer.ts, but a line deleted by the header's ON DELETE CASCADE
-- must never take live inventory rows with it.

BEGIN;

ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS transfer_line_id INTEGER
    REFERENCES stock_transfer_lines(id) ON DELETE SET NULL;

COMMENT ON COLUMN stock_serial_numbers.transfer_line_id IS
  'Stock transfer line holding this unit while it waits to be dispatched. Set at approval, cleared at dispatch or cancellation. Independent of status: a held unit is still IN_STOCK, still on hand and still billable.';

-- Partial: the overwhelming majority of serials are not reserved to a transfer,
-- and the queries that care ask either "which units does this line hold" or
-- "is this unit free", so the NULLs are dead weight in the index.
CREATE INDEX IF NOT EXISTS idx_ssn_transfer_line
  ON stock_serial_numbers(transfer_line_id)
  WHERE transfer_line_id IS NOT NULL;

-- A unit cannot be claimed by a transfer and a delivery order at the same time.
-- The application prevents it on both sides; this makes it unrepresentable, so a
-- future allocation path that forgets the rule fails loudly instead of
-- double-promising a unit that only exists once.
ALTER TABLE stock_serial_numbers
  DROP CONSTRAINT IF EXISTS ck_ssn_single_claim;
ALTER TABLE stock_serial_numbers
  ADD CONSTRAINT ck_ssn_single_claim
  CHECK (transfer_line_id IS NULL OR do_line_item_id IS NULL);

COMMIT;
