-- QC hold disposition (opt-in workflow, setting qc_disposition_enabled).
--
-- A QC reject/hold opens a public.mobile_qc_holds row (status OPEN) and
-- quarantines the rejected serials (status RESERVED). A supervisor then resolves
-- the hold from the web console with one of:
--   RELEASE           back to available stock (serials -> IN_STOCK)
--   SCRAP             written off            (serials -> CANCELLED)
--   RETURN_TO_VENDOR  returned to supplier   (serials -> CANCELLED, flagged RTV)
--   REWORK            stays quarantined for re-inspection (serials stay RESERVED)
--
-- These columns record who resolved the hold and how. Nullable: an OPEN hold has
-- no disposition yet. wms_mobile_app inherits privileges from the wms_migrator
-- default-privileges rule, so no explicit GRANT is needed.

BEGIN;

ALTER TABLE public.mobile_qc_holds
  ADD COLUMN IF NOT EXISTS disposition TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by INTEGER,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mobile_qc_holds_open_idx
  ON public.mobile_qc_holds (company_id)
  WHERE status = 'OPEN';

COMMIT;