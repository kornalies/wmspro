ALTER TABLE do_header
DROP CONSTRAINT IF EXISTS do_header_status_check;

ALTER TABLE do_header
DROP CONSTRAINT IF EXISTS ck_do_header_status;

-- Normalize historical/legacy statuses so the new constraint can be applied safely.
-- Canonical mapping:
-- OPEN/CREATED/NEW -> DRAFT
-- CONFIRMED/APPROVED/ALLOCATED -> PENDING
-- READY/READY_TO_DISPATCH -> STAGED
-- PARTIAL/*partial variants -> PARTIALLY_FULFILLED
-- FULFILLED/DISPATCHED/DELIVERED/DONE/CLOSED -> COMPLETED
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
      WHEN UPPER(BTRIM(status)) IN ('PARTIAL', 'PARTIALLY_COMPLETED', 'PARTIAL_FULFILLED')
        THEN 'PARTIALLY_FULFILLED'
      WHEN UPPER(BTRIM(status)) IN ('FULFILLED', 'DISPATCHED', 'DELIVERED', 'DONE', 'CLOSED')
        THEN 'COMPLETED'
      WHEN UPPER(BTRIM(status)) IN ('OPEN', 'CREATED', 'NEW')
        THEN 'DRAFT'
      WHEN UPPER(BTRIM(status)) IN ('CONFIRMED', 'APPROVED', 'ALLOCATED')
        THEN 'PENDING'
      WHEN UPPER(BTRIM(status)) IN ('READY', 'READY_TO_DISPATCH')
        THEN 'STAGED'
      ELSE 'PENDING'
    END
    WHERE company_id = company_row.id
      AND status IS DISTINCT FROM CASE
        WHEN status IS NULL OR BTRIM(status) = '' THEN 'PENDING'
        WHEN UPPER(BTRIM(status)) IN ('DRAFT', 'PENDING', 'PICKED', 'STAGED', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED')
          THEN UPPER(BTRIM(status))
        WHEN UPPER(BTRIM(status)) IN ('PARTIAL', 'PARTIALLY_COMPLETED', 'PARTIAL_FULFILLED')
          THEN 'PARTIALLY_FULFILLED'
        WHEN UPPER(BTRIM(status)) IN ('FULFILLED', 'DISPATCHED', 'DELIVERED', 'DONE', 'CLOSED')
          THEN 'COMPLETED'
        WHEN UPPER(BTRIM(status)) IN ('OPEN', 'CREATED', 'NEW')
          THEN 'DRAFT'
        WHEN UPPER(BTRIM(status)) IN ('CONFIRMED', 'APPROVED', 'ALLOCATED')
          THEN 'PENDING'
        WHEN UPPER(BTRIM(status)) IN ('READY', 'READY_TO_DISPATCH')
          THEN 'STAGED'
        ELSE 'PENDING'
      END;
  END LOOP;

  PERFORM set_config('app.company_id', '', true);
END $$;

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
