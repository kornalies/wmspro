-- 060_enforce_invoice_payment_integrity.sql
--
-- invoice_payments.invoice_id was added as a NOT VALID foreign key, so Postgres
-- enforced it for new rows but never checked existing ones. Payments whose
-- invoice was deleted out-of-band survived as orphans and leaked into the
-- trial balance via syncFinanceLedger.
--
-- Remove any remaining orphans, then VALIDATE the constraint so the database
-- rejects them from here on. The FK already carries ON DELETE CASCADE, so a
-- future invoice deletion takes its payments with it.
--
-- IMPORTANT: invoice_header has FORCED row-level security, but invoice_payments
-- does not. The migrator role is subject to RLS (no BYPASSRLS), so a bare
-- "NOT EXISTS (SELECT 1 FROM invoice_header ...)" sees ZERO invoices and treats
-- every payment as an orphan. The cleanup must therefore run once per company
-- with app.company_id set, and must scope the delete to that same company_id --
-- otherwise it deletes valid payments belonging to other tenants.

BEGIN;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.company_id', c.id::text, true);

    DELETE FROM invoice_payments ip
     WHERE ip.company_id = c.id
       AND NOT EXISTS (
         SELECT 1 FROM invoice_header ih
          WHERE ih.company_id = ip.company_id
            AND ih.id = ip.invoice_id
       );
  END LOOP;
END $$;

ALTER TABLE invoice_payments
  VALIDATE CONSTRAINT invoice_payments_invoice_id_fkey;

COMMIT;
