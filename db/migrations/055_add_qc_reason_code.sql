-- Structured defect reason for inbound QC Reject/Hold.
--
-- Until now a QC rejection captured only free-text `remarks` plus photos, so
-- there was no queryable defect category -- no defect-type analytics and no
-- supplier scorecard feedback. The mobile app now sends a `reason_code` (from a
-- fixed QC taxonomy served by GET /qc/reason-codes) whenever the result is
-- REJECT or HOLD; this stores it alongside the QC result.
--
-- Nullable because ACCEPT carries no reason, and to keep older rows valid.
-- wms_mobile_app inherits table privileges on public.mobile_qc_results from the
-- wms_migrator default-privileges rule, so no explicit GRANT is needed.

BEGIN;

ALTER TABLE public.mobile_qc_results
  ADD COLUMN IF NOT EXISTS reason_code TEXT;

-- Defect-type rollups scan rejected/held rows by reason within a tenant.
CREATE INDEX IF NOT EXISTS mobile_qc_results_reason_code_idx
  ON public.mobile_qc_results (company_id, reason_code)
  WHERE reason_code IS NOT NULL;

COMMIT;