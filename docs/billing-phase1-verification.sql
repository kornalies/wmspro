-- 1) Table existence checks
SELECT to_regclass('public.client_billing_profile') AS client_billing_profile;
SELECT to_regclass('public.client_rate_master') AS client_rate_master;
SELECT to_regclass('public.client_rate_details') AS client_rate_details;
SELECT to_regclass('public.billing_transactions') AS billing_transactions;
SELECT to_regclass('public.storage_snapshot') AS storage_snapshot;
SELECT to_regclass('public.invoice_header') AS invoice_header;
SELECT to_regclass('public.invoice_lines') AS invoice_lines;
SELECT to_regclass('public.invoice_tax_lines') AS invoice_tax_lines;
SELECT to_regclass('public.credit_note_header') AS credit_note_header;
SELECT to_regclass('public.debit_note_header') AS debit_note_header;

-- 2) Key indexes
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_bt_company_event_key',
    'uq_invoice_header_company_number',
    'uq_invoice_header_company_client_period'
  );

-- 3) RLS enabled checks
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN (
  'client_billing_profile',
  'client_rate_master',
  'client_rate_details',
  'billing_transactions',
  'storage_snapshot',
  'invoice_header',
  'invoice_lines',
  'invoice_tax_lines',
  'credit_note_header',
  'debit_note_header'
);

-- 4) Idempotency simulation example
-- Replace values with real tenant/client/source IDs before executing.
/*
INSERT INTO billing_transactions (
  company_id, client_id, warehouse_id, charge_type, source_type, source_doc_id, source_line_id,
  source_ref_no, event_date, period_from, period_to, uom, quantity, rate, amount, tax_code, gst_rate,
  cgst_amount, sgst_amount, igst_amount, total_tax_amount, gross_amount, status
)
VALUES
  (1, 1, 1, 'INBOUND_HANDLING', 'GRN', 1001, NULL, 'GRN-1001', '2026-02-27', '2026-02-27', '2026-02-27',
   'UNIT', 10, 5, 50, 'GST', 18, 4.5, 4.5, 0, 9, 59, 'UNBILLED');

-- Second insert for same event key should violate uq_bt_company_event_key or be handled via ON CONFLICT in app logic.
*/

