-- A VOID invoice must stop occupying its billing period.
--
-- uq_invoice_header_company_client_period was a plain UNIQUE constraint over
-- (company_id, client_id, period_from, period_to), which counts VOID rows. Voiding an
-- invoice is the documented recovery for a bad draft — voidInvoice() releases the charges
-- back to UNBILLED specifically so "the released charges will be re-invoiced onto a new
-- document on the next generation run" — but the VOID shell kept its period reserved, so
-- that next run could not reuse it. Instead it fell into the supplementary-invoice branch
-- and issued the replacement under a period NARROWED to the surviving charges' own span.
--
-- The visible damage: void a weekly invoice for 2026-08-04..2026-08-10, regenerate, and the
-- replacement comes back as 2026-08-04..2026-08-05. The client's cycle silently stops being
-- the period on its own invoice, and because that branch also suppresses minimum billing,
-- a client with a floor is under-billed on every regenerated invoice.
--
-- A partial unique index keeps the real guarantee — one live invoice per client per period —
-- while letting any number of VOID shells retain their periods for audit.

ALTER TABLE invoice_header
  DROP CONSTRAINT IF EXISTS uq_invoice_header_company_client_period;

DROP INDEX IF EXISTS uq_invoice_header_company_client_period;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_header_company_client_period
  ON invoice_header (company_id, client_id, period_from, period_to)
  WHERE status <> 'VOID';
