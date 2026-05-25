ALTER TABLE stock_serial_numbers
  DROP CONSTRAINT IF EXISTS stock_serial_numbers_status_check;

ALTER TABLE stock_serial_numbers
  ADD CONSTRAINT stock_serial_numbers_status_check
  CHECK (status IN ('IN_STOCK', 'RESERVED', 'DISPATCHED', 'CANCELLED'));
