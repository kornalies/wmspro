-- Track A / A4: widen the DO status machine for the outbound tail.
--
-- Background
-- ----------
-- Outbound currently collapses pack, goods-issue, loading and delivery-finalize
-- into a single STAGED -> COMPLETED transition performed by
-- app/api/do/[id]/dispatch/route.ts. Tracks A1-A3 introduce real pack units,
-- goods issue documents and loads/delivery notes; each needs a DO status it can
-- park the order in.
--
-- This migration only WIDENS the allowed set. It performs no data change and
-- changes no existing behaviour:
--   * every currently-valid status stays valid and keeps its meaning
--   * dispatch still requires STAGED (see route guard) until 064/065 land
--   * PACKED is reachable via the workflow endpoint; ISSUED and LOADED are
--     reserved for the goods-issue and loading endpoints so operators cannot
--     walk a DO into a state that has no UI to leave it yet.
--
-- New canonical flow once the whole track lands:
--   DRAFT -> PENDING -> PICKED -> PACKED -> STAGED -> ISSUED -> LOADED -> COMPLETED
--
-- Two coupled objects must move together or packed orders silently reset:
--   1. do_header_status_check  (below)
--   2. public.update_do_totals (below) -- its zero-dispatch branch rewrites any
--      status outside its preserve list back to PENDING. Adding statuses to the
--      constraint without adding them here would mean a PACKED order reverts to
--      PENDING on the next line-item touch.

BEGIN;

ALTER TABLE do_header
DROP CONSTRAINT IF EXISTS do_header_status_check;

ALTER TABLE do_header
DROP CONSTRAINT IF EXISTS ck_do_header_status;

ALTER TABLE do_header
ADD CONSTRAINT do_header_status_check
CHECK (
  status IN (
    'DRAFT',
    'PENDING',
    'PICKED',
    'PACKED',
    'STAGED',
    'ISSUED',
    'LOADED',
    'PARTIALLY_FULFILLED',
    'COMPLETED',
    'CANCELLED'
  )
);

ALTER TABLE do_header
ALTER COLUMN status SET DEFAULT 'PENDING';

-- Preserve the new intermediate statuses in the zero-dispatch branch.
-- Everything else is byte-identical to migration 024.
CREATE OR REPLACE FUNCTION public.update_do_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_do_id INTEGER;
  v_total_requested INTEGER;
  v_total_dispatched INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_do_id := OLD.do_header_id;
  ELSE
    v_do_id := NEW.do_header_id;
  END IF;

  SELECT
    COALESCE(SUM(quantity_requested), 0),
    COALESCE(SUM(quantity_dispatched), 0)
  INTO v_total_requested, v_total_dispatched
  FROM do_line_items
  WHERE do_header_id = v_do_id;

  UPDATE do_header
  SET total_items = (
        SELECT COUNT(DISTINCT item_id)
        FROM do_line_items
        WHERE do_header_id = v_do_id
      ),
      total_quantity_requested = v_total_requested,
      total_quantity_dispatched = v_total_dispatched,
      status = CASE
        WHEN v_total_dispatched = 0 THEN CASE
          WHEN status IN ('DRAFT', 'PICKED', 'PACKED', 'STAGED', 'ISSUED', 'LOADED', 'CANCELLED') THEN status
          ELSE 'PENDING'
        END
        WHEN v_total_dispatched < v_total_requested THEN 'PARTIALLY_FULFILLED'
        WHEN v_total_requested > 0 AND v_total_dispatched = v_total_requested THEN 'COMPLETED'
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = v_do_id;

  RETURN NULL;
END;
$function$;

COMMIT;