-- Take the legacy `invoices` table out of the way of anyone looking for the
-- invoices table.
--
-- Billing lives in invoice_header / invoice_lines / invoice_tax_lines (migration
-- 015). `public.invoices` predates them and was never migrated forward: on this
-- database it holds a single stale row.
--
-- It stayed dangerous because it kept the obvious name. The reports analytics
-- route did `to_regclass('public.invoices')` and preferred that table whenever it
-- existed, which made Client Analysis report one fossil row as the entire book --
-- one client showing 899,990 against 118 actually billed, and every other client
-- showing zero while being invoiced. That read is gone, but the next author to go
-- looking for "the invoices table" finds this one first, and the failure is silent
-- in exactly the same way.
--
-- Renamed rather than dropped: the row is kept for audit, and anything that still
-- reaches for `invoices` now fails loudly at parse time instead of quietly
-- returning wrong money. Reversible with the opposite rename.
--
-- Idempotent, and a no-op on databases provisioned after the normalized tables
-- landed, which never had this table at all.

DO $$
BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND to_regclass('public.invoices_legacy_do_not_use') IS NULL THEN
    EXECUTE 'ALTER TABLE public.invoices RENAME TO invoices_legacy_do_not_use';

    EXECUTE $c$
      COMMENT ON TABLE public.invoices_legacy_do_not_use IS
        'Pre-normalization invoice table, retained for audit only. Billing reads invoice_header. Do not query this table.'
    $c$;
  END IF;
END
$$;
