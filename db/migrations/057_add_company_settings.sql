-- Per-tenant feature settings.
--
-- Opt-in toggles for behaviour that not every warehouse wants enforced. Stored as
-- a single JSONB bag on the company so new flags don't each need a migration.
-- Flags consumed so far (all default off when the key is absent):
--   qc_gate_enabled         block put-away of QC-quarantined LPs
--   qc_disposition_enabled  expose the QC hold disposition workflow
--
-- NOT NULL DEFAULT '{}' so every existing company reads as "all toggles off".
-- wms_mobile_app inherits privileges from the wms_migrator default-privileges
-- rule, so no explicit GRANT is needed.

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;