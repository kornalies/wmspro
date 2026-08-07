-- Teach the movement-tracking trigger about IN_TRANSIT.
--
-- fn_track_serial_movements is the ledger's single writer: it fires on every
-- status or warehouse change of a serial and classifies the transition. It has
-- never seen IN_TRANSIT (migration 070), so the two halves of a stock transfer
-- fall through its CASE to 'ADJUSTMENT' -- which is precisely the label the
-- Inventory Adjustment Report now uses for something else. Leaving it would make
-- both features misread the same rows.
--
-- Only the CASE changes. The rest of the function is reproduced verbatim from
-- migration 042 because CREATE OR REPLACE FUNCTION has no way to patch a body.

CREATE OR REPLACE FUNCTION public.fn_track_serial_movements()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_movement_number VARCHAR(50);
    v_warehouse_code VARCHAR(20);
    v_year INTEGER;
    v_sequence BIGINT;
    v_grn_header_id INTEGER;
    v_do_header_id INTEGER;
BEGIN
    IF (TG_OP = 'UPDATE' AND (
        OLD.status IS DISTINCT FROM NEW.status OR
        OLD.warehouse_id IS DISTINCT FROM NEW.warehouse_id OR
        OLD.zone_id IS DISTINCT FROM NEW.zone_id
    )) OR TG_OP = 'INSERT' THEN

        SELECT warehouse_code INTO v_warehouse_code
        FROM public.warehouses WHERE id = NEW.warehouse_id;
        v_warehouse_code := COALESCE(v_warehouse_code, 'NA');

        v_year := EXTRACT(YEAR FROM CURRENT_TIMESTAMP);
        v_sequence := nextval('public.stock_movement_number_seq');
        v_movement_number := 'MOV-' || v_warehouse_code || '-' || v_year || '-' || LPAD(v_sequence::TEXT, 8, '0');

        IF NEW.grn_line_item_id IS NOT NULL THEN
            SELECT grn_header_id INTO v_grn_header_id
            FROM public.grn_line_items
            WHERE id = NEW.grn_line_item_id;
        END IF;

        IF NEW.do_line_item_id IS NOT NULL THEN
            SELECT do_header_id INTO v_do_header_id
            FROM public.do_line_items
            WHERE id = NEW.do_line_item_id;
        END IF;

        INSERT INTO public.stock_movements (
            movement_number,
            movement_date,
            serial_number_id,
            serial_number,
            item_id,
            client_id,
            movement_type,
            from_warehouse_id,
            from_zone_id,
            from_status,
            to_warehouse_id,
            to_zone_id,
            to_status,
            quantity,
            grn_header_id,
            grn_line_id,
            do_header_id,
            do_line_id,
            created_by,
            is_system_generated,
            company_id
        ) VALUES (
            v_movement_number,
            CURRENT_TIMESTAMP,
            NEW.id,
            NEW.serial_number,
            NEW.item_id,
            NEW.client_id,
            CASE
                WHEN TG_OP = 'INSERT' THEN 'RECEIVE'
                WHEN OLD.status = 'IN_STOCK' AND NEW.status = 'RESERVED' THEN 'RESERVE'
                WHEN OLD.status = 'RESERVED' AND NEW.status = 'DISPATCHED' THEN 'DISPATCH'
                WHEN OLD.status = 'IN_STOCK' AND NEW.status = 'DISPATCHED' THEN 'DISPATCH'
                WHEN OLD.status = 'RESERVED' AND NEW.status = 'IN_STOCK' THEN 'UNRESERVE'
                -- Both legs of an inter-warehouse transfer. The outbound leg does
                -- not change warehouse_id -- the stock has left but has not
                -- arrived -- so without this it would be classified ADJUSTMENT
                -- and pollute the adjustment register.
                WHEN NEW.status = 'IN_TRANSIT' THEN 'TRANSFER'
                WHEN OLD.status = 'IN_TRANSIT' AND NEW.status = 'IN_STOCK' THEN 'TRANSFER'
                WHEN OLD.warehouse_id IS DISTINCT FROM NEW.warehouse_id OR OLD.zone_id IS DISTINCT FROM NEW.zone_id THEN 'TRANSFER'
                ELSE 'ADJUSTMENT'
            END,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.warehouse_id ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.zone_id ELSE NULL END,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
            NEW.warehouse_id,
            NEW.zone_id,
            NEW.status,
            1,
            v_grn_header_id,
            NEW.grn_line_item_id,
            v_do_header_id,
            NEW.do_line_item_id,
            -- created_by = 1, the system user, exactly as migration 042 had it.
            -- stock_movements.created_by is NOT NULL, so the trigger cannot leave
            -- it out; the application stamps the real actor afterwards.
            1,
            TRUE,
            NEW.company_id
        );
    END IF;

    RETURN NEW;
END;
$function$;
