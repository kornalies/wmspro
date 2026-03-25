BEGIN;

ALTER TABLE billing_transactions
  DROP CONSTRAINT IF EXISTS ck_bt_status;

ALTER TABLE billing_transactions
  ADD CONSTRAINT ck_bt_status
  CHECK (status IN ('UNRATED', 'UNBILLED', 'BILLED', 'VOID'));

CREATE INDEX IF NOT EXISTS idx_bt_company_status_event_date
  ON billing_transactions(company_id, status, event_date);

COMMIT;
