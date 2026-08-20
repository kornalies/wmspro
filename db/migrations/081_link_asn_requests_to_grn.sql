BEGIN;

-- Give the client portal's ASN request somewhere to land.
--
-- As shipped, client_portal_asn_requests was written by one route and read by
-- nobody: a client submitted an expected date and a paragraph of remarks, the
-- row sat at status REQUESTED forever, and no warehouse screen ever showed it.
-- There was also nothing on the request that a GRN could be built from -- no
-- items, no quantities -- so even a staff member who found the row by hand had
-- to retype the whole shipment.
--
-- This migration adds the two halves that were missing: line items on the
-- request, and a link from the GRN back to the request it fulfils.

-- ---------------------------------------------------------------------------
-- 1. Line items on an ASN request.
-- ---------------------------------------------------------------------------
-- item_id is NOT NULL and references the tenant's item master rather than
-- storing the client's own SKU text. That is the constraint that makes the
-- whole feature work: grn_line_items.item_id is NOT NULL too, so an ASN line
-- can be copied into a GRN line without a mapping step, a half-mapped state, or
-- a screen for staff to resolve names against the catalogue. The cost is that a
-- client cannot announce a SKU the tenant has never set up -- they have to ask
-- for it to be added first, which is the same conversation they have today.
--
-- expected_quantity is what the client SAYS is coming. It is deliberately never
-- copied into stock: the GRN records what actually arrived, and the gap between
-- the two is the variance the warehouse cares about.
CREATE TABLE IF NOT EXISTS client_portal_asn_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  asn_request_id INTEGER NOT NULL REFERENCES client_portal_asn_requests(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  expected_quantity INTEGER NOT NULL,
  uom VARCHAR(20),
  batch_no VARCHAR(100),
  expiry_date DATE,
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT client_portal_asn_lines_qty_check CHECK (expected_quantity > 0),
  UNIQUE (company_id, asn_request_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_client_portal_asn_lines_request
  ON client_portal_asn_lines(company_id, asn_request_id, line_number);

ALTER TABLE client_portal_asn_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_asn_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_portal_asn_lines_tenant_isolation ON client_portal_asn_lines;
CREATE POLICY client_portal_asn_lines_tenant_isolation
  ON client_portal_asn_lines
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

-- ---------------------------------------------------------------------------
-- 2. A reviewable lifecycle on the request header.
-- ---------------------------------------------------------------------------
-- status was a bare VARCHAR defaulting to 'REQUESTED' with no constraint and no
-- code path that ever changed it. Now it moves:
--
--   REQUESTED --accept--> ACCEPTED --grn saved--> RECEIVED
--   REQUESTED --reject--> REJECTED
--   REQUESTED|ACCEPTED --client withdraws--> CANCELLED
--
-- Every existing row is 'REQUESTED', so the CHECK below cannot fail on
-- backfill. It is added NOT VALID and then validated so the table scan does not
-- hold an ACCESS EXCLUSIVE lock for its duration.
ALTER TABLE client_portal_asn_requests
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS review_remarks TEXT;

ALTER TABLE client_portal_asn_requests
  DROP CONSTRAINT IF EXISTS client_portal_asn_requests_status_check;
ALTER TABLE client_portal_asn_requests
  ADD CONSTRAINT client_portal_asn_requests_status_check
  CHECK (status IN ('REQUESTED', 'ACCEPTED', 'REJECTED', 'RECEIVED', 'CANCELLED'))
  NOT VALID;
ALTER TABLE client_portal_asn_requests
  VALIDATE CONSTRAINT client_portal_asn_requests_status_check;

-- The staff queue is "everything still awaiting a decision, oldest first" --
-- the one query this feature runs on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_client_portal_asn_requests_status
  ON client_portal_asn_requests(company_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. The link itself.
-- ---------------------------------------------------------------------------
-- Deliberately NOT unique: a truck announced as one ASN can arrive as two
-- part-loads on different days, and forcing one GRN per request would make
-- staff choose between lying about what arrived and abandoning the link. The
-- request reaches RECEIVED on the first GRN that cites it; a second GRN against
-- the same request is allowed and leaves the status where it is.
ALTER TABLE grn_header
  ADD COLUMN IF NOT EXISTS asn_request_id INTEGER REFERENCES client_portal_asn_requests(id);

CREATE INDEX IF NOT EXISTS idx_grn_header_asn_request
  ON grn_header(company_id, asn_request_id)
  WHERE asn_request_id IS NOT NULL;

COMMIT;
