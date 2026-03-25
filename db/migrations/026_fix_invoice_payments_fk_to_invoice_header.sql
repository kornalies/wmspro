BEGIN;

DO $$
BEGIN
  IF to_regclass('public.invoice_payments') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE invoice_payments
    DROP CONSTRAINT IF EXISTS invoice_payments_invoice_id_fkey;

  IF to_regclass('public.invoice_header') IS NOT NULL THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_invoice_id_fkey
      FOREIGN KEY (invoice_id)
      REFERENCES invoice_header(id)
      ON DELETE CASCADE
      NOT VALID;
  ELSIF to_regclass('public.invoices') IS NOT NULL THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_invoice_id_fkey
      FOREIGN KEY (invoice_id)
      REFERENCES invoices(id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

COMMIT;
