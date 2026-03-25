BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS contact_person varchar(150),
  ADD COLUMN IF NOT EXISTS contact_email varchar(255),
  ADD COLUMN IF NOT EXISTS contact_phone varchar(30);

COMMIT;
