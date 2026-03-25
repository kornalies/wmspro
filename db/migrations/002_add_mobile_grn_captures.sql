-- Stores mobile OCR-captured GRN payloads for admin approval workflow.
CREATE TABLE IF NOT EXISTS mobile_grn_captures (
  id SERIAL PRIMARY KEY,
  capture_ref VARCHAR(50) UNIQUE NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  notes TEXT,
  approved_grn_id INTEGER REFERENCES grn_header(id),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mobile_grn_captures_status_created
  ON mobile_grn_captures(status, created_at DESC);
