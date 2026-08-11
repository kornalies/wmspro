-- Make a raised adjustment a real quarantine on the stock.
--
-- Until now a DRAFT adjustment changed nothing at all. That was defended as a
-- control -- "approval is the only thing that touches stock" -- and for the
-- bookkeeping it is right: a draft must not write anything off. But it left a
-- hole in the physical world. An operator finds a crushed pallet at 09:00 and
-- raises the write-off; the units stay allocatable, a delivery order picks them
-- at 09:20, and the damaged goods go to a customer. The approval-time re-check
-- in lib/inventory-adjustment.ts then reports STOCK_MOVED, which is a report of
-- the accident rather than a control against it.
--
-- So raising an adjustment now QUARANTINES the named units: still on hand, still
-- countable, still billable, but no longer choosable by anything that ships.
-- Nothing is written off until someone approves -- the bookkeeping rule is
-- untouched.
--
-- WHY A COLUMN, NOT A STATUS
--
-- Exactly the reasoning of migration 072. Roughly fifteen queries read
-- status = 'IN_STOCK' as "on hand", and one of them is the storage snapshot in
-- lib/billing-service.ts that decides what the client is billed. Stock reported
-- as damaged is still sitting in the rack taking up space: flipping its status
-- would stop billing storage on it, drop it out of client-facing inventory and
-- hide it from cycle counts, none of which is true until the write-off is
-- approved. status keeps meaning where the unit is; adjustment_line_id means
-- there is an open question about it.
--
-- WHY THIS IS *NOT* ADDED TO ck_ssn_single_claim
--
-- That constraint says a unit is promised to at most one order -- a delivery
-- order XOR a transfer -- because a unit that only exists once cannot be shipped
-- twice. An adjustment claim is not a promise to ship. It is a quarantine, and a
-- unit that is both reserved to a delivery order AND reported damaged is exactly
-- the situation this feature exists to surface. Making it unrepresentable would
-- mean refusing to record damage on stock somebody had already sold, which is
-- when recording it matters most. The conflict is surfaced at approval instead,
-- where it can be acknowledged by a human.
--
-- ON DELETE SET NULL: adjustments release their quarantine through
-- lib/inventory-adjustment.ts, but a line removed by the header's ON DELETE
-- CASCADE must never take live inventory rows with it.

BEGIN;

ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS adjustment_line_id INTEGER
    REFERENCES inventory_adjustment_lines(id) ON DELETE SET NULL;

COMMENT ON COLUMN stock_serial_numbers.adjustment_line_id IS
  'Open inventory adjustment line quarantining this unit. Set when a write-off is raised, cleared on approval, rejection or withdrawal. Independent of status and of the other two claims: a quarantined unit is still IN_STOCK, still on hand and still billable, it just cannot be chosen by anything that ships.';

-- Partial for the same reason as idx_ssn_transfer_line: almost no serial is
-- under adjustment, and every query that cares asks either "which units does
-- this line hold" or "is this unit free".
CREATE INDEX IF NOT EXISTS idx_ssn_adjustment_line
  ON stock_serial_numbers(adjustment_line_id)
  WHERE adjustment_line_id IS NOT NULL;

COMMIT;
