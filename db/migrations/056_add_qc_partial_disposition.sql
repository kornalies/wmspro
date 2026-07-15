-- Partial disposition for inbound QC.
--
-- Until now a QC result covered a whole GRN line: the entire quantity was either
-- accepted or quarantined. Inspectors often need to split a line -- e.g. accept 8
-- units and reject 2 damaged ones. These columns record that split alongside the
-- existing `quantity` (which remains the line total):
--   accepted_qty  units made available (status IN_STOCK)
--   rejected_qty  units quarantined  (status RESERVED), carrying the reason_code
-- For a full accept rejected_qty = 0; for a full reject accepted_qty = 0.
--
-- Nullable so historical rows (whole-line results) stay valid; new rows always
-- populate both. wms_mobile_app inherits privileges from the wms_migrator
-- default-privileges rule, so no explicit GRANT is needed.

BEGIN;

ALTER TABLE public.mobile_qc_results
  ADD COLUMN IF NOT EXISTS accepted_qty INTEGER,
  ADD COLUMN IF NOT EXISTS rejected_qty INTEGER;

COMMIT;