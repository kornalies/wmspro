-- Backfill legacy DO statuses into canonical values used by application code.
-- This is idempotent and safe to run repeatedly.
DO $$
DECLARE
  company_row RECORD;
BEGIN
  FOR company_row IN SELECT id FROM companies ORDER BY id
  LOOP
    PERFORM set_config('app.company_id', company_row.id::text, true);

    UPDATE do_header
    SET status = CASE
      WHEN status IS NULL OR BTRIM(status) = '' THEN 'PENDING'
      WHEN UPPER(BTRIM(status)) IN ('DRAFT', 'PENDING', 'PICKED', 'STAGED', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED')
        THEN UPPER(BTRIM(status))
      WHEN UPPER(BTRIM(status)) IN ('OPEN', 'CREATED', 'NEW')
        THEN 'DRAFT'
      WHEN UPPER(BTRIM(status)) IN ('CONFIRMED', 'APPROVED', 'ALLOCATED')
        THEN 'PENDING'
      WHEN UPPER(BTRIM(status)) IN ('PICKING_DONE')
        THEN 'PICKED'
      WHEN UPPER(BTRIM(status)) IN ('READY', 'READY_TO_DISPATCH')
        THEN 'STAGED'
      WHEN UPPER(BTRIM(status)) IN ('PARTIAL', 'PARTIALLY_COMPLETED', 'PARTIAL_FULFILLED')
        THEN 'PARTIALLY_FULFILLED'
      WHEN UPPER(BTRIM(status)) IN ('FULFILLED', 'DISPATCHED', 'DELIVERED', 'DONE', 'CLOSED')
        THEN 'COMPLETED'
      ELSE 'PENDING'
    END
    WHERE company_id = company_row.id
      AND status IS DISTINCT FROM CASE
        WHEN status IS NULL OR BTRIM(status) = '' THEN 'PENDING'
        WHEN UPPER(BTRIM(status)) IN ('DRAFT', 'PENDING', 'PICKED', 'STAGED', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED')
          THEN UPPER(BTRIM(status))
        WHEN UPPER(BTRIM(status)) IN ('OPEN', 'CREATED', 'NEW')
          THEN 'DRAFT'
        WHEN UPPER(BTRIM(status)) IN ('CONFIRMED', 'APPROVED', 'ALLOCATED')
          THEN 'PENDING'
        WHEN UPPER(BTRIM(status)) IN ('PICKING_DONE')
          THEN 'PICKED'
        WHEN UPPER(BTRIM(status)) IN ('READY', 'READY_TO_DISPATCH')
          THEN 'STAGED'
        WHEN UPPER(BTRIM(status)) IN ('PARTIAL', 'PARTIALLY_COMPLETED', 'PARTIAL_FULFILLED')
          THEN 'PARTIALLY_FULFILLED'
        WHEN UPPER(BTRIM(status)) IN ('FULFILLED', 'DISPATCHED', 'DELIVERED', 'DONE', 'CLOSED')
          THEN 'COMPLETED'
        ELSE 'PENDING'
      END;
  END LOOP;

  PERFORM set_config('app.company_id', '', true);
END $$;

ALTER TABLE do_header
DROP CONSTRAINT IF EXISTS do_header_status_check;

ALTER TABLE do_header
ADD CONSTRAINT do_header_status_check
CHECK (
  status IN (
    'DRAFT',
    'PENDING',
    'PICKED',
    'STAGED',
    'PARTIALLY_FULFILLED',
    'COMPLETED',
    'CANCELLED'
  )
);

ALTER TABLE do_header
ALTER COLUMN status SET DEFAULT 'PENDING';
