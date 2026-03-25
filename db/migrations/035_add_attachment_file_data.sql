BEGIN;

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS file_data BYTEA;

COMMIT;
