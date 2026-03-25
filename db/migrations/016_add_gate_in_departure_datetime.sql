BEGIN;

ALTER TABLE gate_in
  ADD COLUMN IF NOT EXISTS departure_datetime TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_gate_in_departure_datetime
  ON gate_in(departure_datetime);

COMMIT;
