-- Let an inventory adjustment say it came from a stock transfer.
--
-- Migration 070 gave inventory_adjustment_header a source_module so the register
-- could "show count-driven write-offs beside manual ones instead of pretending
-- the two populations are unrelated". Transfers are the third population and the
-- constraint did not know about them, so a unit lost in transit could only be
-- written off as MANUAL -- indistinguishable from someone typing in a damage
-- report, and untraceable back to the transfer that lost it.
--
-- That matters because units stranded IN_TRANSIT are the one stock population
-- nothing chases: lib/lots.ts counts IN_TRANSIT as on hand, so a lost unit
-- inflates inventory indefinitely while looking perfectly healthy.

BEGIN;

ALTER TABLE inventory_adjustment_header DROP CONSTRAINT IF EXISTS ck_iar_source;
ALTER TABLE inventory_adjustment_header
  ADD CONSTRAINT ck_iar_source
  CHECK (source_module IN ('MANUAL', 'CYCLE_COUNT', 'QC', 'TRANSFER'));

COMMIT;
