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
          WHEN status IN ('DRAFT', 'PICKED', 'STAGED', 'CANCELLED') THEN status
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
