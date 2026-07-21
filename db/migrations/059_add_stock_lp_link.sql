-- Link received stock back to the mobile License Plate (pallet) it came from.
--
-- Background / the flaw this fixes
-- --------------------------------
-- Real-world receiving is a two-step, two-app flow:
--   1. Dock (mobile app): pallets are received fast as "LP collection" -- the LP
--      code + quantity are captured (public.mobile_lp_records), but NOT the
--      per-unit manufacturer serials (no time at the dock).
--   2. Desk (web app): a clerk checks the paperwork and types the real Mfg serial
--      numbers into the GRN line (grn_line_items.serial_numbers_json).
--
-- Until now the ONLY association between an LP and its stock was a string-naming
-- convention: mobile LP receipts with no serials had synthetic serials minted as
-- "<lp_code>-<n>", and Stock Search / movement history reverse-engineered the LP
-- by pattern-matching that shape (serial = lp_code OR serial LIKE lp_code || '-%').
--
-- That trick only survives while the serial IS the synthetic string. The moment
-- the desk does its job and enters REAL Mfg serials, the derivation branch in GRN
-- confirm is skipped, the real serials land in stock_serial_numbers, they no
-- longer match any lp_code, and the LP linkage is silently lost -- which is why
-- LP ID shows blank in Stock Search for LP-received-then-desk-confirmed GRNs.
--
-- The fix is to model the relationship instead of inferring it: a real FK from
-- each stock serial to the LP record it belongs to, stamped at GRN confirm for
-- BOTH synthetic and real serials. Stock Search / movements then resolve the LP
-- via the FK regardless of what the serial string looks like.

BEGIN;

ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS lp_record_id TEXT;

-- FK to the pallet record. ON DELETE SET NULL: purging an old LP record must
-- never block or delete the stock that was received on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'stock_serial_numbers'::regclass
      AND conname = 'stock_serial_numbers_lp_record_id_fkey'
  ) THEN
    ALTER TABLE stock_serial_numbers
      ADD CONSTRAINT stock_serial_numbers_lp_record_id_fkey
      FOREIGN KEY (lp_record_id) REFERENCES public.mobile_lp_records(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_stock_serial_numbers_lp_record
  ON stock_serial_numbers (lp_record_id)
  WHERE lp_record_id IS NOT NULL;

-- Backfill existing stock using the legacy naming convention so already-received
-- (synthetic-serial) pallets light up immediately, without waiting for re-confirm.
-- Real desk-entered serials on historical GRNs cannot be recovered this way --
-- there is no stored link -- so they stay NULL; only new confirms fix those.
--
-- stock_serial_numbers has FORCE ROW LEVEL SECURITY, and the migrator role has
-- neither BYPASSRLS nor a company context set, so a plain UPDATE would match zero
-- rows. Drop FORCE for the duration of this owner-run backfill, then restore it.
ALTER TABLE stock_serial_numbers NO FORCE ROW LEVEL SECURITY;

UPDATE stock_serial_numbers ssn
SET lp_record_id = (
  SELECT lpr.id
  FROM public.mobile_lp_records lpr
  WHERE ssn.serial_number = lpr.lp_code
     OR ssn.serial_number LIKE lpr.lp_code || '-%'
  ORDER BY LENGTH(lpr.lp_code) DESC   -- longest match wins (handles LP1 vs LP1-2 prefixes)
  LIMIT 1
)
WHERE ssn.lp_record_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.mobile_lp_records lpr2
    WHERE ssn.serial_number = lpr2.lp_code
       OR ssn.serial_number LIKE lpr2.lp_code || '-%'
  );

ALTER TABLE stock_serial_numbers FORCE ROW LEVEL SECURITY;

COMMIT;
