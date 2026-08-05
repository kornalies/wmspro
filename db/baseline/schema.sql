--
-- PostgreSQL database dump
--

\restrict V9cKZ0KGIacLnkyr0aOlDQJNLiQHIBfep4lO7U0PetxOBRwjHxbgzSqdeNSu0LK

-- Dumped from database version 18.1
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: audit_log_function(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_log_function() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user_id INTEGER;
  v_company_id INTEGER;
  v_old JSONB;
  v_new JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_old := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
  ELSIF TG_OP = 'DELETE' THEN
    v_new := NULL;
    v_old := to_jsonb(OLD);
  ELSE
    RETURN NULL;
  END IF;

  v_user_id := COALESCE(
    NULLIF(v_new ->> 'updated_by', '')::INTEGER,
    NULLIF(v_new ->> 'created_by', '')::INTEGER,
    NULLIF(v_old ->> 'updated_by', '')::INTEGER,
    NULLIF(v_old ->> 'created_by', '')::INTEGER
  );

  v_company_id := COALESCE(
    NULLIF(v_new ->> 'company_id', '')::INTEGER,
    NULLIF(v_old ->> 'company_id', '')::INTEGER,
    NULLIF(current_setting('app.company_id', true), '')::INTEGER,
    1
  );

  INSERT INTO public.audit_logs (
    company_id,
    actor_user_id,
    actor_type,
    action,
    entity_type,
    entity_id,
    before,
    after,
    table_name,
    record_id,
    old_values,
    new_values,
    changed_by,
    changed_at
  ) VALUES (
    v_company_id,
    v_user_id,
    'system',
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END,
    TG_TABLE_NAME,
    COALESCE(v_new ->> 'id', v_old ->> 'id'),
    v_old,
    v_new,
    TG_TABLE_NAME,
    COALESCE(NULLIF(v_new ->> 'id', '')::INTEGER, NULLIF(v_old ->> 'id', '')::INTEGER),
    v_old,
    v_new,
    v_user_id,
    CURRENT_TIMESTAMP
  );

  RETURN NULL;
END;
$$;


--
-- Name: auto_create_asn_from_do(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_create_asn_from_do(p_do_header_id integer, p_created_by integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_asn_id INTEGER;
    v_asn_number VARCHAR(50);
    v_do RECORD;
    v_line RECORD;
    v_warehouse_id INTEGER;
BEGIN
    -- Get DO details
    SELECT 
        dh.warehouse_id,
        dh.client_id,
        dh.do_number
    INTO v_do
    FROM do_header dh
    WHERE dh.id = p_do_header_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DO not found: %', p_do_header_id;
    END IF;
    
    -- Generate ASN number
    v_asn_number := generate_asn_number(v_do.warehouse_id);
    
    -- Create ASN header
    INSERT INTO asn_header (
        asn_number,
        do_header_id,
        warehouse_id,
        client_id,
        status,
        created_by
    )
    VALUES (
        v_asn_number,
        p_do_header_id,
        v_do.warehouse_id,
        v_do.client_id,
        'DRAFT',
        p_created_by
    )
    RETURNING id INTO v_asn_id;
    
    -- Create ASN line items from DO line items
    FOR v_line IN 
        SELECT 
            id,
            line_number,
            item_id,
            quantity_dispatched,
            uom
        FROM do_line_items
        WHERE do_header_id = p_do_header_id
          AND quantity_dispatched > 0
    LOOP
        INSERT INTO asn_line_items (
            asn_header_id,
            line_number,
            do_line_item_id,
            item_id,
            quantity_shipped,
            uom
        )
        VALUES (
            v_asn_id,
            v_line.line_number,
            v_line.id,
            v_line.item_id,
            v_line.quantity_dispatched,
            v_line.uom
        );
    END LOOP;
    
    RAISE NOTICE 'ASN created: % for DO: %', v_asn_number, v_do.do_number;
    
    RETURN v_asn_id;
END;
$$;


--
-- Name: calculate_daily_kpis(integer, integer, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_daily_kpis(p_warehouse_id integer, p_user_id integer DEFAULT NULL::integer, p_date date DEFAULT CURRENT_DATE) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_grns INTEGER;
    v_items_received INTEGER;
    v_dos INTEGER;
    v_items_dispatched INTEGER;
    v_total_tasks INTEGER;
    v_total_minutes INTEGER;
    v_avg_duration DECIMAL;
    v_total_errors INTEGER;
    v_error_rate DECIMAL;
    v_avg_quality DECIMAL;
BEGIN
    -- Count GRNs
    SELECT COUNT(*), COALESCE(SUM(total_quantity), 0)
    INTO v_grns, v_items_received
    FROM grn_header
    WHERE warehouse_id = p_warehouse_id
      AND DATE(created_at) = p_date
      AND (p_user_id IS NULL OR created_by = p_user_id);
    
    -- Count DOs
    SELECT COUNT(*), COALESCE(SUM(total_quantity_dispatched), 0)
    INTO v_dos, v_items_dispatched
    FROM do_header
    WHERE warehouse_id = p_warehouse_id
      AND DATE(created_at) = p_date
      AND (p_user_id IS NULL OR created_by = p_user_id);
    
    -- Workforce metrics
    SELECT 
        COUNT(*),
        COALESCE(SUM(duration_minutes), 0),
        COALESCE(AVG(duration_minutes), 0),
        COALESCE(SUM(errors_count), 0),
        COALESCE(AVG(quality_score), 0)
    INTO v_total_tasks, v_total_minutes, v_avg_duration, v_total_errors, v_avg_quality
    FROM workforce_tasks
    WHERE warehouse_id = p_warehouse_id
      AND DATE(start_time) = p_date
      AND status = 'COMPLETED'
      AND (p_user_id IS NULL OR user_id = p_user_id);
    
    -- Calculate error rate
    IF v_total_tasks > 0 THEN
        v_error_rate := (v_total_errors::DECIMAL / v_total_tasks) * 100;
    ELSE
        v_error_rate := 0;
    END IF;
    
    -- Insert or update KPI summary
    INSERT INTO daily_kpi_summary (
        warehouse_id,
        user_id,
        kpi_date,
        grns_processed,
        items_received,
        dos_processed,
        items_dispatched,
        total_tasks,
        total_working_minutes,
        avg_task_duration,
        total_errors,
        error_rate,
        avg_quality_score,
        calculated_at
    )
    VALUES (
        p_warehouse_id,
        p_user_id,
        p_date,
        v_grns,
        v_items_received,
        v_dos,
        v_items_dispatched,
        v_total_tasks,
        v_total_minutes,
        v_avg_duration,
        v_total_errors,
        v_error_rate,
        v_avg_quality,
        NOW()
    )
    ON CONFLICT (warehouse_id, user_id, kpi_date)
    DO UPDATE SET
        grns_processed = EXCLUDED.grns_processed,
        items_received = EXCLUDED.items_received,
        dos_processed = EXCLUDED.dos_processed,
        items_dispatched = EXCLUDED.items_dispatched,
        total_tasks = EXCLUDED.total_tasks,
        total_working_minutes = EXCLUDED.total_working_minutes,
        avg_task_duration = EXCLUDED.avg_task_duration,
        total_errors = EXCLUDED.total_errors,
        error_rate = EXCLUDED.error_rate,
        avg_quality_score = EXCLUDED.avg_quality_score,
        calculated_at = EXCLUDED.calculated_at;
    
    RAISE NOTICE 'KPIs calculated for warehouse % user % on %', p_warehouse_id, COALESCE(p_user_id::TEXT, 'ALL'), p_date;
END;
$$;


--
-- Name: calculate_shelf_life(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_shelf_life() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.expiry_date IS NOT NULL THEN
        NEW.remaining_shelf_life_days := NEW.expiry_date - CURRENT_DATE;
    ELSE
        NEW.remaining_shelf_life_days := NULL;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: calculate_task_duration(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_task_duration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
        NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60;
    ELSE
        NEW.duration_minutes := NULL;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: check_stock_availability(integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_stock_availability(p_client_id integer, p_item_id integer, p_warehouse_id integer, p_quantity integer) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_available INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO v_available
    FROM stock_serial_numbers
    WHERE client_id = p_client_id
      AND item_id = p_item_id
      AND warehouse_id = p_warehouse_id
      AND status = 'IN_STOCK';
    
    RETURN v_available >= p_quantity;
END;
$$;


--
-- Name: cleanup_expired_tokens(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_tokens() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_deleted_count INTEGER;
BEGIN
    DELETE FROM refresh_tokens
    WHERE expires_at < NOW() - INTERVAL '7 days'; -- Keep for 7 days after expiry for audit
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    DELETE FROM password_reset_tokens
    WHERE expires_at < NOW() - INTERVAL '1 day'; -- Keep for 1 day after expiry
    
    RETURN v_deleted_count;
END;
$$;


--
-- Name: enforce_single_device_login(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_single_device_login() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- When a new refresh token is inserted, revoke all other tokens for this user
    UPDATE refresh_tokens
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = 'NEW_LOGIN'
    WHERE user_id = NEW.user_id 
      AND id != NEW.id 
      AND is_revoked = FALSE;
    
    RETURN NEW;
END;
$$;


--
-- Name: fn_create_stock_movement(integer, character varying, integer, integer, text, character varying, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_create_stock_movement(p_serial_number_id integer, p_movement_type character varying, p_to_warehouse_id integer, p_to_zone_id integer DEFAULT NULL::integer, p_reason text DEFAULT NULL::text, p_reference_number character varying DEFAULT NULL::character varying, p_created_by integer DEFAULT 1) RETURNS integer
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_movement_id INTEGER;
    v_movement_number VARCHAR(50);
    v_serial_record RECORD;
    v_warehouse_code VARCHAR(20);
    v_year INTEGER;
    v_sequence INTEGER;
BEGIN
    -- Get current serial number details
    SELECT * INTO v_serial_record
    FROM stock_serial_numbers
    WHERE id = p_serial_number_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Serial number ID % not found', p_serial_number_id;
    END IF;
    
    -- Generate movement number
    SELECT warehouse_code INTO v_warehouse_code 
    FROM warehouses WHERE id = p_to_warehouse_id;
    
    v_year := EXTRACT(YEAR FROM CURRENT_TIMESTAMP);
    
    SELECT COALESCE(MAX(CAST(SUBSTRING(movement_number FROM '\d+$') AS INTEGER)), 0) + 1
    INTO v_sequence
    FROM stock_movements
    WHERE movement_number LIKE 'MOV-' || v_warehouse_code || '-' || v_year || '-%';
    
    v_movement_number := 'MOV-' || v_warehouse_code || '-' || v_year || '-' || LPAD(v_sequence::TEXT, 5, '0');
    
    -- Create movement record
    INSERT INTO stock_movements (
        movement_number,
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
        reason,
        reference_number,
        created_by,
        is_system_generated
    ) VALUES (
        v_movement_number,
        p_serial_number_id,
        v_serial_record.serial_number,
        v_serial_record.item_id,
        v_serial_record.client_id,
        p_movement_type,
        v_serial_record.warehouse_id,
        v_serial_record.zone_id,
        v_serial_record.status,
        p_to_warehouse_id,
        p_to_zone_id,
        CASE 
            WHEN p_movement_type = 'DISPATCH' THEN 'DISPATCHED'
            WHEN p_movement_type = 'RESERVE' THEN 'RESERVED'
            ELSE 'IN_STOCK'
        END,
        1,
        p_reason,
        p_reference_number,
        p_created_by,
        FALSE -- Manual entry
    ) RETURNING id INTO v_movement_id;
    
    -- Update serial number location and status
    UPDATE stock_serial_numbers
    SET 
        warehouse_id = p_to_warehouse_id,
        zone_id = p_to_zone_id,
        status = CASE 
            WHEN p_movement_type = 'DISPATCH' THEN 'DISPATCHED'
            WHEN p_movement_type = 'RESERVE' THEN 'RESERVED'
            ELSE 'IN_STOCK'
        END,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = p_created_by
    WHERE id = p_serial_number_id;
    
    RETURN v_movement_id;
END;
$_$;


--
-- Name: fn_refresh_daily_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_refresh_daily_snapshot() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    REFRESH MATERIALIZED VIEW mv_daily_stock_snapshot;
    RAISE NOTICE 'Daily stock snapshot refreshed at %', NOW();
END;
$$;


--
-- Name: fn_track_serial_movements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_track_serial_movements() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
            1,
            TRUE,
            NEW.company_id
        );
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fuzzy_match_items(character varying, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fuzzy_match_items(p_search_text character varying, p_limit integer DEFAULT 5) RETURNS TABLE(item_id integer, item_code character varying, item_name character varying, similarity_score real)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        i.id,
        i.item_code,
        i.item_name,
        similarity(i.item_name, p_search_text) as sim_score
    FROM items i
    WHERE i.is_active = TRUE
      AND i.approval_status = 'APPROVED'
      AND similarity(i.item_name, p_search_text) > 0.3 -- 30% similarity threshold
    ORDER BY sim_score DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: generate_asn_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_asn_number(p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN generate_document_number('ASN', 'ASN', p_warehouse_id);
END;
$$;


--
-- Name: generate_do_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_do_number(p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN generate_document_number('DO', 'DO', p_warehouse_id);
END;
$$;


--
-- Name: generate_document_number(character varying, character varying, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_document_number(p_sequence_name character varying, p_prefix character varying, p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_warehouse_code VARCHAR(20);
    v_year INTEGER;
    v_next_num INTEGER;
    v_document_number VARCHAR(50);
BEGIN
    -- Get warehouse code
    SELECT warehouse_code INTO v_warehouse_code 
    FROM warehouses 
    WHERE id = p_warehouse_id;
    
    IF v_warehouse_code IS NULL THEN
        RAISE EXCEPTION 'Warehouse not found: %', p_warehouse_id;
    END IF;
    
    -- Get current year
    v_year := EXTRACT(YEAR FROM CURRENT_DATE);
    
    -- Get next sequence number (atomic operation)
    INSERT INTO sequence_counters (sequence_name, prefix, current_value, year, warehouse_id)
    VALUES (p_sequence_name, p_prefix, 1, v_year, p_warehouse_id)
    ON CONFLICT (sequence_name, year, warehouse_id) 
    DO UPDATE SET current_value = sequence_counters.current_value + 1
    RETURNING current_value INTO v_next_num;
    
    -- Format: GRN-CHN-2025-0001
    v_document_number := p_prefix || '-' || v_warehouse_code || '-' || v_year || '-' || LPAD(v_next_num::TEXT, 4, '0');
    
    RETURN v_document_number;
END;
$$;


--
-- Name: generate_gate_in_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_gate_in_number(p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN generate_document_number('GATE_IN', 'GIN', p_warehouse_id);
END;
$$;


--
-- Name: generate_gate_out_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_gate_out_number(p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN generate_document_number('GATE_OUT', 'GOUT', p_warehouse_id);
END;
$$;


--
-- Name: generate_grn_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_grn_number(p_warehouse_id integer) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN generate_document_number('GRN', 'GRN', p_warehouse_id);
END;
$$;


--
-- Name: generate_label_data(integer, character varying, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_label_data(p_template_id integer, p_reference_type character varying, p_reference_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_label_data JSONB;
    v_template RECORD;
BEGIN
    -- Get template details
    SELECT * INTO v_template
    FROM customer_label_templates
    WHERE id = p_template_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label template not found: %', p_template_id;
    END IF;
    
    -- Build label data based on reference type
    CASE p_reference_type
        WHEN 'ASN' THEN
            SELECT jsonb_build_object(
                'asn_number', ah.asn_number,
                'ship_to_name', ah.ship_to_name,
                'ship_to_address', ah.ship_to_address,
                'tracking_number', ah.tracking_number,
                'total_cartons', ah.total_cartons,
                'client_name', c.client_name
            )
            INTO v_label_data
            FROM asn_header ah
            JOIN clients c ON ah.client_id = c.id
            WHERE ah.id = p_reference_id;
            
        WHEN 'CARTON' THEN
            SELECT jsonb_build_object(
                'sscc', ac.sscc,
                'carton_number', ac.carton_number,
                'quantity', ac.quantity_in_carton,
                'weight', ac.gross_weight_kg,
                'item_code', i.item_code,
                'item_name', i.item_name
            )
            INTO v_label_data
            FROM asn_carton_details ac
            LEFT JOIN items i ON ac.item_id = i.id
            WHERE ac.id = p_reference_id;
            
        ELSE
            v_label_data := '{}'::JSONB;
    END CASE;
    
    -- Merge with template mappings
    v_label_data := v_label_data || v_template.field_mappings;
    
    RETURN v_label_data;
END;
$$;


--
-- Name: generate_sscc(character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_sscc(p_company_prefix character varying DEFAULT '1234567'::character varying, p_extension_digit character varying DEFAULT '0'::character varying) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_serial_part VARCHAR(10);
    v_sscc_without_check VARCHAR(17);
    v_check_digit INTEGER;
    v_sum INTEGER := 0;
    v_multiplier INTEGER;
    i INTEGER;
BEGIN
    -- Generate serial number part (sequence-based)
    SELECT LPAD(NEXTVAL('sscc_sequence')::TEXT, 9, '0') INTO v_serial_part;
    
    -- Construct SSCC without check digit (17 digits)
    v_sscc_without_check := p_extension_digit || p_company_prefix || v_serial_part;
    
    -- Calculate check digit using MOD 10 algorithm
    FOR i IN 1..17 LOOP
        -- Multiply by 3 for odd positions (from right), by 1 for even
        IF (17 - i + 1) % 2 = 0 THEN
            v_multiplier := 1;
        ELSE
            v_multiplier := 3;
        END IF;
        
        v_sum := v_sum + (SUBSTRING(v_sscc_without_check, i, 1)::INTEGER * v_multiplier);
    END LOOP;
    
    -- Check digit = (10 - (sum MOD 10)) MOD 10
    v_check_digit := (10 - (v_sum % 10)) % 10;
    
    -- Return complete 18-digit SSCC
    RETURN v_sscc_without_check || v_check_digit::TEXT;
END;
$$;


--
-- Name: get_available_stock_fefo(integer, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_available_stock_fefo(p_client_id integer, p_item_id integer, p_warehouse_id integer, p_quantity integer, p_min_shelf_life_days integer DEFAULT NULL::integer) RETURNS TABLE(serial_number character varying, batch_number character varying, expiry_date date, remaining_shelf_life_days integer, received_date date, zone_id integer, physical_location character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.serial_number,
        s.batch_number,
        s.expiry_date,
        s.remaining_shelf_life_days,
        s.received_date,
        s.zone_id,
        s.physical_location
    FROM stock_serial_numbers s
    WHERE s.client_id = p_client_id
      AND s.item_id = p_item_id
      AND s.warehouse_id = p_warehouse_id
      AND s.status = 'IN_STOCK'
      AND (p_min_shelf_life_days IS NULL OR s.remaining_shelf_life_days >= p_min_shelf_life_days)
    ORDER BY 
        s.expiry_date ASC NULLS LAST, -- Expiring items first
        s.received_date ASC, -- Then oldest received
        s.id ASC
    LIMIT p_quantity;
END;
$$;


--
-- Name: get_available_stock_fifo(integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_available_stock_fifo(p_client_id integer, p_item_id integer, p_warehouse_id integer, p_quantity integer) RETURNS TABLE(serial_number character varying, received_date date, zone_id integer, physical_location character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.serial_number,
        s.received_date,
        s.zone_id,
        s.physical_location
    FROM stock_serial_numbers s
    WHERE s.client_id = p_client_id
      AND s.item_id = p_item_id
      AND s.warehouse_id = p_warehouse_id
      AND s.status = 'IN_STOCK'
    ORDER BY s.received_date ASC, s.id ASC
    LIMIT p_quantity;
END;
$$;


--
-- Name: get_batch_traceability(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_traceability(p_batch_number character varying) RETURNS TABLE(item_code character varying, item_name character varying, client_name character varying, warehouse_name character varying, serial_number character varying, status character varying, received_date date, grn_number character varying, invoice_number character varying, dispatched_date date, do_number character varying, asn_number character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        i.item_code,
        i.item_name,
        c.client_name,
        w.warehouse_name,
        s.serial_number,
        s.status,
        s.received_date,
        gh.grn_number,
        gh.invoice_number,
        s.dispatched_date,
        dh.do_number,
        ah.asn_number
    FROM stock_serial_numbers s
    JOIN items i ON s.item_id = i.id
    JOIN clients c ON s.client_id = c.id
    JOIN warehouses w ON s.warehouse_id = w.id
    LEFT JOIN grn_line_items gli ON s.grn_line_item_id = gli.id
    LEFT JOIN grn_header gh ON gli.grn_header_id = gh.id
    LEFT JOIN do_line_items dli ON s.do_line_item_id = dli.id
    LEFT JOIN do_header dh ON dli.do_header_id = dh.id
    LEFT JOIN asn_line_items ali ON dli.id = ali.do_line_item_id
    LEFT JOIN asn_header ah ON ali.asn_header_id = ah.id
    WHERE s.batch_number = p_batch_number
    ORDER BY s.received_date;
END;
$$;


--
-- Name: get_client_monthly_billing_data(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_client_monthly_billing_data(p_client_id integer, p_year integer, p_month integer) RETURNS TABLE(grn_number character varying, grn_date date, invoice_number character varying, total_items integer, total_quantity integer, base_labor_charge numeric, forklift_charge numeric, total_labor_cost numeric)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        gh.grn_number,
        gh.grn_date,
        gh.invoice_number,
        gh.total_items,
        gh.total_quantity,
        gh.base_labor_charge,
        gh.forklift_charge,
        gh.total_labor_cost
    FROM grn_header gh
    WHERE gh.client_id = p_client_id
      AND EXTRACT(YEAR FROM gh.grn_date) = p_year
      AND EXTRACT(MONTH FROM gh.grn_date) = p_month
      AND gh.status = 'CONFIRMED'
    ORDER BY gh.grn_date ASC;
END;
$$;


--
-- Name: record_login_attempt(character varying, boolean, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_login_attempt(p_username character varying, p_success boolean, p_ip_address character varying DEFAULT NULL::character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_id INTEGER;
    v_failed_attempts INTEGER;
BEGIN
    -- Get user
    SELECT id, failed_login_attempts INTO v_user_id, v_failed_attempts
    FROM users
    WHERE username = p_username;
    
    IF v_user_id IS NULL THEN
        RETURN; -- User doesn't exist, don't reveal this
    END IF;
    
    IF p_success THEN
        -- Successful login: reset failed attempts and update last login
        UPDATE users
        SET failed_login_attempts = 0,
            locked_until = NULL,
            last_login_at = NOW()
        WHERE id = v_user_id;
    ELSE
        -- Failed login: increment counter
        v_failed_attempts := v_failed_attempts + 1;
        
        UPDATE users
        SET failed_login_attempts = v_failed_attempts,
            locked_until = CASE 
                WHEN v_failed_attempts >= 5 THEN NOW() + INTERVAL '30 minutes'
                ELSE locked_until
            END
        WHERE id = v_user_id;
    END IF;
END;
$$;


--
-- Name: revoke_user_tokens(integer, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_user_tokens(p_user_id integer, p_reason character varying DEFAULT 'PASSWORD_CHANGED'::character varying) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_revoked_count INTEGER;
BEGIN
    UPDATE refresh_tokens
    SET is_revoked = TRUE,
        revoked_at = NOW(),
        revoked_reason = p_reason
    WHERE user_id = p_user_id 
      AND is_revoked = FALSE;
    
    GET DIAGNOSTICS v_revoked_count = ROW_COUNT;
    
    RETURN v_revoked_count;
END;
$$;


--
-- Name: update_asn_totals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_asn_totals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_asn_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_asn_id := OLD.asn_header_id;
    ELSE
        v_asn_id := NEW.asn_header_id;
    END IF;
    
    UPDATE asn_header
    SET updated_at = NOW()
    WHERE id = v_asn_id;
    
    RETURN NULL;
END;
$$;


--
-- Name: update_do_totals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_do_totals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: update_grn_totals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_grn_totals() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_grn_id INTEGER;
BEGIN
    -- Get GRN ID from trigger
    IF TG_OP = 'DELETE' THEN
        v_grn_id := OLD.grn_header_id;
    ELSE
        v_grn_id := NEW.grn_header_id;
    END IF;
    
    -- Update GRN header totals
    UPDATE grn_header
    SET total_items = (
            SELECT COUNT(DISTINCT item_id)
            FROM grn_line_items
            WHERE grn_header_id = v_grn_id
        ),
        total_quantity = (
            SELECT COALESCE(SUM(quantity), 0)
            FROM grn_line_items
            WHERE grn_header_id = v_grn_id
        ),
        total_value = (
            SELECT COALESCE(SUM(line_total), 0)
            FROM grn_line_items
            WHERE grn_header_id = v_grn_id
        ),
        updated_at = NOW()
    WHERE id = v_grn_id;
    
    RETURN NULL;
END;
$$;


--
-- Name: update_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: validate_shelf_life_for_dispatch(integer, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_shelf_life_for_dispatch(p_item_id integer, p_serial_numbers text[]) RETURNS TABLE(is_valid boolean, serial_number character varying, remaining_shelf_life_days integer, required_min_shelf_life_days integer, validation_message text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        CASE 
            WHEN s.remaining_shelf_life_days IS NULL THEN TRUE -- No expiry tracking
            WHEN s.remaining_shelf_life_days >= COALESCE(i.min_shelf_life_days, 0) THEN TRUE
            ELSE FALSE
        END as is_valid,
        s.serial_number,
        s.remaining_shelf_life_days,
        i.min_shelf_life_days,
        CASE 
            WHEN s.remaining_shelf_life_days IS NULL THEN 'OK - No expiry tracking'
            WHEN s.remaining_shelf_life_days >= COALESCE(i.min_shelf_life_days, 0) THEN 'OK'
            ELSE 'FAILED - Insufficient shelf life'
        END as validation_message
    FROM stock_serial_numbers s
    JOIN items i ON s.item_id = i.id
    WHERE s.item_id = p_item_id
      AND s.serial_number = ANY(p_serial_numbers);
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: api_idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_idempotency_keys (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    key_hash character varying(120) NOT NULL,
    route_key character varying(160) NOT NULL,
    response_body jsonb NOT NULL,
    status_code integer DEFAULT 200 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: api_idempotency_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_idempotency_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_idempotency_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_idempotency_keys_id_seq OWNED BY public.api_idempotency_keys.id;


--
-- Name: asn_carton_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asn_carton_details (
    id integer NOT NULL,
    asn_header_id integer NOT NULL,
    asn_line_item_id integer,
    sscc character varying(20) NOT NULL,
    carton_number integer NOT NULL,
    item_id integer,
    quantity_in_carton integer NOT NULL,
    gross_weight_kg numeric(10,2),
    net_weight_kg numeric(10,2),
    length_cm numeric(10,2),
    width_cm numeric(10,2),
    height_cm numeric(10,2),
    pallet_sscc character varying(20),
    pallet_position integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.asn_carton_details FORCE ROW LEVEL SECURITY;


--
-- Name: asn_carton_details_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asn_carton_details_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asn_carton_details_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asn_carton_details_id_seq OWNED BY public.asn_carton_details.id;


--
-- Name: asn_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asn_header (
    id integer NOT NULL,
    asn_number character varying(50) NOT NULL,
    do_header_id integer,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    customer_po_number character varying(100),
    customer_delivery_number character varying(100),
    ship_to_name character varying(200),
    ship_to_address text,
    ship_to_city character varying(100),
    ship_to_state character varying(100),
    ship_to_pincode character varying(20),
    ship_to_country character varying(50) DEFAULT 'India'::character varying,
    carrier_name character varying(200),
    tracking_number character varying(100),
    pro_number character varying(100),
    estimated_delivery_date date,
    actual_ship_date timestamp without time zone,
    total_cartons integer DEFAULT 0,
    total_pallets integer DEFAULT 0,
    total_weight_kg numeric(10,2),
    total_volume_cubic_m numeric(10,3),
    edi_format character varying(50),
    edi_sent_at timestamp without time zone,
    edi_acknowledged_at timestamp without time zone,
    edi_file_path text,
    status character varying(50) DEFAULT 'DRAFT'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT asn_header_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'READY'::character varying, 'TRANSMITTED'::character varying, 'ACKNOWLEDGED'::character varying, 'DELIVERED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.asn_header FORCE ROW LEVEL SECURITY;


--
-- Name: asn_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asn_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asn_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asn_header_id_seq OWNED BY public.asn_header.id;


--
-- Name: asn_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asn_line_items (
    id integer NOT NULL,
    asn_header_id integer NOT NULL,
    line_number integer NOT NULL,
    do_line_item_id integer,
    item_id integer NOT NULL,
    quantity_shipped integer NOT NULL,
    uom character varying(20) NOT NULL,
    carton_count integer DEFAULT 0,
    pallet_count integer DEFAULT 0,
    customer_item_code character varying(100),
    upc_code character varying(50),
    batch_number character varying(100),
    expiry_date date,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT asn_line_items_quantity_shipped_check CHECK ((quantity_shipped > 0))
);

ALTER TABLE ONLY public.asn_line_items FORCE ROW LEVEL SECURITY;


--
-- Name: asn_line_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asn_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asn_line_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asn_line_items_id_seq OWNED BY public.asn_line_items.id;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    attachment_type character varying(80) NOT NULL,
    reference_type character varying(80) NOT NULL,
    reference_no character varying(120) NOT NULL,
    file_name character varying(255) NOT NULL,
    content_type character varying(120),
    file_size_bytes bigint,
    remarks text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    file_data bytea
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    table_name character varying(100),
    record_id integer,
    action text NOT NULL,
    old_values jsonb,
    new_values jsonb,
    changed_by integer,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    ip_address character varying(50),
    user_agent text,
    company_id integer NOT NULL,
    actor_user_id integer,
    actor_type text DEFAULT 'web'::text NOT NULL,
    entity_type text,
    entity_id text,
    before jsonb,
    after jsonb,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: billing_invoice_seq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_invoice_seq (
    company_id integer NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.billing_invoice_seq FORCE ROW LEVEL SECURITY;


--
-- Name: billing_job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_job_runs (
    id integer NOT NULL,
    company_id integer NOT NULL,
    job_type character varying(40) NOT NULL,
    run_key character varying(120) NOT NULL,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp without time zone,
    status character varying(20) DEFAULT 'RUNNING'::character varying NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by integer,
    CONSTRAINT ck_bjr_status CHECK (((status)::text = ANY ((ARRAY['RUNNING'::character varying, 'SUCCESS'::character varying, 'FAILED'::character varying, 'SKIPPED'::character varying])::text[])))
);

ALTER TABLE ONLY public.billing_job_runs FORCE ROW LEVEL SECURITY;


--
-- Name: billing_job_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.billing_job_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: billing_job_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.billing_job_runs_id_seq OWNED BY public.billing_job_runs.id;


--
-- Name: billing_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_transactions (
    id integer NOT NULL,
    company_id integer NOT NULL,
    client_id integer NOT NULL,
    warehouse_id integer,
    charge_type character varying(30) NOT NULL,
    source_type character varying(20) NOT NULL,
    source_doc_id integer,
    source_line_id integer,
    source_ref_no character varying(120),
    event_date date NOT NULL,
    period_from date,
    period_to date,
    uom character varying(20) DEFAULT 'UNIT'::character varying NOT NULL,
    quantity numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,4) DEFAULT 0 NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    tax_code character varying(30) DEFAULT 'GST'::character varying NOT NULL,
    gst_rate numeric(6,3) DEFAULT 18 NOT NULL,
    cgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    igst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    gross_amount numeric(14,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'UNBILLED'::character varying NOT NULL,
    billed_at timestamp without time zone,
    billed_by integer,
    rate_master_id integer,
    rate_detail_id integer,
    remarks text,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    invoice_id integer,
    CONSTRAINT ck_bt_charge_type CHECK (((charge_type)::text = ANY ((ARRAY['INBOUND_HANDLING'::character varying, 'OUTBOUND_HANDLING'::character varying, 'STORAGE'::character varying, 'VAS'::character varying, 'FIXED'::character varying, 'MINIMUM'::character varying, 'ADJUSTMENT'::character varying])::text[]))),
    CONSTRAINT ck_bt_period_range CHECK (((period_to IS NULL) OR (period_from IS NULL) OR (period_to >= period_from))),
    CONSTRAINT ck_bt_qty_rate_amount CHECK (((quantity >= (0)::numeric) AND (rate >= (0)::numeric) AND (amount >= (0)::numeric))),
    CONSTRAINT ck_bt_source_type CHECK (((source_type)::text = ANY ((ARRAY['GRN'::character varying, 'DO'::character varying, 'VAS'::character varying, 'STORAGE'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT ck_bt_status CHECK (((status)::text = ANY ((ARRAY['UNRATED'::character varying, 'UNBILLED'::character varying, 'BILLED'::character varying, 'VOID'::character varying])::text[]))),
    CONSTRAINT ck_bt_tax_non_negative CHECK (((gst_rate >= (0)::numeric) AND (cgst_amount >= (0)::numeric) AND (sgst_amount >= (0)::numeric) AND (igst_amount >= (0)::numeric) AND (total_tax_amount >= (0)::numeric) AND (gross_amount >= (0)::numeric)))
);

ALTER TABLE ONLY public.billing_transactions FORCE ROW LEVEL SECURITY;


--
-- Name: billing_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.billing_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: billing_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.billing_transactions_id_seq OWNED BY public.billing_transactions.id;


--
-- Name: chart_of_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chart_of_accounts (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    account_code character varying(20) NOT NULL,
    account_name character varying(150) NOT NULL,
    account_type character varying(20) NOT NULL,
    parent_account_id integer,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chart_of_accounts_account_type_check CHECK (((account_type)::text = ANY ((ARRAY['ASSET'::character varying, 'LIABILITY'::character varying, 'EQUITY'::character varying, 'INCOME'::character varying, 'EXPENSE'::character varying])::text[])))
);


--
-- Name: chart_of_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chart_of_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chart_of_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chart_of_accounts_id_seq OWNED BY public.chart_of_accounts.id;


--
-- Name: client_billing_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_billing_profile (
    id integer NOT NULL,
    company_id integer NOT NULL,
    client_id integer NOT NULL,
    billing_cycle character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    billing_day_of_week smallint,
    billing_day_of_month smallint DEFAULT 1 NOT NULL,
    storage_billing_method character varying(20) DEFAULT 'SNAPSHOT'::character varying NOT NULL,
    storage_grace_days integer DEFAULT 0 NOT NULL,
    credit_days integer DEFAULT 30 NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    invoice_prefix character varying(20) DEFAULT 'INV'::character varying NOT NULL,
    minimum_billing_enabled boolean DEFAULT false NOT NULL,
    minimum_billing_amount numeric(14,2) DEFAULT 0 NOT NULL,
    auto_finalize boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_cbp_billing_cycle CHECK (((billing_cycle)::text = ANY ((ARRAY['WEEKLY'::character varying, 'MONTHLY'::character varying, 'QUARTERLY'::character varying, 'YEARLY'::character varying])::text[]))),
    CONSTRAINT ck_cbp_credit_days CHECK ((credit_days >= 0)),
    CONSTRAINT ck_cbp_day_of_month CHECK (((billing_day_of_month >= 1) AND (billing_day_of_month <= 28))),
    CONSTRAINT ck_cbp_day_of_week CHECK (((billing_day_of_week IS NULL) OR ((billing_day_of_week >= 1) AND (billing_day_of_week <= 7)))),
    CONSTRAINT ck_cbp_min_amount CHECK ((minimum_billing_amount >= (0)::numeric)),
    CONSTRAINT ck_cbp_storage_grace CHECK ((storage_grace_days >= 0)),
    CONSTRAINT ck_cbp_storage_method CHECK (((storage_billing_method)::text = ANY ((ARRAY['SNAPSHOT'::character varying, 'DURATION'::character varying])::text[])))
);

ALTER TABLE ONLY public.client_billing_profile FORCE ROW LEVEL SECURITY;


--
-- Name: client_billing_profile_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_billing_profile_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_billing_profile_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_billing_profile_id_seq OWNED BY public.client_billing_profile.id;


--
-- Name: client_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_contacts (
    id integer NOT NULL,
    client_id integer NOT NULL,
    contact_person_name character varying(100) NOT NULL,
    designation character varying(100),
    phone character varying(15),
    email character varying(100),
    is_primary boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.client_contacts FORCE ROW LEVEL SECURITY;


--
-- Name: client_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_contacts_id_seq OWNED BY public.client_contacts.id;


--
-- Name: client_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_contracts (
    id integer NOT NULL,
    company_id integer NOT NULL,
    client_id integer NOT NULL,
    contract_code character varying(50) NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    storage_rate_per_unit numeric(12,2) DEFAULT 0 NOT NULL,
    handling_rate_per_unit numeric(12,2) DEFAULT 0 NOT NULL,
    minimum_guarantee_amount numeric(14,2) DEFAULT 0 NOT NULL,
    billing_cycle character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_client_contracts_billing_cycle CHECK (((billing_cycle)::text = ANY ((ARRAY['MONTHLY'::character varying, 'QUARTERLY'::character varying, 'YEARLY'::character varying])::text[]))),
    CONSTRAINT ck_client_contracts_date_range CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))
);

ALTER TABLE ONLY public.client_contracts FORCE ROW LEVEL SECURITY;


--
-- Name: client_contracts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_contracts_id_seq OWNED BY public.client_contracts.id;


--
-- Name: client_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_documents (
    id integer NOT NULL,
    client_id integer NOT NULL,
    document_type character varying(50) NOT NULL,
    document_name character varying(200),
    file_path text NOT NULL,
    file_size_kb integer,
    uploaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    uploaded_by integer,
    is_active boolean DEFAULT true,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT client_documents_document_type_check CHECK (((document_type)::text = ANY ((ARRAY['GST_CERTIFICATE'::character varying, 'MSME'::character varying, 'CONTRACT'::character varying, 'PAN'::character varying, 'OTHER'::character varying])::text[])))
);

ALTER TABLE ONLY public.client_documents FORCE ROW LEVEL SECURITY;


--
-- Name: client_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_documents_id_seq OWNED BY public.client_documents.id;


--
-- Name: client_portal_asn_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_portal_asn_requests (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    client_id integer NOT NULL,
    request_number character varying(80) NOT NULL,
    expected_date date,
    remarks text,
    status character varying(30) DEFAULT 'REQUESTED'::character varying NOT NULL,
    requested_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: client_portal_asn_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_portal_asn_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_portal_asn_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_portal_asn_requests_id_seq OWNED BY public.client_portal_asn_requests.id;


--
-- Name: client_rate_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_rate_details (
    id integer NOT NULL,
    company_id integer NOT NULL,
    rate_master_id integer NOT NULL,
    charge_type character varying(30) NOT NULL,
    calc_method character varying(20) DEFAULT 'PER_UNIT'::character varying NOT NULL,
    uom character varying(20) DEFAULT 'UNIT'::character varying NOT NULL,
    min_qty numeric(14,3),
    max_qty numeric(14,3),
    free_qty numeric(14,3) DEFAULT 0 NOT NULL,
    unit_rate numeric(14,4) DEFAULT 0 NOT NULL,
    min_charge numeric(14,2) DEFAULT 0 NOT NULL,
    max_charge numeric(14,2),
    tax_code character varying(30) DEFAULT 'GST'::character varying NOT NULL,
    gst_rate numeric(6,3) DEFAULT 18 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    slab_mode character varying(20) DEFAULT 'ABSOLUTE'::character varying NOT NULL,
    item_id integer,
    CONSTRAINT ck_crd_amounts CHECK (((free_qty >= (0)::numeric) AND (unit_rate >= (0)::numeric) AND (min_charge >= (0)::numeric) AND ((max_charge IS NULL) OR (max_charge >= (0)::numeric)))),
    CONSTRAINT ck_crd_calc_method CHECK (((calc_method)::text = ANY ((ARRAY['FLAT'::character varying, 'PER_UNIT'::character varying, 'SLAB'::character varying, 'PERCENT'::character varying])::text[]))),
    CONSTRAINT ck_crd_charge_type CHECK (((charge_type)::text = ANY ((ARRAY['INBOUND_HANDLING'::character varying, 'OUTBOUND_HANDLING'::character varying, 'STORAGE'::character varying, 'VAS'::character varying, 'FIXED'::character varying, 'MINIMUM'::character varying])::text[]))),
    CONSTRAINT ck_crd_gst_rate CHECK ((gst_rate >= (0)::numeric)),
    CONSTRAINT ck_crd_qty_range CHECK ((((min_qty IS NULL) OR (min_qty >= (0)::numeric)) AND ((max_qty IS NULL) OR (max_qty >= (0)::numeric)) AND ((max_qty IS NULL) OR (min_qty IS NULL) OR (max_qty >= min_qty)))),
    CONSTRAINT ck_crd_slab_mode CHECK (((slab_mode)::text = ANY ((ARRAY['ABSOLUTE'::character varying, 'MARGINAL'::character varying])::text[])))
);

ALTER TABLE ONLY public.client_rate_details FORCE ROW LEVEL SECURITY;


--
-- Name: client_rate_details_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_rate_details_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_rate_details_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_rate_details_id_seq OWNED BY public.client_rate_details.id;


--
-- Name: client_rate_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_rate_master (
    id integer NOT NULL,
    company_id integer NOT NULL,
    client_id integer NOT NULL,
    rate_card_code character varying(50) NOT NULL,
    rate_card_name character varying(120) NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    billing_cycle character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    tax_inclusive boolean DEFAULT false NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_crm_billing_cycle CHECK (((billing_cycle)::text = ANY ((ARRAY['WEEKLY'::character varying, 'MONTHLY'::character varying, 'QUARTERLY'::character varying, 'YEARLY'::character varying])::text[]))),
    CONSTRAINT ck_crm_date_range CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT ck_crm_priority CHECK ((priority >= 0))
);

ALTER TABLE ONLY public.client_rate_master FORCE ROW LEVEL SECURITY;


--
-- Name: client_rate_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_rate_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_rate_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_rate_master_id_seq OWNED BY public.client_rate_master.id;


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id integer NOT NULL,
    client_code character varying(20) NOT NULL,
    client_name character varying(200) NOT NULL,
    company_legal_name character varying(200),
    gst_number character varying(15),
    pan_number character varying(10),
    msme_number character varying(50),
    registered_address text,
    city character varying(50),
    state character varying(50),
    pincode character varying(10),
    country character varying(50) DEFAULT 'India'::character varying,
    contract_start_date date,
    contract_end_date date,
    contract_type character varying(50),
    base_labor_rate numeric(10,2),
    forklift_rate numeric(10,2),
    storage_rate_per_day numeric(10,2),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    contact_person character varying(150),
    contact_email character varying(255),
    contact_phone character varying(30)
);

ALTER TABLE ONLY public.clients FORCE ROW LEVEL SECURITY;


--
-- Name: clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clients_id_seq OWNED BY public.clients.id;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id integer NOT NULL,
    company_code character varying(50) NOT NULL,
    company_name character varying(150) NOT NULL,
    domain character varying(150),
    storage_bucket character varying(120),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    subscription_plan character varying(30) DEFAULT 'BASIC'::character varying NOT NULL,
    storage_used_gb numeric(12,2) DEFAULT 0 NOT NULL,
    billing_status character varying(20) DEFAULT 'TRIAL'::character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT companies_billing_status_check CHECK (((billing_status)::text = ANY ((ARRAY['TRIAL'::character varying, 'ACTIVE'::character varying, 'PAST_DUE'::character varying, 'SUSPENDED'::character varying])::text[]))),
    CONSTRAINT companies_subscription_plan_check CHECK (((subscription_plan)::text = ANY ((ARRAY['BASIC'::character varying, 'PRO'::character varying, 'ENTERPRISE'::character varying])::text[])))
);


--
-- Name: companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: companies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.companies_id_seq OWNED BY public.companies.id;


--
-- Name: credit_note_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_note_header (
    id integer NOT NULL,
    company_id integer NOT NULL,
    note_number character varying(80) NOT NULL,
    invoice_id integer NOT NULL,
    client_id integer NOT NULL,
    note_date date NOT NULL,
    reason text NOT NULL,
    taxable_amount numeric(14,2) DEFAULT 0 NOT NULL,
    cgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    igst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    grand_total numeric(14,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'ISSUED'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_cnh_amounts CHECK (((taxable_amount >= (0)::numeric) AND (cgst_amount >= (0)::numeric) AND (sgst_amount >= (0)::numeric) AND (igst_amount >= (0)::numeric) AND (total_tax_amount >= (0)::numeric) AND (grand_total >= (0)::numeric))),
    CONSTRAINT ck_cnh_status CHECK (((status)::text = ANY ((ARRAY['ISSUED'::character varying, 'APPLIED'::character varying, 'VOID'::character varying])::text[])))
);

ALTER TABLE ONLY public.credit_note_header FORCE ROW LEVEL SECURITY;


--
-- Name: credit_note_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.credit_note_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credit_note_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.credit_note_header_id_seq OWNED BY public.credit_note_header.id;


--
-- Name: credit_note_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_note_lines (
    id integer NOT NULL,
    company_id integer NOT NULL,
    credit_note_id integer NOT NULL,
    invoice_line_id integer,
    line_no integer NOT NULL,
    description text NOT NULL,
    quantity numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,4) DEFAULT 0 NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(6,3) DEFAULT 0 NOT NULL,
    tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    gross_amount numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT ck_cnl_amounts CHECK (((quantity >= (0)::numeric) AND (rate >= (0)::numeric) AND (amount >= (0)::numeric) AND (tax_rate >= (0)::numeric) AND (tax_amount >= (0)::numeric) AND (gross_amount >= (0)::numeric)))
);

ALTER TABLE ONLY public.credit_note_lines FORCE ROW LEVEL SECURITY;


--
-- Name: credit_note_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.credit_note_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credit_note_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.credit_note_lines_id_seq OWNED BY public.credit_note_lines.id;


--
-- Name: customer_label_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_label_templates (
    id integer NOT NULL,
    client_id integer NOT NULL,
    template_name character varying(200) NOT NULL,
    template_code character varying(50) NOT NULL,
    label_type character varying(50) NOT NULL,
    label_format character varying(50),
    label_size character varying(50),
    template_content text,
    field_mappings jsonb,
    barcode_type character varying(50),
    include_sscc boolean DEFAULT false,
    include_batch boolean DEFAULT false,
    include_expiry boolean DEFAULT false,
    printer_name character varying(200),
    printer_dpi integer DEFAULT 203,
    is_active boolean DEFAULT true,
    is_default boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.customer_label_templates FORCE ROW LEVEL SECURITY;


--
-- Name: customer_label_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_label_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_label_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_label_templates_id_seq OWNED BY public.customer_label_templates.id;


--
-- Name: cycle_count_plan_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_count_plan_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_count_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_count_plans (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    plan_number character varying(64) NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer,
    strategy character varying(20) DEFAULT 'ZONE'::character varying NOT NULL,
    blind_count boolean DEFAULT true NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    zone_code character varying(50),
    total_tasks integer DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by integer,
    closed_at timestamp without time zone,
    closed_by integer,
    CONSTRAINT ck_ccp_status CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'COUNTING'::character varying, 'CLOSED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT ck_ccp_strategy CHECK (((strategy)::text = ANY ((ARRAY['ZONE'::character varying, 'ABC'::character varying, 'MANUAL'::character varying])::text[]))),
    CONSTRAINT cycle_count_plans_total_tasks_check CHECK ((total_tasks >= 0))
);


--
-- Name: cycle_count_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_count_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_count_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cycle_count_plans_id_seq OWNED BY public.cycle_count_plans.id;


--
-- Name: daily_kpi_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_kpi_summary (
    id integer NOT NULL,
    warehouse_id integer NOT NULL,
    user_id integer,
    kpi_date date NOT NULL,
    grns_processed integer DEFAULT 0,
    items_received integer DEFAULT 0,
    dos_processed integer DEFAULT 0,
    items_dispatched integer DEFAULT 0,
    total_tasks integer DEFAULT 0,
    total_working_minutes integer DEFAULT 0,
    avg_task_duration numeric(10,2),
    total_errors integer DEFAULT 0,
    error_rate numeric(5,2),
    avg_quality_score numeric(5,2),
    picking_lines_completed integer DEFAULT 0,
    packing_cartons integer DEFAULT 0,
    putaway_items integer DEFAULT 0,
    calculated_at timestamp without time zone,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.daily_kpi_summary FORCE ROW LEVEL SECURITY;


--
-- Name: daily_kpi_summary_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_kpi_summary_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_kpi_summary_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_kpi_summary_id_seq OWNED BY public.daily_kpi_summary.id;


--
-- Name: debit_note_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debit_note_header (
    id integer NOT NULL,
    company_id integer NOT NULL,
    note_number character varying(80) NOT NULL,
    invoice_id integer NOT NULL,
    client_id integer NOT NULL,
    note_date date NOT NULL,
    reason text NOT NULL,
    taxable_amount numeric(14,2) DEFAULT 0 NOT NULL,
    cgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    igst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    grand_total numeric(14,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'ISSUED'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_dnh_amounts CHECK (((taxable_amount >= (0)::numeric) AND (cgst_amount >= (0)::numeric) AND (sgst_amount >= (0)::numeric) AND (igst_amount >= (0)::numeric) AND (total_tax_amount >= (0)::numeric) AND (grand_total >= (0)::numeric))),
    CONSTRAINT ck_dnh_status CHECK (((status)::text = ANY ((ARRAY['ISSUED'::character varying, 'APPLIED'::character varying, 'VOID'::character varying])::text[])))
);

ALTER TABLE ONLY public.debit_note_header FORCE ROW LEVEL SECURITY;


--
-- Name: debit_note_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.debit_note_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: debit_note_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.debit_note_header_id_seq OWNED BY public.debit_note_header.id;


--
-- Name: debit_note_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debit_note_lines (
    id integer NOT NULL,
    company_id integer NOT NULL,
    debit_note_id integer NOT NULL,
    invoice_line_id integer,
    line_no integer NOT NULL,
    description text NOT NULL,
    quantity numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,4) DEFAULT 0 NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(6,3) DEFAULT 0 NOT NULL,
    tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    gross_amount numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT ck_dnl_amounts CHECK (((quantity >= (0)::numeric) AND (rate >= (0)::numeric) AND (amount >= (0)::numeric) AND (tax_rate >= (0)::numeric) AND (tax_amount >= (0)::numeric) AND (gross_amount >= (0)::numeric)))
);

ALTER TABLE ONLY public.debit_note_lines FORCE ROW LEVEL SECURITY;


--
-- Name: debit_note_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.debit_note_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: debit_note_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.debit_note_lines_id_seq OWNED BY public.debit_note_lines.id;


--
-- Name: delivery_note_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_note_header (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    delivery_note_number character varying(64) NOT NULL,
    load_id integer NOT NULL,
    do_header_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    total_pack_units integer DEFAULT 0 NOT NULL,
    total_quantity integer DEFAULT 0 NOT NULL,
    finalized_at timestamp without time zone,
    finalized_by integer,
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_dn_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT delivery_note_header_total_pack_units_check CHECK ((total_pack_units >= 0)),
    CONSTRAINT delivery_note_header_total_quantity_check CHECK ((total_quantity >= 0))
);

ALTER TABLE ONLY public.delivery_note_header FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_note_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_note_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_note_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_note_header_id_seq OWNED BY public.delivery_note_header.id;


--
-- Name: delivery_note_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_note_lines (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    delivery_note_id integer NOT NULL,
    do_line_item_id integer NOT NULL,
    item_id integer NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT delivery_note_lines_quantity_check CHECK ((quantity > 0))
);

ALTER TABLE ONLY public.delivery_note_lines FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_note_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_note_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_note_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_note_lines_id_seq OWNED BY public.delivery_note_lines.id;


--
-- Name: delivery_note_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_note_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_header (
    id integer NOT NULL,
    do_number character varying(50) NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    requested_by character varying(100),
    request_date date DEFAULT CURRENT_DATE NOT NULL,
    expected_dispatch_date date,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    total_items integer DEFAULT 0,
    total_quantity_requested integer DEFAULT 0,
    total_quantity_dispatched integer DEFAULT 0,
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    confirmed_by integer,
    confirmed_at timestamp without time zone,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    dispatch_date date,
    supplier_name character varying(255),
    invoice_no character varying(120),
    invoice_date date,
    model_no character varying(120),
    serial_no character varying(120),
    material_description text,
    date_of_manufacturing date,
    basic_price numeric(12,2),
    invoice_qty integer,
    dispatched_qty integer,
    quantity_difference integer,
    no_of_cases integer,
    no_of_pallets integer,
    weight_kg numeric(12,3),
    handling_type character varying(20),
    machine_type character varying(100),
    machine_from_time timestamp without time zone,
    machine_to_time timestamp without time zone,
    outward_remarks text,
    mobile_capture_payload jsonb,
    allocation_rule character varying(20) DEFAULT 'FIFO'::character varying NOT NULL,
    CONSTRAINT ck_do_allocation_rule CHECK (((allocation_rule)::text = ANY ((ARRAY['FIFO'::character varying, 'FEFO'::character varying, 'BATCH'::character varying, 'SERIAL'::character varying, 'LOCATION'::character varying])::text[]))),
    CONSTRAINT do_header_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'PENDING'::character varying, 'PICKED'::character varying, 'PACKED'::character varying, 'STAGED'::character varying, 'ISSUED'::character varying, 'LOADED'::character varying, 'PARTIALLY_FULFILLED'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.do_header FORCE ROW LEVEL SECURITY;


--
-- Name: do_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_header_id_seq OWNED BY public.do_header.id;


--
-- Name: do_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_line_items (
    id integer NOT NULL,
    do_header_id integer NOT NULL,
    line_number integer NOT NULL,
    item_id integer NOT NULL,
    quantity_requested integer NOT NULL,
    quantity_dispatched integer DEFAULT 0,
    uom character varying(20) NOT NULL,
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT do_line_items_check CHECK ((quantity_dispatched <= quantity_requested)),
    CONSTRAINT do_line_items_quantity_dispatched_check CHECK ((quantity_dispatched >= 0)),
    CONSTRAINT do_line_items_quantity_requested_check CHECK ((quantity_requested > 0))
);

ALTER TABLE ONLY public.do_line_items FORCE ROW LEVEL SECURITY;


--
-- Name: do_line_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_line_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_line_items_id_seq OWNED BY public.do_line_items.id;


--
-- Name: do_pack_unit_serials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_pack_unit_serials (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    pack_unit_id integer NOT NULL,
    do_line_item_id integer NOT NULL,
    item_id integer NOT NULL,
    serial_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.do_pack_unit_serials FORCE ROW LEVEL SECURITY;


--
-- Name: do_pack_unit_serials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_pack_unit_serials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_pack_unit_serials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_pack_unit_serials_id_seq OWNED BY public.do_pack_unit_serials.id;


--
-- Name: do_pack_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_pack_units (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    pack_code character varying(64) NOT NULL,
    do_header_id integer NOT NULL,
    wave_id integer,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    pack_type character varying(20) DEFAULT 'PALLET'::character varying NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    source_lp_record_id text,
    gross_weight_kg numeric(12,3),
    volume_cbm numeric(12,4),
    total_quantity integer DEFAULT 0 NOT NULL,
    closed_at timestamp without time zone,
    closed_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by integer,
    CONSTRAINT ck_pack_unit_status CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'CLOSED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT ck_pack_unit_type CHECK (((pack_type)::text = ANY ((ARRAY['PALLET'::character varying, 'CARTON'::character varying, 'BULK'::character varying])::text[]))),
    CONSTRAINT do_pack_units_total_quantity_check CHECK ((total_quantity >= 0))
);

ALTER TABLE ONLY public.do_pack_units FORCE ROW LEVEL SECURITY;


--
-- Name: do_pack_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_pack_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_pack_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_pack_units_id_seq OWNED BY public.do_pack_units.id;


--
-- Name: do_pick_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_pick_tasks (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    wave_id integer NOT NULL,
    do_header_id integer NOT NULL,
    do_line_item_id integer NOT NULL,
    item_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    task_type character varying(20) DEFAULT 'PICK'::character varying NOT NULL,
    status character varying(20) DEFAULT 'QUEUED'::character varying NOT NULL,
    required_quantity integer NOT NULL,
    picked_quantity integer DEFAULT 0 NOT NULL,
    assigned_to integer,
    assigned_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    last_error text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_do_pick_task_status CHECK (((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'ASSIGNED'::character varying, 'IN_PROGRESS'::character varying, 'DONE'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT ck_do_pick_task_type CHECK (((task_type)::text = ANY ((ARRAY['PICK'::character varying, 'REPLENISH'::character varying, 'QC'::character varying])::text[]))),
    CONSTRAINT do_pick_tasks_picked_quantity_check CHECK ((picked_quantity >= 0)),
    CONSTRAINT do_pick_tasks_required_quantity_check CHECK ((required_quantity > 0))
);

ALTER TABLE ONLY public.do_pick_tasks FORCE ROW LEVEL SECURITY;


--
-- Name: do_pick_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_pick_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_pick_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_pick_tasks_id_seq OWNED BY public.do_pick_tasks.id;


--
-- Name: do_wave_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_wave_header (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    wave_number character varying(80) NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer,
    strategy character varying(20) DEFAULT 'BATCH'::character varying NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    total_orders integer DEFAULT 0 NOT NULL,
    total_tasks integer DEFAULT 0 NOT NULL,
    created_by integer,
    released_by integer,
    released_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_do_wave_status CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'RELEASED'::character varying, 'IN_PROGRESS'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT ck_do_wave_strategy CHECK (((strategy)::text = ANY ((ARRAY['BATCH'::character varying, 'CLUSTER'::character varying])::text[])))
);

ALTER TABLE ONLY public.do_wave_header FORCE ROW LEVEL SECURITY;


--
-- Name: do_wave_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_wave_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_wave_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_wave_header_id_seq OWNED BY public.do_wave_header.id;


--
-- Name: do_wave_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.do_wave_orders (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    wave_id integer NOT NULL,
    do_header_id integer NOT NULL,
    pick_sequence integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'QUEUED'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_do_wave_order_status CHECK (((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'IN_PROGRESS'::character varying, 'DONE'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.do_wave_orders FORCE ROW LEVEL SECURITY;


--
-- Name: do_wave_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.do_wave_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: do_wave_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.do_wave_orders_id_seq OWNED BY public.do_wave_orders.id;


--
-- Name: edi_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edi_transactions (
    id integer NOT NULL,
    transaction_type character varying(50) NOT NULL,
    message_type character varying(50) NOT NULL,
    client_id integer,
    partner_id character varying(100),
    edi_format character varying(50),
    control_number character varying(100),
    reference_type character varying(50),
    reference_id integer,
    reference_number character varying(100),
    message_content text,
    parsed_data jsonb,
    transmission_method character varying(50),
    file_name character varying(500),
    file_path text,
    status character varying(50) DEFAULT 'PENDING'::character varying,
    error_message text,
    received_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    processed_at timestamp without time zone,
    acknowledged_at timestamp without time zone,
    created_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT edi_transactions_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'SUCCESS'::character varying, 'FAILED'::character varying, 'ACKNOWLEDGED'::character varying])::text[])))
);

ALTER TABLE ONLY public.edi_transactions FORCE ROW LEVEL SECURITY;


--
-- Name: edi_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.edi_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: edi_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.edi_transactions_id_seq OWNED BY public.edi_transactions.id;


--
-- Name: ff_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ff_documents (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shipment_id integer NOT NULL,
    doc_type character varying(24) NOT NULL,
    doc_no character varying(120) NOT NULL,
    issue_date date,
    attachment_id integer,
    is_master boolean DEFAULT false NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ff_documents_doc_type CHECK (((doc_type)::text = ANY ((ARRAY['HAWB'::character varying, 'MAWB'::character varying, 'HBL'::character varying, 'MBL'::character varying, 'INVOICE'::character varying, 'PACKING_LIST'::character varying, 'COO'::character varying, 'BOE'::character varying, 'OTHER'::character varying])::text[])))
);

ALTER TABLE ONLY public.ff_documents FORCE ROW LEVEL SECURITY;


--
-- Name: ff_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ff_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ff_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ff_documents_id_seq OWNED BY public.ff_documents.id;


--
-- Name: ff_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ff_milestones (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shipment_id integer NOT NULL,
    code character varying(40) NOT NULL,
    planned_at timestamp with time zone,
    actual_at timestamp with time zone,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ff_milestones_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'COMPLETED'::character varying, 'DELAYED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.ff_milestones FORCE ROW LEVEL SECURITY;


--
-- Name: ff_milestones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ff_milestones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ff_milestones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ff_milestones_id_seq OWNED BY public.ff_milestones.id;


--
-- Name: ff_shipment_legs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ff_shipment_legs (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shipment_id integer NOT NULL,
    leg_no integer NOT NULL,
    transport_mode character varying(12) NOT NULL,
    carrier_name character varying(160),
    vessel_or_flight character varying(120),
    voyage_or_flight_no character varying(80),
    from_location character varying(120) NOT NULL,
    to_location character varying(120) NOT NULL,
    etd timestamp with time zone,
    eta timestamp with time zone,
    atd timestamp with time zone,
    ata timestamp with time zone,
    status character varying(20) DEFAULT 'PLANNED'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ff_shipment_legs_mode CHECK (((transport_mode)::text = ANY ((ARRAY['AIR'::character varying, 'SEA'::character varying, 'ROAD'::character varying])::text[]))),
    CONSTRAINT ck_ff_shipment_legs_status CHECK (((status)::text = ANY ((ARRAY['PLANNED'::character varying, 'BOOKED'::character varying, 'DEPARTED'::character varying, 'ARRIVED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.ff_shipment_legs FORCE ROW LEVEL SECURITY;


--
-- Name: ff_shipment_legs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ff_shipment_legs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ff_shipment_legs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ff_shipment_legs_id_seq OWNED BY public.ff_shipment_legs.id;


--
-- Name: ff_shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ff_shipments (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shipment_no character varying(40) NOT NULL,
    mode character varying(12) NOT NULL,
    direction character varying(12) DEFAULT 'EXPORT'::character varying NOT NULL,
    status character varying(24) DEFAULT 'DRAFT'::character varying NOT NULL,
    client_id integer,
    shipper_name character varying(160),
    consignee_name character varying(160),
    incoterm character varying(20),
    origin character varying(120) NOT NULL,
    destination character varying(120) NOT NULL,
    etd timestamp with time zone,
    eta timestamp with time zone,
    remarks text,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ff_shipments_direction CHECK (((direction)::text = ANY ((ARRAY['IMPORT'::character varying, 'EXPORT'::character varying, 'DOMESTIC'::character varying])::text[]))),
    CONSTRAINT ck_ff_shipments_mode CHECK (((mode)::text = ANY ((ARRAY['AIR'::character varying, 'SEA'::character varying, 'ROAD'::character varying])::text[]))),
    CONSTRAINT ck_ff_shipments_status CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'BOOKED'::character varying, 'IN_TRANSIT'::character varying, 'CUSTOMS_HOLD'::character varying, 'ARRIVED'::character varying, 'DELIVERED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.ff_shipments FORCE ROW LEVEL SECURITY;


--
-- Name: ff_shipments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ff_shipments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ff_shipments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ff_shipments_id_seq OWNED BY public.ff_shipments.id;


--
-- Name: gate_in; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_in (
    id integer NOT NULL,
    gate_in_number character varying(50) NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer,
    truck_number character varying(20) NOT NULL,
    driver_name character varying(100),
    driver_phone character varying(15),
    transport_company character varying(200),
    arrival_datetime timestamp without time zone NOT NULL,
    gate_in_datetime timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    lr_number character varying(50),
    e_way_bill_number character varying(50),
    remarks text,
    status character varying(20) DEFAULT 'PENDING'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    lr_date date,
    e_way_bill_date date,
    from_location character varying(255),
    to_location character varying(255),
    vehicle_type character varying(50),
    vehicle_model character varying(100),
    transported_by character varying(20),
    vendor_name character varying(255),
    transportation_remarks text,
    mobile_capture_payload jsonb,
    departure_datetime timestamp without time zone,
    pending_client_name character varying(255),
    CONSTRAINT gate_in_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'GRN_IN_PROGRESS'::character varying, 'COMPLETED'::character varying])::text[])))
);

ALTER TABLE ONLY public.gate_in FORCE ROW LEVEL SECURITY;


--
-- Name: gate_in_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gate_in_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gate_in_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gate_in_id_seq OWNED BY public.gate_in.id;


--
-- Name: gate_out; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_out (
    id integer NOT NULL,
    gate_out_number character varying(50) NOT NULL,
    do_header_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    truck_number character varying(20) NOT NULL,
    driver_name character varying(100),
    driver_phone character varying(15),
    transport_company character varying(200),
    gate_out_datetime timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    lr_number character varying(50),
    e_way_bill_number character varying(50),
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.gate_out FORCE ROW LEVEL SECURITY;


--
-- Name: gate_out_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gate_out_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gate_out_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gate_out_id_seq OWNED BY public.gate_out.id;


--
-- Name: goods_issue_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goods_issue_header (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    gi_number character varying(64) NOT NULL,
    do_header_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    status character varying(20) DEFAULT 'GENERATED'::character varying NOT NULL,
    total_pack_units integer DEFAULT 0 NOT NULL,
    total_quantity integer DEFAULT 0 NOT NULL,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    issued_by integer,
    cancelled_at timestamp without time zone,
    cancelled_by integer,
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_gi_status CHECK (((status)::text = ANY ((ARRAY['GENERATED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT goods_issue_header_total_pack_units_check CHECK ((total_pack_units >= 0)),
    CONSTRAINT goods_issue_header_total_quantity_check CHECK ((total_quantity >= 0))
);

ALTER TABLE ONLY public.goods_issue_header FORCE ROW LEVEL SECURITY;


--
-- Name: goods_issue_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goods_issue_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goods_issue_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.goods_issue_header_id_seq OWNED BY public.goods_issue_header.id;


--
-- Name: goods_issue_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goods_issue_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goods_issue_pack_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goods_issue_pack_units (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    goods_issue_id integer NOT NULL,
    pack_unit_id integer NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT goods_issue_pack_units_quantity_check CHECK ((quantity >= 0))
);

ALTER TABLE ONLY public.goods_issue_pack_units FORCE ROW LEVEL SECURITY;


--
-- Name: goods_issue_pack_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goods_issue_pack_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goods_issue_pack_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.goods_issue_pack_units_id_seq OWNED BY public.goods_issue_pack_units.id;


--
-- Name: grn_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grn_header (
    id integer NOT NULL,
    grn_number character varying(50) NOT NULL,
    gate_in_id integer,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    invoice_number character varying(100),
    invoice_date date,
    invoice_value numeric(12,2),
    invoice_document_path text,
    base_labor_charge numeric(10,2) DEFAULT 0 NOT NULL,
    forklift_used boolean DEFAULT false,
    forklift_charge numeric(10,2) DEFAULT 0,
    other_charges numeric(10,2) DEFAULT 0,
    total_labor_cost numeric(10,2) GENERATED ALWAYS AS (((base_labor_charge + forklift_charge) + other_charges)) STORED,
    total_items integer DEFAULT 0,
    total_quantity integer DEFAULT 0,
    total_value numeric(12,2) DEFAULT 0,
    status character varying(20) DEFAULT 'DRAFT'::character varying,
    grn_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    confirmed_by integer,
    confirmed_at timestamp without time zone,
    supplier_name character varying(255),
    supplier_gst character varying(50),
    gate_in_number character varying(100),
    model_number character varying(255),
    material_description text,
    receipt_date date,
    manufacturing_date date,
    basic_price numeric(12,2),
    invoice_quantity integer,
    received_quantity integer,
    quantity_difference integer,
    damage_quantity integer,
    case_count integer,
    pallet_count integer,
    weight_kg numeric(12,3),
    handling_type character varying(20),
    source_channel character varying(30),
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT grn_header_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'CONFIRMED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.grn_header FORCE ROW LEVEL SECURITY;


--
-- Name: grn_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grn_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grn_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grn_header_id_seq OWNED BY public.grn_header.id;


--
-- Name: grn_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grn_line_items (
    id integer NOT NULL,
    grn_header_id integer NOT NULL,
    line_number integer NOT NULL,
    item_id integer NOT NULL,
    quantity integer NOT NULL,
    uom character varying(20) NOT NULL,
    mrp numeric(10,2),
    line_total numeric(12,2) GENERATED ALWAYS AS (((quantity)::numeric * COALESCE(mrp, (0)::numeric))) STORED,
    remarks text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    zone_layout_id integer,
    serial_numbers_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT grn_line_items_quantity_check CHECK ((quantity > 0))
);

ALTER TABLE ONLY public.grn_line_items FORCE ROW LEVEL SECURITY;


--
-- Name: grn_line_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grn_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grn_line_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grn_line_items_id_seq OWNED BY public.grn_line_items.id;


--
-- Name: integration_connector_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_connector_credentials (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    connector_id integer NOT NULL,
    credential_key character varying(80) NOT NULL,
    credential_value_encrypted text CONSTRAINT integration_connector_crede_credential_value_encrypted_not_null NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.integration_connector_credentials FORCE ROW LEVEL SECURITY;


--
-- Name: integration_connector_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_connector_credentials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_connector_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_connector_credentials_id_seq OWNED BY public.integration_connector_credentials.id;


--
-- Name: integration_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_connectors (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    connector_code character varying(60) NOT NULL,
    connector_name character varying(150) NOT NULL,
    provider_type character varying(20) NOT NULL,
    transport_type character varying(20) NOT NULL,
    direction character varying(20) DEFAULT 'BIDIRECTIONAL'::character varying NOT NULL,
    endpoint_url text,
    auth_type character varying(20) DEFAULT 'NONE'::character varying NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    timeout_seconds integer DEFAULT 30 NOT NULL,
    retry_limit integer DEFAULT 3 NOT NULL,
    retry_backoff_seconds integer DEFAULT 60 NOT NULL,
    dead_letter_after integer DEFAULT 5 NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_integration_connector_auth CHECK (((auth_type)::text = ANY ((ARRAY['NONE'::character varying, 'API_KEY'::character varying, 'BASIC'::character varying, 'BEARER'::character varying, 'OAUTH2'::character varying])::text[]))),
    CONSTRAINT ck_integration_connector_direction CHECK (((direction)::text = ANY ((ARRAY['INBOUND'::character varying, 'OUTBOUND'::character varying, 'BIDIRECTIONAL'::character varying])::text[]))),
    CONSTRAINT ck_integration_connector_provider CHECK (((provider_type)::text = ANY ((ARRAY['EDI'::character varying, 'CARRIER'::character varying, 'ERP'::character varying])::text[]))),
    CONSTRAINT ck_integration_connector_status CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying, 'ERROR'::character varying])::text[]))),
    CONSTRAINT ck_integration_connector_transport CHECK (((transport_type)::text = ANY ((ARRAY['REST'::character varying, 'SFTP'::character varying, 'FTP'::character varying, 'EMAIL'::character varying, 'WEBHOOK'::character varying])::text[]))),
    CONSTRAINT integration_connectors_dead_letter_after_check CHECK (((dead_letter_after >= 1) AND (dead_letter_after <= 50))),
    CONSTRAINT integration_connectors_retry_backoff_seconds_check CHECK (((retry_backoff_seconds >= 5) AND (retry_backoff_seconds <= 86400))),
    CONSTRAINT integration_connectors_retry_limit_check CHECK (((retry_limit >= 0) AND (retry_limit <= 20))),
    CONSTRAINT integration_connectors_timeout_seconds_check CHECK (((timeout_seconds > 0) AND (timeout_seconds <= 300)))
);

ALTER TABLE ONLY public.integration_connectors FORCE ROW LEVEL SECURITY;


--
-- Name: integration_connectors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_connectors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_connectors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_connectors_id_seq OWNED BY public.integration_connectors.id;


--
-- Name: integration_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_events (
    id bigint NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    connector_id integer NOT NULL,
    mapping_id integer,
    direction character varying(20) DEFAULT 'OUTBOUND'::character varying NOT NULL,
    entity_type character varying(40) NOT NULL,
    entity_id character varying(120),
    idempotency_key character varying(120),
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_payload jsonb,
    status character varying(20) DEFAULT 'QUEUED'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    next_retry_at timestamp with time zone,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_integration_event_direction CHECK (((direction)::text = ANY ((ARRAY['INBOUND'::character varying, 'OUTBOUND'::character varying])::text[]))),
    CONSTRAINT ck_integration_event_status CHECK (((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'PROCESSING'::character varying, 'SUCCESS'::character varying, 'RETRY'::character varying, 'DEAD_LETTER'::character varying])::text[])))
);

ALTER TABLE ONLY public.integration_events FORCE ROW LEVEL SECURITY;


--
-- Name: integration_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_events_id_seq OWNED BY public.integration_events.id;


--
-- Name: integration_mapping_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_mapping_fields (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    mapping_id integer NOT NULL,
    source_path character varying(200) NOT NULL,
    target_path character varying(200) NOT NULL,
    data_type character varying(30) DEFAULT 'string'::character varying NOT NULL,
    transform_rule character varying(120),
    default_value text,
    required boolean DEFAULT false NOT NULL,
    sequence_no integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.integration_mapping_fields FORCE ROW LEVEL SECURITY;


--
-- Name: integration_mapping_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_mapping_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_mapping_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_mapping_fields_id_seq OWNED BY public.integration_mapping_fields.id;


--
-- Name: integration_schema_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_schema_mappings (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    connector_id integer NOT NULL,
    entity_type character varying(40) NOT NULL,
    direction character varying(20) DEFAULT 'OUTBOUND'::character varying NOT NULL,
    mapping_version integer DEFAULT 1 NOT NULL,
    is_default boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_integration_mapping_direction CHECK (((direction)::text = ANY ((ARRAY['INBOUND'::character varying, 'OUTBOUND'::character varying])::text[]))),
    CONSTRAINT integration_schema_mappings_mapping_version_check CHECK ((mapping_version > 0))
);

ALTER TABLE ONLY public.integration_schema_mappings FORCE ROW LEVEL SECURITY;


--
-- Name: integration_schema_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_schema_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_schema_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_schema_mappings_id_seq OWNED BY public.integration_schema_mappings.id;


--
-- Name: invoice_header; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_header (
    id integer NOT NULL,
    company_id integer NOT NULL,
    invoice_number character varying(80) NOT NULL,
    client_id integer NOT NULL,
    billing_cycle character varying(20) DEFAULT 'MONTHLY'::character varying NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    billing_period character varying(30),
    invoice_date date NOT NULL,
    due_date date NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    taxable_amount numeric(14,2) DEFAULT 0 NOT NULL,
    cgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    igst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    grand_total numeric(14,2) DEFAULT 0 NOT NULL,
    paid_amount numeric(14,2) DEFAULT 0 NOT NULL,
    balance_amount numeric(14,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    draft_run_key character varying(120),
    finalized_at timestamp without time zone,
    finalized_by integer,
    sent_at timestamp without time zone,
    notes text,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    client_action_status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    client_action_at timestamp with time zone,
    client_last_action_note text,
    CONSTRAINT ck_ih_amounts CHECK (((taxable_amount >= (0)::numeric) AND (cgst_amount >= (0)::numeric) AND (sgst_amount >= (0)::numeric) AND (igst_amount >= (0)::numeric) AND (total_tax_amount >= (0)::numeric) AND (grand_total >= (0)::numeric) AND (paid_amount >= (0)::numeric) AND (balance_amount >= (0)::numeric))),
    CONSTRAINT ck_ih_billing_cycle CHECK (((billing_cycle)::text = ANY ((ARRAY['WEEKLY'::character varying, 'MONTHLY'::character varying, 'QUARTERLY'::character varying, 'YEARLY'::character varying])::text[]))),
    CONSTRAINT ck_ih_period CHECK ((period_to >= period_from)),
    CONSTRAINT ck_ih_status CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'FINALIZED'::character varying, 'SENT'::character varying, 'PAID'::character varying, 'VOID'::character varying])::text[]))),
    CONSTRAINT ck_invoice_header_client_action_status CHECK (((client_action_status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'DISPUTED'::character varying, 'PARTIALLY_PAID'::character varying, 'PAID'::character varying])::text[])))
);

ALTER TABLE ONLY public.invoice_header FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_header_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_header_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_header_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_header_id_seq OWNED BY public.invoice_header.id;


--
-- Name: invoice_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_lines (
    id integer NOT NULL,
    company_id integer NOT NULL,
    invoice_id integer NOT NULL,
    line_no integer NOT NULL,
    charge_type character varying(30) NOT NULL,
    description text NOT NULL,
    source_type character varying(20),
    source_doc_id integer,
    source_line_id integer,
    source_ref_no character varying(120),
    period_from date,
    period_to date,
    uom character varying(20) DEFAULT 'UNIT'::character varying NOT NULL,
    quantity numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,4) DEFAULT 0 NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    tax_code character varying(30) DEFAULT 'GST'::character varying NOT NULL,
    gst_rate numeric(6,3) DEFAULT 18 NOT NULL,
    cgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    igst_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    gross_amount numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_il_amounts CHECK (((quantity >= (0)::numeric) AND (rate >= (0)::numeric) AND (amount >= (0)::numeric) AND (gst_rate >= (0)::numeric) AND (cgst_amount >= (0)::numeric) AND (sgst_amount >= (0)::numeric) AND (igst_amount >= (0)::numeric) AND (total_tax_amount >= (0)::numeric) AND (gross_amount >= (0)::numeric))),
    CONSTRAINT ck_il_charge_type CHECK (((charge_type)::text = ANY ((ARRAY['INBOUND_HANDLING'::character varying, 'OUTBOUND_HANDLING'::character varying, 'STORAGE'::character varying, 'VAS'::character varying, 'FIXED'::character varying, 'MINIMUM'::character varying, 'ADJUSTMENT'::character varying])::text[]))),
    CONSTRAINT ck_il_source_type CHECK (((source_type IS NULL) OR ((source_type)::text = ANY ((ARRAY['GRN'::character varying, 'DO'::character varying, 'VAS'::character varying, 'STORAGE'::character varying, 'MANUAL'::character varying])::text[]))))
);

ALTER TABLE ONLY public.invoice_lines FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_lines_id_seq OWNED BY public.invoice_lines.id;


--
-- Name: invoice_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_payments (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    invoice_id integer NOT NULL,
    payment_date date NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_mode character varying(30),
    reference_no character varying(120),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT invoice_payments_amount_check CHECK ((amount > (0)::numeric))
);

ALTER TABLE ONLY public.invoice_payments FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_payments_id_seq OWNED BY public.invoice_payments.id;


--
-- Name: invoice_tax_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_tax_lines (
    id integer NOT NULL,
    company_id integer NOT NULL,
    invoice_id integer NOT NULL,
    invoice_line_id integer,
    tax_type character varying(20) NOT NULL,
    tax_rate numeric(6,3) DEFAULT 0 NOT NULL,
    taxable_amount numeric(14,2) DEFAULT 0 NOT NULL,
    tax_amount numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_itl_amounts CHECK (((tax_rate >= (0)::numeric) AND (taxable_amount >= (0)::numeric) AND (tax_amount >= (0)::numeric))),
    CONSTRAINT ck_itl_tax_type CHECK (((tax_type)::text = ANY ((ARRAY['CGST'::character varying, 'SGST'::character varying, 'IGST'::character varying, 'CESS'::character varying, 'OTHER'::character varying])::text[])))
);

ALTER TABLE ONLY public.invoice_tax_lines FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_tax_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_tax_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_tax_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_tax_lines_id_seq OWNED BY public.invoice_tax_lines.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    invoice_number character varying(80) NOT NULL,
    client_id integer NOT NULL,
    billing_period character varying(30),
    invoice_date date NOT NULL,
    due_date date NOT NULL,
    total_amount numeric(14,2) DEFAULT 0 NOT NULL,
    paid_amount numeric(14,2) DEFAULT 0 NOT NULL,
    balance numeric(14,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'SENT'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: item_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_categories (
    id integer NOT NULL,
    category_code character varying(20) NOT NULL,
    category_name character varying(100) NOT NULL,
    parent_category_id integer,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.item_categories FORCE ROW LEVEL SECURITY;


--
-- Name: item_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_categories_id_seq OWNED BY public.item_categories.id;


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id integer NOT NULL,
    item_code character varying(50) NOT NULL,
    item_name character varying(300) NOT NULL,
    item_description text,
    category_id integer,
    hsn_code character varying(20),
    uom character varying(20) NOT NULL,
    weight_kg numeric(10,3),
    length_cm numeric(10,2),
    width_cm numeric(10,2),
    height_cm numeric(10,2),
    volume_cubic_m numeric(10,4),
    reorder_level integer,
    min_stock_alert integer,
    standard_mrp numeric(10,2),
    approval_status character varying(20) DEFAULT 'APPROVED'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    is_batch_tracked boolean DEFAULT false,
    is_expiry_tracked boolean DEFAULT false,
    default_shelf_life_days integer,
    min_shelf_life_days integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT items_approval_status_check CHECK (((approval_status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying])::text[])))
);

ALTER TABLE ONLY public.items FORCE ROW LEVEL SECURITY;


--
-- Name: items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.items_id_seq OWNED BY public.items.id;


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    entry_date date NOT NULL,
    source_module character varying(50),
    source_id character varying(120),
    entry_type character varying(50) NOT NULL,
    external_ref character varying(180) NOT NULL,
    description text,
    posted_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: journal_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journal_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journal_entries_id_seq OWNED BY public.journal_entries.id;


--
-- Name: journal_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_lines (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    journal_entry_id integer NOT NULL,
    line_no integer DEFAULT 1 NOT NULL,
    account_id integer NOT NULL,
    debit numeric(14,2) DEFAULT 0 NOT NULL,
    credit numeric(14,2) DEFAULT 0 NOT NULL,
    narration text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: journal_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journal_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journal_lines_id_seq OWNED BY public.journal_lines.id;


--
-- Name: labor_productivity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labor_productivity_events (
    id bigint NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    standard_id integer NOT NULL,
    shift_id integer,
    assignment_id integer,
    warehouse_id integer,
    client_id integer,
    user_id integer,
    source_type character varying(20) DEFAULT 'MANUAL'::character varying NOT NULL,
    source_ref character varying(120),
    event_ts timestamp with time zone DEFAULT now() NOT NULL,
    quantity numeric(12,3) NOT NULL,
    duration_minutes numeric(10,2) NOT NULL,
    quality_score numeric(5,2),
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_labor_productivity_source CHECK (((source_type)::text = ANY ((ARRAY['MANUAL'::character varying, 'TASK'::character varying, 'SCAN'::character varying])::text[]))),
    CONSTRAINT labor_productivity_events_duration_minutes_check CHECK ((duration_minutes > (0)::numeric)),
    CONSTRAINT labor_productivity_events_quality_score_check CHECK (((quality_score >= (0)::numeric) AND (quality_score <= (100)::numeric))),
    CONSTRAINT labor_productivity_events_quantity_check CHECK ((quantity > (0)::numeric))
);

ALTER TABLE ONLY public.labor_productivity_events FORCE ROW LEVEL SECURITY;


--
-- Name: labor_productivity_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.labor_productivity_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: labor_productivity_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.labor_productivity_events_id_seq OWNED BY public.labor_productivity_events.id;


--
-- Name: labor_shift_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labor_shift_assignments (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shift_id integer NOT NULL,
    shift_date date NOT NULL,
    user_id integer NOT NULL,
    assignment_role character varying(50) DEFAULT 'OPERATOR'::character varying NOT NULL,
    assignment_status character varying(20) DEFAULT 'ASSIGNED'::character varying NOT NULL,
    remarks text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_labor_assignment_status CHECK (((assignment_status)::text = ANY ((ARRAY['ASSIGNED'::character varying, 'ABSENT'::character varying, 'REPLACED'::character varying, 'OFF'::character varying])::text[])))
);

ALTER TABLE ONLY public.labor_shift_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: labor_shift_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.labor_shift_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: labor_shift_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.labor_shift_assignments_id_seq OWNED BY public.labor_shift_assignments.id;


--
-- Name: labor_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labor_shifts (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    shift_code character varying(30) NOT NULL,
    shift_name character varying(120) NOT NULL,
    warehouse_id integer,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    planned_headcount integer DEFAULT 1 NOT NULL,
    break_minutes integer DEFAULT 30 NOT NULL,
    is_overnight boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT labor_shifts_break_minutes_check CHECK ((break_minutes >= 0)),
    CONSTRAINT labor_shifts_planned_headcount_check CHECK ((planned_headcount > 0))
);

ALTER TABLE ONLY public.labor_shifts FORCE ROW LEVEL SECURITY;


--
-- Name: labor_shifts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.labor_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: labor_shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.labor_shifts_id_seq OWNED BY public.labor_shifts.id;


--
-- Name: labor_standards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labor_standards (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    operation_code character varying(50) NOT NULL,
    operation_name character varying(150) NOT NULL,
    unit_of_measure character varying(20) DEFAULT 'UNITS'::character varying NOT NULL,
    standard_units_per_hour numeric(10,2) NOT NULL,
    warning_threshold_pct numeric(5,2) DEFAULT 85 NOT NULL,
    critical_threshold_pct numeric(5,2) DEFAULT 65 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT labor_standards_critical_threshold_pct_check CHECK (((critical_threshold_pct > (0)::numeric) AND (critical_threshold_pct <= (200)::numeric))),
    CONSTRAINT labor_standards_standard_units_per_hour_check CHECK ((standard_units_per_hour > (0)::numeric)),
    CONSTRAINT labor_standards_warning_threshold_pct_check CHECK (((warning_threshold_pct > (0)::numeric) AND (warning_threshold_pct <= (200)::numeric)))
);

ALTER TABLE ONLY public.labor_standards FORCE ROW LEVEL SECURITY;


--
-- Name: labor_standards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.labor_standards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: labor_standards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.labor_standards_id_seq OWNED BY public.labor_standards.id;


--
-- Name: mobile_approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_approval_requests (
    id uuid NOT NULL,
    module text NOT NULL,
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    requested_by integer NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    reason text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_auth_sessions (
    id text NOT NULL,
    user_id integer NOT NULL,
    company_id integer NOT NULL,
    actor_type character varying(20) DEFAULT 'mobile'::character varying NOT NULL,
    refresh_jti text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    revoke_reason text
);


--
-- Name: mobile_cycle_count_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_cycle_count_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id text NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    worker_id integer NOT NULL,
    bin_id text NOT NULL,
    lp_id text,
    sku text NOT NULL,
    expected_qty integer,
    counted_qty integer NOT NULL,
    discrepancy integer,
    blind_count boolean DEFAULT false NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    approval_status text DEFAULT 'NOT_REQUIRED'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    approval_remarks text,
    adjusted_serial_count integer
);


--
-- Name: mobile_cycle_count_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_cycle_count_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    worker_id integer,
    task_type text DEFAULT 'PLANNED'::text NOT NULL,
    blind_count boolean DEFAULT false NOT NULL,
    bin_id text NOT NULL,
    lp_id text,
    sku text NOT NULL,
    expected_qty integer,
    status text DEFAULT 'OPEN'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_id integer
);


--
-- Name: mobile_dock_appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_dock_appointments (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    appointment_no text NOT NULL,
    vehicle_no text,
    carrier_name text,
    direction text DEFAULT 'INBOUND'::text NOT NULL,
    status text DEFAULT 'SCHEDULED'::text NOT NULL,
    dock_door text,
    slot_code text,
    appointment_time timestamp with time zone,
    qr_code text,
    source_grn_header_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_dock_checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_dock_checkins (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    appointment_id uuid,
    slot_id uuid,
    scanned_code text NOT NULL,
    worker_id integer NOT NULL,
    status text DEFAULT 'ARRIVED'::text NOT NULL,
    unscheduled boolean DEFAULT false NOT NULL,
    checkin_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_dock_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_dock_slots (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    slot_code text NOT NULL,
    dock_door text NOT NULL,
    available boolean DEFAULT true NOT NULL,
    status text DEFAULT 'AVAILABLE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_grn_captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_grn_captures (
    id integer NOT NULL,
    capture_ref character varying(50) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    notes text,
    approved_grn_id integer,
    created_by integer,
    approved_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.mobile_grn_captures FORCE ROW LEVEL SECURITY;


--
-- Name: mobile_grn_captures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mobile_grn_captures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mobile_grn_captures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mobile_grn_captures_id_seq OWNED BY public.mobile_grn_captures.id;


--
-- Name: mobile_inbound_receiving_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_inbound_receiving_tasks (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    appointment_id uuid,
    checkin_id uuid,
    task_type text DEFAULT 'DOCK_RECEIVING'::text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    priority text DEFAULT 'MEDIUM'::text NOT NULL,
    reference_no text,
    source text DEFAULT 'DOCK_CHECKIN'::text NOT NULL,
    assigned_to integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_lp_nested; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_lp_nested (
    id text NOT NULL,
    parent_lp_id text NOT NULL,
    lp_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_lp_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_lp_records (
    id text NOT NULL,
    lp_code text NOT NULL,
    source_scan_code text NOT NULL,
    po_id text NOT NULL,
    gate_in_id text NOT NULL,
    client_id text,
    sku text,
    batch_lot text,
    quantity integer DEFAULT 1 NOT NULL,
    expiry_date timestamp with time zone,
    warehouse_id text NOT NULL,
    received_by_id text NOT NULL,
    status text DEFAULT 'RECEIVED'::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_outbound_shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_outbound_shipments (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    do_header_id integer NOT NULL,
    do_number text NOT NULL,
    carton_id text NOT NULL,
    source_confirmation_id uuid,
    triggered_by integer NOT NULL,
    status text DEFAULT 'TRIGGERED'::text NOT NULL,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_packing_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_packing_confirmations (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    do_header_id integer NOT NULL,
    do_number text NOT NULL,
    carton_id text NOT NULL,
    mode text NOT NULL,
    confirmed_by integer NOT NULL,
    confirmation_status text DEFAULT 'CONFIRMED'::text NOT NULL,
    under_pack_lines integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_packing_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_packing_lines (
    id uuid NOT NULL,
    confirmation_id uuid NOT NULL,
    do_line_item_id integer NOT NULL,
    sku text NOT NULL,
    expected_qty integer NOT NULL,
    packed_qty integer NOT NULL,
    line_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_print_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_print_queue (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    worker_id integer NOT NULL,
    label_type text NOT NULL,
    template_id integer NOT NULL,
    template_name text NOT NULL,
    printer_id text NOT NULL,
    printer_name text NOT NULL,
    reference_no text NOT NULL,
    copies integer DEFAULT 1 NOT NULL,
    source_screen text DEFAULT 'MOBILE'::text NOT NULL,
    is_reprint boolean DEFAULT false NOT NULL,
    original_job_id text,
    status text DEFAULT 'QUEUED'::text NOT NULL,
    render_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_qc_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_qc_holds (
    id uuid NOT NULL,
    qc_result_id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    grn_line_item_id integer NOT NULL,
    lp_id text,
    hold_reason text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    approval_request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disposition text,
    resolved_by integer,
    resolved_at timestamp with time zone
);


--
-- Name: mobile_qc_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_qc_results (
    id uuid NOT NULL,
    task_id text NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    worker_id integer NOT NULL,
    grn_header_id integer NOT NULL,
    grn_line_item_id integer NOT NULL,
    lp_id text,
    lp_code text,
    sku text NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    result text NOT NULL,
    remarks text,
    photos jsonb,
    media_ids jsonb,
    media_txn_id text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reason_code text,
    accepted_qty integer,
    rejected_qty integer
);


--
-- Name: mobile_returns_dispositions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_returns_dispositions (
    id uuid NOT NULL,
    header_id uuid NOT NULL,
    line_id text NOT NULL,
    disposition_by integer NOT NULL,
    disposition text NOT NULL,
    damage_qty integer DEFAULT 0 NOT NULL,
    qc_hold boolean DEFAULT false NOT NULL,
    remarks text,
    photos jsonb,
    media_ids jsonb,
    media_txn_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_returns_headers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_returns_headers (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    rma_id text NOT NULL,
    return_shipment_no text,
    source_do_header_id integer,
    status text DEFAULT 'OPEN'::text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_returns_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_returns_lines (
    id uuid NOT NULL,
    header_id uuid NOT NULL,
    line_id text NOT NULL,
    sku text NOT NULL,
    item_barcode text,
    expected_qty integer NOT NULL,
    received_qty integer DEFAULT 0 NOT NULL,
    disposition text DEFAULT 'PENDING'::text NOT NULL,
    damage_qty integer DEFAULT 0 NOT NULL,
    remarks text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_returns_putaway_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_returns_putaway_tasks (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    rma_id text NOT NULL,
    line_id text NOT NULL,
    sku text NOT NULL,
    quantity integer NOT NULL,
    disposition text NOT NULL,
    source_bin text,
    suggested_bin text,
    status text DEFAULT 'OPEN'::text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_returns_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_returns_receipts (
    id uuid NOT NULL,
    header_id uuid NOT NULL,
    line_id text NOT NULL,
    received_by integer NOT NULL,
    received_qty integer NOT NULL,
    scanned_code text,
    remarks text,
    photos jsonb,
    media_ids jsonb,
    media_txn_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_sync_task_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_sync_task_queue (
    id bigint NOT NULL,
    company_code text NOT NULL,
    client_id bigint,
    warehouse_id bigint,
    worker_id bigint,
    task_id text NOT NULL,
    task_type text NOT NULL,
    action text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: mobile_sync_task_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mobile_sync_task_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mobile_sync_task_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mobile_sync_task_queue_id_seq OWNED BY public.mobile_sync_task_queue.id;


--
-- Name: mobile_task_cancellation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_task_cancellation_logs (
    id uuid NOT NULL,
    company_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    task_id text NOT NULL,
    task_type text NOT NULL,
    reason_code text NOT NULL,
    remarks text,
    cancelled_by integer NOT NULL,
    released_qty integer DEFAULT 0 NOT NULL,
    cancellation_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_serial_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_serial_numbers (
    id integer NOT NULL,
    grn_line_item_id integer NOT NULL,
    serial_number character varying(100) NOT NULL,
    item_id integer NOT NULL,
    client_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    zone_id integer,
    physical_location character varying(100),
    status character varying(20) DEFAULT 'IN_STOCK'::character varying,
    received_date date NOT NULL,
    dispatched_date date,
    do_line_item_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    batch_number character varying(100),
    manufacturing_date date,
    expiry_date date,
    remaining_shelf_life_days integer,
    zone_layout_id integer,
    bin_location character varying(200),
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    lp_record_id text,
    CONSTRAINT stock_serial_numbers_status_check CHECK (((status)::text = ANY ((ARRAY['IN_STOCK'::character varying, 'RESERVED'::character varying, 'DISPATCHED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.stock_serial_numbers FORCE ROW LEVEL SECURITY;


--
-- Name: warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouses (
    id integer NOT NULL,
    warehouse_code character varying(20) NOT NULL,
    warehouse_name character varying(100) NOT NULL,
    address text,
    city character varying(50),
    state character varying(50),
    pincode character varying(10),
    contact_person character varying(100),
    contact_phone character varying(15),
    contact_email character varying(100),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7)
);

ALTER TABLE ONLY public.warehouses FORCE ROW LEVEL SECURITY;


--
-- Name: mv_daily_stock_snapshot; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_daily_stock_snapshot AS
 SELECT CURRENT_DATE AS snapshot_date,
    c.id AS client_id,
    c.client_name,
    w.id AS warehouse_id,
    w.warehouse_name,
    i.id AS item_id,
    i.item_code,
    i.item_name,
    count(*) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS qty_in_stock,
    count(*) FILTER (WHERE ((s.status)::text = 'RESERVED'::text)) AS qty_reserved,
    count(*) FILTER (WHERE ((s.status)::text = 'DISPATCHED'::text)) AS qty_dispatched,
    sum(i.standard_mrp) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS value_in_stock,
    min(s.received_date) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS oldest_stock_date,
    avg(date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone))) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS avg_age_days
   FROM (((public.stock_serial_numbers s
     JOIN public.clients c ON ((s.client_id = c.id)))
     JOIN public.warehouses w ON ((s.warehouse_id = w.id)))
     JOIN public.items i ON ((s.item_id = i.id)))
  GROUP BY c.id, c.client_name, w.id, w.warehouse_name, i.id, i.item_code, i.item_name
  WITH NO DATA;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    company_id integer NOT NULL,
    user_id integer NOT NULL,
    source text DEFAULT 'mobile'::text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: outbound_load_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_load_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_load_pack_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_load_pack_units (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    load_id integer NOT NULL,
    pack_unit_id integer NOT NULL,
    quantity integer NOT NULL,
    loaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT outbound_load_pack_units_quantity_check CHECK ((quantity >= 0))
);

ALTER TABLE ONLY public.outbound_load_pack_units FORCE ROW LEVEL SECURITY;


--
-- Name: outbound_load_pack_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_load_pack_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_load_pack_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_load_pack_units_id_seq OWNED BY public.outbound_load_pack_units.id;


--
-- Name: outbound_loads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_loads (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    load_number character varying(64) NOT NULL,
    do_header_id integer NOT NULL,
    goods_issue_id integer,
    warehouse_id integer NOT NULL,
    client_id integer NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    vehicle_number character varying(50),
    container_number character varying(50),
    seal_number character varying(50),
    driver_name character varying(120),
    driver_phone character varying(40),
    transport_company character varying(150),
    loading_bay character varying(50),
    loaded_at timestamp without time zone,
    loaded_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by integer,
    CONSTRAINT ck_load_status CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'LOADED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.outbound_loads FORCE ROW LEVEL SECURITY;


--
-- Name: outbound_loads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_loads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_loads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_loads_id_seq OWNED BY public.outbound_loads.id;


--
-- Name: pack_unit_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pack_unit_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    is_used boolean DEFAULT false,
    used_at timestamp without time zone,
    ip_address character varying(50),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_tokens_id_seq OWNED BY public.password_reset_tokens.id;


--
-- Name: portal_client_sla_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_client_sla_policies (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    client_id integer NOT NULL,
    dispatch_target_hours numeric(8,2) DEFAULT 48 NOT NULL,
    invoice_approval_due_days integer DEFAULT 5 NOT NULL,
    dispute_resolution_hours numeric(8,2) DEFAULT 72 NOT NULL,
    warning_threshold_pct numeric(5,2) DEFAULT 90 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_client_sla_policies_dispatch_target_hours_check CHECK ((dispatch_target_hours > (0)::numeric)),
    CONSTRAINT portal_client_sla_policies_dispute_resolution_hours_check CHECK ((dispute_resolution_hours > (0)::numeric)),
    CONSTRAINT portal_client_sla_policies_invoice_approval_due_days_check CHECK ((invoice_approval_due_days >= 0)),
    CONSTRAINT portal_client_sla_policies_warning_threshold_pct_check CHECK (((warning_threshold_pct > (0)::numeric) AND (warning_threshold_pct <= (200)::numeric)))
);

ALTER TABLE ONLY public.portal_client_sla_policies FORCE ROW LEVEL SECURITY;


--
-- Name: portal_client_sla_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_client_sla_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_client_sla_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_client_sla_policies_id_seq OWNED BY public.portal_client_sla_policies.id;


--
-- Name: portal_invoice_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_invoice_actions (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    client_id integer NOT NULL,
    invoice_id integer NOT NULL,
    action_type character varying(20) NOT NULL,
    action_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_portal_invoice_action_type CHECK (((action_type)::text = ANY ((ARRAY['APPROVE'::character varying, 'DISPUTE'::character varying, 'PAY'::character varying, 'COMMENT'::character varying])::text[])))
);

ALTER TABLE ONLY public.portal_invoice_actions FORCE ROW LEVEL SECURITY;


--
-- Name: portal_invoice_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_invoice_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_invoice_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_invoice_actions_id_seq OWNED BY public.portal_invoice_actions.id;


--
-- Name: portal_invoice_dispute_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_invoice_dispute_events (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    dispute_id integer NOT NULL,
    event_type character varying(20) DEFAULT 'COMMENT'::character varying NOT NULL,
    from_status character varying(20),
    to_status character varying(20),
    comment text,
    actor_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_portal_dispute_event_type CHECK (((event_type)::text = ANY ((ARRAY['CREATED'::character varying, 'STATUS_CHANGE'::character varying, 'COMMENT'::character varying, 'ATTACHMENT'::character varying])::text[])))
);

ALTER TABLE ONLY public.portal_invoice_dispute_events FORCE ROW LEVEL SECURITY;


--
-- Name: portal_invoice_dispute_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_invoice_dispute_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_invoice_dispute_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_invoice_dispute_events_id_seq OWNED BY public.portal_invoice_dispute_events.id;


--
-- Name: portal_invoice_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_invoice_disputes (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    client_id integer NOT NULL,
    invoice_id integer NOT NULL,
    dispute_number character varying(80) NOT NULL,
    category character varying(30) DEFAULT 'BILLING_AMOUNT'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'MEDIUM'::character varying NOT NULL,
    dispute_reason text NOT NULL,
    dispute_amount numeric(14,2),
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    raised_by integer,
    assigned_to integer,
    resolution_notes text,
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_portal_dispute_category CHECK (((category)::text = ANY ((ARRAY['BILLING_AMOUNT'::character varying, 'SERVICE_QUALITY'::character varying, 'MISSING_DOCS'::character varying, 'OTHER'::character varying])::text[]))),
    CONSTRAINT ck_portal_dispute_priority CHECK (((priority)::text = ANY ((ARRAY['LOW'::character varying, 'MEDIUM'::character varying, 'HIGH'::character varying, 'CRITICAL'::character varying])::text[]))),
    CONSTRAINT ck_portal_dispute_status CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'UNDER_REVIEW'::character varying, 'RESOLVED'::character varying, 'REJECTED'::character varying, 'CLOSED'::character varying])::text[])))
);

ALTER TABLE ONLY public.portal_invoice_disputes FORCE ROW LEVEL SECURITY;


--
-- Name: portal_invoice_disputes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_invoice_disputes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_invoice_disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_invoice_disputes_id_seq OWNED BY public.portal_invoice_disputes.id;


--
-- Name: portal_user_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_user_clients (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    user_id integer NOT NULL,
    client_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: portal_user_clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_user_clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_user_clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_user_clients_id_seq OWNED BY public.portal_user_clients.id;


--
-- Name: portal_user_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_user_invites (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    user_id integer NOT NULL,
    invite_token character varying(120) NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    accepted_at timestamp without time zone,
    invited_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_portal_user_invites_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'EXPIRED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: portal_user_invites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_user_invites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_user_invites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_user_invites_id_seq OWNED BY public.portal_user_invites.id;


--
-- Name: portal_user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_user_permissions (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    user_id integer NOT NULL,
    feature_key character varying(80) NOT NULL,
    is_allowed boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: portal_user_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_user_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_user_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_user_permissions_id_seq OWNED BY public.portal_user_permissions.id;


--
-- Name: printed_labels_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.printed_labels_log (
    id integer NOT NULL,
    template_id integer,
    client_id integer,
    reference_type character varying(50) NOT NULL,
    reference_id integer NOT NULL,
    sscc character varying(20),
    batch_number character varying(100),
    serial_numbers text[],
    printed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    printed_by integer,
    printer_name character varying(200),
    print_status character varying(50) DEFAULT 'SUCCESS'::character varying,
    label_data jsonb,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.printed_labels_log FORCE ROW LEVEL SECURITY;


--
-- Name: printed_labels_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.printed_labels_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: printed_labels_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.printed_labels_log_id_seq OWNED BY public.printed_labels_log.id;


--
-- Name: rbac_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_permissions (
    id integer NOT NULL,
    permission_key character varying(100) NOT NULL,
    permission_name character varying(150) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: rbac_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rbac_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rbac_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rbac_permissions_id_seq OWNED BY public.rbac_permissions.id;


--
-- Name: rbac_role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_role_permissions (
    role_id integer NOT NULL,
    permission_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: rbac_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_roles (
    id integer NOT NULL,
    role_code character varying(50) NOT NULL,
    role_name character varying(100) NOT NULL,
    description text,
    is_system boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: rbac_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rbac_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rbac_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rbac_roles_id_seq OWNED BY public.rbac_roles.id;


--
-- Name: rbac_user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_user_roles (
    user_id integer NOT NULL,
    role_id integer NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    assigned_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    assigned_by integer
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(255) NOT NULL,
    device_info text,
    ip_address character varying(50),
    user_agent text,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL,
    is_revoked boolean DEFAULT false,
    revoked_at timestamp without time zone,
    revoked_reason character varying(100),
    last_used_at timestamp without time zone
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sequence_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_counters (
    id integer NOT NULL,
    sequence_name character varying(50) NOT NULL,
    prefix character varying(10) NOT NULL,
    current_value integer DEFAULT 0 NOT NULL,
    year integer NOT NULL,
    warehouse_id integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.sequence_counters FORCE ROW LEVEL SECURITY;


--
-- Name: sequence_counters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sequence_counters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sequence_counters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sequence_counters_id_seq OWNED BY public.sequence_counters.id;


--
-- Name: sscc_sequence; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sscc_sequence
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movement_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_movement_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id integer NOT NULL,
    movement_number character varying(50) NOT NULL,
    movement_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    serial_number_id integer NOT NULL,
    serial_number character varying(100) NOT NULL,
    item_id integer NOT NULL,
    client_id integer NOT NULL,
    movement_type character varying(30) NOT NULL,
    from_warehouse_id integer,
    from_zone_id integer,
    from_status character varying(20),
    to_warehouse_id integer,
    to_zone_id integer,
    to_status character varying(20),
    quantity integer DEFAULT 1 NOT NULL,
    grn_header_id integer,
    grn_line_id integer,
    do_header_id integer,
    do_line_id integer,
    gate_in_id integer,
    gate_out_id integer,
    reference_number character varying(100),
    reason text,
    notes text,
    unit_cost numeric(15,2),
    total_cost numeric(15,2),
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_system_generated boolean DEFAULT false,
    is_reversed boolean DEFAULT false,
    reversed_by_movement_id integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT stock_movements_movement_type_check CHECK (((movement_type)::text = ANY ((ARRAY['RECEIVE'::character varying, 'DISPATCH'::character varying, 'TRANSFER'::character varying, 'ADJUSTMENT'::character varying, 'RESERVE'::character varying, 'UNRESERVE'::character varying, 'RETURN'::character varying, 'DAMAGE'::character varying, 'LOST'::character varying, 'FOUND'::character varying])::text[])))
);

ALTER TABLE ONLY public.stock_movements FORCE ROW LEVEL SECURITY;


--
-- Name: stock_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_movements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_movements_id_seq OWNED BY public.stock_movements.id;


--
-- Name: stock_putaway_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_putaway_movements (
    id integer NOT NULL,
    stock_serial_id integer NOT NULL,
    serial_number character varying(255) NOT NULL,
    item_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    from_zone_layout_id integer,
    to_zone_layout_id integer NOT NULL,
    from_bin_location character varying(200),
    to_bin_location character varying(200) NOT NULL,
    remarks text,
    moved_by integer NOT NULL,
    moved_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.stock_putaway_movements FORCE ROW LEVEL SECURITY;


--
-- Name: stock_putaway_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_putaway_movements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_putaway_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_putaway_movements_id_seq OWNED BY public.stock_putaway_movements.id;


--
-- Name: stock_serial_numbers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_serial_numbers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_serial_numbers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_serial_numbers_id_seq OWNED BY public.stock_serial_numbers.id;


--
-- Name: storage_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_snapshot (
    id integer NOT NULL,
    company_id integer NOT NULL,
    client_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    snapshot_date date NOT NULL,
    item_id integer,
    uom character varying(20) DEFAULT 'UNIT'::character varying NOT NULL,
    units_in_stock integer DEFAULT 0 NOT NULL,
    pallets_in_stock numeric(14,3) DEFAULT 0 NOT NULL,
    volume_cbm numeric(14,3) DEFAULT 0 NOT NULL,
    weight_kg numeric(14,3) DEFAULT 0 NOT NULL,
    storage_days integer DEFAULT 1 NOT NULL,
    source_mode character varying(20) DEFAULT 'SNAPSHOT'::character varying NOT NULL,
    job_run_ref character varying(120),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT ck_ss_non_negative CHECK (((units_in_stock >= 0) AND (pallets_in_stock >= (0)::numeric) AND (volume_cbm >= (0)::numeric) AND (weight_kg >= (0)::numeric) AND (storage_days >= 0))),
    CONSTRAINT ck_ss_source_mode CHECK (((source_mode)::text = ANY ((ARRAY['SNAPSHOT'::character varying, 'DURATION'::character varying])::text[])))
);

ALTER TABLE ONLY public.storage_snapshot FORCE ROW LEVEL SECURITY;


--
-- Name: storage_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_snapshot_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_snapshot_id_seq OWNED BY public.storage_snapshot.id;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id integer NOT NULL,
    setting_key character varying(100) NOT NULL,
    setting_value text,
    setting_type character varying(20),
    description text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT system_settings_setting_type_check CHECK (((setting_type)::text = ANY ((ARRAY['STRING'::character varying, 'NUMBER'::character varying, 'BOOLEAN'::character varying, 'JSON'::character varying])::text[])))
);

ALTER TABLE ONLY public.system_settings FORCE ROW LEVEL SECURITY;


--
-- Name: system_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;


--
-- Name: tenant_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_products (
    id integer NOT NULL,
    company_id integer NOT NULL,
    product_code character varying(16) NOT NULL,
    plan_code character varying(40) DEFAULT 'STANDARD'::character varying NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    updated_by integer,
    CONSTRAINT ck_tenant_products_code CHECK (((product_code)::text = ANY ((ARRAY['WMS'::character varying, 'FF'::character varying])::text[]))),
    CONSTRAINT ck_tenant_products_date_window CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at >= starts_at))),
    CONSTRAINT ck_tenant_products_status CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'TRIAL'::character varying, 'INACTIVE'::character varying, 'SUSPENDED'::character varying])::text[])))
);

ALTER TABLE ONLY public.tenant_products FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenant_products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenant_products_id_seq OWNED BY public.tenant_products.id;


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    company_id integer NOT NULL,
    config_version integer DEFAULT 1 NOT NULL,
    feature_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    workflow_policies jsonb DEFAULT '{}'::jsonb NOT NULL,
    security_policies jsonb DEFAULT '{}'::jsonb NOT NULL,
    mobile_policies jsonb DEFAULT '{}'::jsonb NOT NULL,
    ui_branding jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_scopes (
    id uuid DEFAULT (md5(((random())::text || (clock_timestamp())::text)))::uuid NOT NULL,
    company_id integer NOT NULL,
    user_id integer NOT NULL,
    scope_type text NOT NULL,
    scope_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_scopes_scope_type_check CHECK ((scope_type = ANY (ARRAY['warehouse'::text, 'zone'::text, 'client'::text])))
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid NOT NULL,
    user_id integer NOT NULL,
    company_id integer NOT NULL,
    actor_type character varying(20) DEFAULT 'web'::character varying NOT NULL,
    device_id character varying(120),
    device_name character varying(160),
    ip_address character varying(64),
    user_agent text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    revoked_reason character varying(80),
    CONSTRAINT ck_user_sessions_actor_type CHECK (((actor_type)::text = ANY ((ARRAY['web'::character varying, 'mobile'::character varying, 'portal'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(100) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(100) NOT NULL,
    phone character varying(15),
    role character varying(50) NOT NULL,
    warehouse_id integer,
    failed_login_attempts integer DEFAULT 0,
    locked_until timestamp without time zone,
    password_changed_at timestamp without time zone,
    must_change_password boolean DEFAULT false,
    is_active boolean DEFAULT true,
    last_login_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    putaway_pin_hash text,
    putaway_pin_set_at timestamp with time zone,
    putaway_pin_set_by integer,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['SUPER_ADMIN'::character varying, 'ADMIN'::character varying, 'WAREHOUSE_MANAGER'::character varying, 'SUPERVISOR'::character varying, 'OPERATOR'::character varying, 'OPERATIONS'::character varying, 'GATE_STAFF'::character varying, 'FINANCE'::character varying, 'CLIENT'::character varying, 'VIEWER'::character varying])::text[])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: v_active_user_sessions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_active_user_sessions AS
 SELECT rt.id AS session_id,
    u.id AS user_id,
    u.username,
    u.full_name,
    u.role,
    w.warehouse_name,
    rt.device_info,
    rt.ip_address,
    rt.issued_at,
    rt.expires_at,
    rt.last_used_at,
        CASE
            WHEN (rt.expires_at < now()) THEN 'EXPIRED'::text
            WHEN (rt.is_revoked = true) THEN 'REVOKED'::text
            ELSE 'ACTIVE'::text
        END AS session_status
   FROM ((public.refresh_tokens rt
     JOIN public.users u ON ((rt.user_id = u.id)))
     LEFT JOIN public.warehouses w ON ((u.warehouse_id = w.id)))
  WHERE (rt.is_revoked = false)
  ORDER BY rt.last_used_at DESC NULLS LAST;


--
-- Name: v_asn_with_details; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_asn_with_details AS
SELECT
    NULL::integer AS id,
    NULL::character varying(50) AS asn_number,
    NULL::character varying(100) AS customer_po_number,
    NULL::character varying(20) AS client_code,
    NULL::character varying(200) AS client_name,
    NULL::character varying(15) AS gst_number,
    NULL::character varying(100) AS warehouse_name,
    NULL::character varying(200) AS ship_to_name,
    NULL::text AS ship_to_address,
    NULL::character varying(200) AS carrier_name,
    NULL::character varying(100) AS tracking_number,
    NULL::timestamp without time zone AS actual_ship_date,
    NULL::integer AS total_cartons,
    NULL::integer AS total_pallets,
    NULL::character varying(50) AS edi_format,
    NULL::character varying(50) AS status,
    NULL::bigint AS total_items,
    NULL::bigint AS total_quantity,
    NULL::character varying(100) AS created_by_name;


--
-- Name: v_client_stock_valuation; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_client_stock_valuation AS
 SELECT c.client_code,
    c.client_name,
    c.contract_type,
    w.warehouse_name,
    count(*) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS qty_in_stock,
    count(*) FILTER (WHERE ((s.status)::text = 'RESERVED'::text)) AS qty_reserved,
    count(*) FILTER (WHERE ((s.status)::text = 'DISPATCHED'::text)) AS qty_dispatched,
    count(*) AS total_items,
    sum(i.standard_mrp) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS value_in_stock,
    sum(i.standard_mrp) FILTER (WHERE ((s.status)::text = 'RESERVED'::text)) AS value_reserved,
    sum(i.standard_mrp) AS total_value,
    min(s.received_date) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)) AS oldest_stock_date,
    round((avg(date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone))) FILTER (WHERE ((s.status)::text = 'IN_STOCK'::text)))::numeric, 1) AS avg_age_days,
    count(*) FILTER (WHERE (((s.status)::text = 'IN_STOCK'::text) AND (date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone)) > (90)::double precision))) AS items_aged_90plus,
    count(*) FILTER (WHERE (((s.status)::text = 'IN_STOCK'::text) AND (date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone)) > (180)::double precision))) AS items_aged_180plus,
    ( SELECT count(*) AS count
           FROM public.stock_movements sm
          WHERE ((sm.client_id = c.id) AND (sm.to_warehouse_id = w.id) AND (sm.movement_date >= (CURRENT_DATE - '30 days'::interval)) AND (sm.is_reversed = false))) AS movements_last_30d
   FROM (((public.clients c
     CROSS JOIN public.warehouses w)
     LEFT JOIN public.stock_serial_numbers s ON (((c.id = s.client_id) AND (w.id = s.warehouse_id))))
     LEFT JOIN public.items i ON ((s.item_id = i.id)))
  WHERE (c.is_active = true)
  GROUP BY c.client_code, c.client_name, c.contract_type, c.id, w.warehouse_name, w.id
 HAVING ((count(*) > 0) OR (( SELECT count(*) AS count
           FROM public.stock_movements sm
          WHERE ((sm.client_id = c.id) AND (sm.to_warehouse_id = w.id) AND (sm.movement_date >= (CURRENT_DATE - '30 days'::interval)))) > 0))
  ORDER BY c.client_name, w.warehouse_name;


--
-- Name: warehouse_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_zones (
    id integer NOT NULL,
    warehouse_id integer NOT NULL,
    zone_code character varying(20) NOT NULL,
    zone_name character varying(100),
    zone_type character varying(50),
    capacity_cubic_meters numeric(10,2),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL
);

ALTER TABLE ONLY public.warehouse_zones FORCE ROW LEVEL SECURITY;


--
-- Name: v_current_stock_location; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_current_stock_location AS
 WITH latest_movements AS (
         SELECT DISTINCT ON (stock_movements.serial_number_id) stock_movements.serial_number_id,
            stock_movements.to_warehouse_id,
            stock_movements.to_zone_id,
            stock_movements.to_status,
            stock_movements.movement_date
           FROM public.stock_movements
          WHERE (stock_movements.is_reversed = false)
          ORDER BY stock_movements.serial_number_id, stock_movements.movement_date DESC
        )
 SELECT s.id AS serial_number_id,
    s.serial_number,
    i.item_code,
    i.item_name,
    c.client_name,
    w.warehouse_name,
    z.zone_name,
    lm.to_status AS current_status,
    s.received_date,
    lm.movement_date AS last_movement_date,
    date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone)) AS age_in_days
   FROM (((((public.stock_serial_numbers s
     JOIN public.items i ON ((s.item_id = i.id)))
     JOIN public.clients c ON ((s.client_id = c.id)))
     LEFT JOIN latest_movements lm ON ((s.id = lm.serial_number_id)))
     LEFT JOIN public.warehouses w ON ((COALESCE(lm.to_warehouse_id, s.warehouse_id) = w.id)))
     LEFT JOIN public.warehouse_zones z ON ((COALESCE(lm.to_zone_id, s.zone_id) = z.id)));


--
-- Name: v_current_stock_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_current_stock_summary AS
 SELECT s.client_id,
    c.client_name,
    s.item_id,
    i.item_code,
    i.item_name,
    s.warehouse_id,
    w.warehouse_name,
    count(s.id) AS total_quantity,
    min(s.received_date) AS oldest_stock_date,
    max(s.received_date) AS newest_stock_date,
    array_agg(s.serial_number ORDER BY s.received_date) AS serial_numbers
   FROM (((public.stock_serial_numbers s
     JOIN public.clients c ON ((s.client_id = c.id)))
     JOIN public.items i ON ((s.item_id = i.id)))
     JOIN public.warehouses w ON ((s.warehouse_id = w.id)))
  WHERE ((s.status)::text = 'IN_STOCK'::text)
  GROUP BY s.client_id, c.client_name, s.item_id, i.item_code, i.item_name, s.warehouse_id, w.warehouse_name;


--
-- Name: v_daily_movement_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_daily_movement_summary AS
 SELECT date(sm.movement_date) AS movement_date,
    w.warehouse_name,
    c.client_name,
    i.item_name,
    sm.movement_type,
    count(*) AS movement_count,
    sum(sm.quantity) AS total_quantity,
    sum(sm.total_cost) AS total_value
   FROM (((public.stock_movements sm
     JOIN public.warehouses w ON ((sm.to_warehouse_id = w.id)))
     JOIN public.clients c ON ((sm.client_id = c.id)))
     JOIN public.items i ON ((sm.item_id = i.id)))
  WHERE (sm.is_reversed = false)
  GROUP BY (date(sm.movement_date)), w.warehouse_name, c.client_name, i.item_name, sm.movement_type
  ORDER BY (date(sm.movement_date)) DESC, w.warehouse_name, c.client_name;


--
-- Name: v_do_with_fulfillment; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_do_with_fulfillment AS
 SELECT dh.id,
    dh.do_number,
    dh.request_date,
    c.client_code,
    c.client_name,
    w.warehouse_name,
    dh.total_items,
    dh.total_quantity_requested,
    dh.total_quantity_dispatched,
        CASE
            WHEN (dh.total_quantity_dispatched = 0) THEN (0)::numeric
            ELSE round((((dh.total_quantity_dispatched)::numeric / (dh.total_quantity_requested)::numeric) * (100)::numeric), 2)
        END AS fulfillment_percentage,
    dh.status,
    u.full_name AS created_by_name,
    dh.created_at
   FROM (((public.do_header dh
     JOIN public.clients c ON ((dh.client_id = c.id)))
     JOIN public.warehouses w ON ((dh.warehouse_id = w.id)))
     JOIN public.users u ON ((dh.created_by = u.id)));


--
-- Name: v_expiring_stock_alert; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_expiring_stock_alert AS
 SELECT c.client_name,
    i.item_code,
    i.item_name,
    w.warehouse_name,
    s.batch_number,
    s.expiry_date,
    s.remaining_shelf_life_days,
    count(s.id) AS quantity,
        CASE
            WHEN (s.remaining_shelf_life_days <= 7) THEN 'CRITICAL'::text
            WHEN (s.remaining_shelf_life_days <= 30) THEN 'WARNING'::text
            WHEN (s.remaining_shelf_life_days <= 60) THEN 'NOTICE'::text
            ELSE 'OK'::text
        END AS alert_level
   FROM (((public.stock_serial_numbers s
     JOIN public.clients c ON ((s.client_id = c.id)))
     JOIN public.items i ON ((s.item_id = i.id)))
     JOIN public.warehouses w ON ((s.warehouse_id = w.id)))
  WHERE (((s.status)::text = 'IN_STOCK'::text) AND (s.expiry_date IS NOT NULL) AND (s.remaining_shelf_life_days <= 60))
  GROUP BY c.client_name, i.item_code, i.item_name, w.warehouse_name, s.batch_number, s.expiry_date, s.remaining_shelf_life_days
  ORDER BY s.remaining_shelf_life_days;


--
-- Name: v_fifo_aging_analysis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_fifo_aging_analysis AS
 WITH ranked_stock AS (
         SELECT s.id,
            s.serial_number,
            s.item_id,
            s.client_id,
            s.warehouse_id,
            s.zone_id,
            s.status,
            s.received_date,
            date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone)) AS age_days,
            row_number() OVER (PARTITION BY s.client_id, s.item_id, s.warehouse_id, s.status ORDER BY s.received_date) AS fifo_rank,
            count(*) OVER (PARTITION BY s.client_id, s.item_id, s.warehouse_id, s.status) AS total_in_group
           FROM public.stock_serial_numbers s
          WHERE ((s.status)::text = ANY ((ARRAY['IN_STOCK'::character varying, 'RESERVED'::character varying])::text[]))
        )
 SELECT rs.serial_number,
    i.item_code,
    i.item_name,
    c.client_code,
    c.client_name,
    w.warehouse_name,
    z.zone_name,
    rs.status,
    rs.received_date,
    rs.age_days,
    rs.fifo_rank,
    rs.total_in_group,
        CASE
            WHEN (rs.fifo_rank <= 3) THEN 'HIGH_PRIORITY'::text
            WHEN (rs.fifo_rank <= 10) THEN 'MEDIUM_PRIORITY'::text
            ELSE 'LOW_PRIORITY'::text
        END AS pick_priority,
        CASE
            WHEN (rs.age_days >= (180)::double precision) THEN '6+ MONTHS'::text
            WHEN (rs.age_days >= (90)::double precision) THEN '3-6 MONTHS'::text
            WHEN (rs.age_days >= (30)::double precision) THEN '1-3 MONTHS'::text
            WHEN (rs.age_days >= (7)::double precision) THEN '1-4 WEEKS'::text
            ELSE 'UNDER 1 WEEK'::text
        END AS age_bracket,
        CASE
            WHEN (rs.age_days >= (180)::double precision) THEN 'URGENT: Stock over 6 months old'::text
            WHEN (rs.age_days >= (120)::double precision) THEN 'WARNING: Stock over 4 months old'::text
            WHEN (rs.age_days >= (90)::double precision) THEN 'ATTENTION: Stock over 3 months old'::text
            ELSE NULL::text
        END AS aging_alert,
    i.standard_mrp AS unit_value,
    (rs.age_days * (COALESCE(i.standard_mrp, (0)::numeric))::double precision) AS holding_cost_days
   FROM ((((ranked_stock rs
     JOIN public.items i ON ((rs.item_id = i.id)))
     JOIN public.clients c ON ((rs.client_id = c.id)))
     JOIN public.warehouses w ON ((rs.warehouse_id = w.id)))
     LEFT JOIN public.warehouse_zones z ON ((rs.zone_id = z.id)))
  ORDER BY c.client_name, i.item_code, rs.fifo_rank;


--
-- Name: v_grn_with_details; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_grn_with_details AS
 SELECT gh.id,
    gh.grn_number,
    gh.grn_date,
    gh.invoice_number,
    gh.invoice_date,
    c.client_code,
    c.client_name,
    w.warehouse_name,
    gh.total_items,
    gh.total_quantity,
    gh.total_value,
    gh.base_labor_charge,
    gh.forklift_charge,
    gh.total_labor_cost,
    gh.status,
    u.full_name AS created_by_name,
    gh.created_at
   FROM (((public.grn_header gh
     JOIN public.clients c ON ((gh.client_id = c.id)))
     JOIN public.warehouses w ON ((gh.warehouse_id = w.id)))
     JOIN public.users u ON ((gh.created_by = u.id)));


--
-- Name: v_movement_summary_by_period; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_movement_summary_by_period AS
 WITH daily_movements AS (
         SELECT date(stock_movements.movement_date) AS movement_date,
            stock_movements.client_id,
            stock_movements.item_id,
            stock_movements.to_warehouse_id AS warehouse_id,
            stock_movements.movement_type,
            count(*) AS movement_count,
            sum(stock_movements.quantity) AS total_quantity,
            sum(stock_movements.total_cost) AS total_value
           FROM public.stock_movements
          WHERE ((stock_movements.is_reversed = false) AND (stock_movements.movement_date >= (CURRENT_DATE - '90 days'::interval)))
          GROUP BY (date(stock_movements.movement_date)), stock_movements.client_id, stock_movements.item_id, stock_movements.to_warehouse_id, stock_movements.movement_type
        )
 SELECT dm.movement_date,
    date_part('year'::text, dm.movement_date) AS year,
    date_part('month'::text, dm.movement_date) AS month,
    date_part('week'::text, dm.movement_date) AS week_number,
    to_char((dm.movement_date)::timestamp with time zone, 'Day'::text) AS day_of_week,
    c.client_code,
    c.client_name,
    i.item_code,
    i.item_name,
    ic.category_name,
    w.warehouse_code,
    w.warehouse_name,
    dm.movement_type,
    dm.movement_count,
    dm.total_quantity,
    dm.total_value,
    sum(dm.movement_count) OVER (PARTITION BY (date_trunc('month'::text, (dm.movement_date)::timestamp with time zone)), dm.client_id, dm.item_id, dm.warehouse_id, dm.movement_type ORDER BY dm.movement_date) AS cumulative_count_month,
    sum(dm.total_quantity) OVER (PARTITION BY (date_trunc('month'::text, (dm.movement_date)::timestamp with time zone)), dm.client_id, dm.item_id, dm.warehouse_id, dm.movement_type ORDER BY dm.movement_date) AS cumulative_quantity_month,
    avg(dm.movement_count) OVER (PARTITION BY dm.client_id, dm.item_id, dm.warehouse_id, dm.movement_type ORDER BY dm.movement_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg_7d,
    lag(dm.movement_count) OVER (PARTITION BY dm.client_id, dm.item_id, dm.warehouse_id, dm.movement_type ORDER BY dm.movement_date) AS previous_day_count,
    (dm.movement_count - lag(dm.movement_count) OVER (PARTITION BY dm.client_id, dm.item_id, dm.warehouse_id, dm.movement_type ORDER BY dm.movement_date)) AS day_over_day_change
   FROM ((((daily_movements dm
     JOIN public.clients c ON ((dm.client_id = c.id)))
     JOIN public.items i ON ((dm.item_id = i.id)))
     LEFT JOIN public.item_categories ic ON ((i.category_id = ic.id)))
     JOIN public.warehouses w ON ((dm.warehouse_id = w.id)))
  ORDER BY dm.movement_date DESC, c.client_name, i.item_name;


--
-- Name: v_serial_movement_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_serial_movement_history AS
 SELECT sm.id,
    sm.movement_number,
    sm.movement_date,
    sm.movement_type,
    sm.serial_number,
    i.item_code,
    i.item_name,
    c.client_name,
    wf.warehouse_name AS from_warehouse,
    zf.zone_name AS from_zone,
    sm.from_status,
    wt.warehouse_name AS to_warehouse,
    zt.zone_name AS to_zone,
    sm.to_status,
    sm.reference_number,
    sm.reason,
    u.full_name AS created_by_name,
    sm.created_at,
    sm.is_reversed
   FROM (((((((public.stock_movements sm
     JOIN public.items i ON ((sm.item_id = i.id)))
     JOIN public.clients c ON ((sm.client_id = c.id)))
     LEFT JOIN public.warehouses wf ON ((sm.from_warehouse_id = wf.id)))
     LEFT JOIN public.warehouse_zones zf ON ((sm.from_zone_id = zf.id)))
     LEFT JOIN public.warehouses wt ON ((sm.to_warehouse_id = wt.id)))
     LEFT JOIN public.warehouse_zones zt ON ((sm.to_zone_id = zt.id)))
     JOIN public.users u ON ((sm.created_by = u.id)))
  ORDER BY sm.movement_date DESC;


--
-- Name: v_slow_moving_stock; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_slow_moving_stock AS
 WITH stock_age AS (
         SELECT s.id,
            s.serial_number,
            s.item_id,
            s.client_id,
            s.warehouse_id,
            s.zone_id,
            s.status,
            s.received_date,
            date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone)) AS days_in_stock,
            ( SELECT max(stock_movements.movement_date) AS max
                   FROM public.stock_movements
                  WHERE ((stock_movements.serial_number_id = s.id) AND (stock_movements.is_reversed = false))) AS last_movement_date,
            COALESCE(date_part('day'::text, (CURRENT_TIMESTAMP - (( SELECT max(stock_movements.movement_date) AS max
                   FROM public.stock_movements
                  WHERE ((stock_movements.serial_number_id = s.id) AND (stock_movements.is_reversed = false))))::timestamp with time zone)), date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone))) AS days_since_last_movement
           FROM public.stock_serial_numbers s
          WHERE ((s.status)::text = 'IN_STOCK'::text)
        )
 SELECT sa.serial_number,
    i.item_code,
    i.item_name,
    ic.category_name,
    c.client_code,
    c.client_name,
    w.warehouse_name,
    z.zone_name,
    sa.received_date,
    sa.days_in_stock,
    sa.last_movement_date,
    sa.days_since_last_movement,
        CASE
            WHEN (sa.days_since_last_movement >= (180)::double precision) THEN 'DEAD_STOCK'::text
            WHEN (sa.days_since_last_movement >= (120)::double precision) THEN 'VERY_SLOW'::text
            WHEN (sa.days_since_last_movement >= (90)::double precision) THEN 'SLOW'::text
            WHEN (sa.days_since_last_movement >= (60)::double precision) THEN 'MODERATE'::text
            ELSE 'ACTIVE'::text
        END AS movement_category,
        CASE
            WHEN (sa.days_in_stock >= (365)::double precision) THEN 'OVER_1_YEAR'::text
            WHEN (sa.days_in_stock >= (180)::double precision) THEN '6_TO_12_MONTHS'::text
            WHEN (sa.days_in_stock >= (90)::double precision) THEN '3_TO_6_MONTHS'::text
            WHEN (sa.days_in_stock >= (30)::double precision) THEN '1_TO_3_MONTHS'::text
            ELSE 'UNDER_1_MONTH'::text
        END AS age_category,
    i.standard_mrp AS unit_value,
    i.standard_mrp AS blocked_value
   FROM (((((stock_age sa
     JOIN public.items i ON ((sa.item_id = i.id)))
     LEFT JOIN public.item_categories ic ON ((i.category_id = ic.id)))
     JOIN public.clients c ON ((sa.client_id = c.id)))
     JOIN public.warehouses w ON ((sa.warehouse_id = w.id)))
     LEFT JOIN public.warehouse_zones z ON ((sa.zone_id = z.id)))
  WHERE (sa.days_since_last_movement >= (60)::double precision)
  ORDER BY sa.days_since_last_movement DESC;


--
-- Name: v_stock_summary_dashboard; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_summary_dashboard AS
 WITH stock_metrics AS (
         SELECT s.client_id,
            s.item_id,
            s.warehouse_id,
            s.status,
            count(*) AS quantity,
            min(s.received_date) AS oldest_stock_date,
            max(s.received_date) AS newest_stock_date,
            avg(date_part('day'::text, (CURRENT_TIMESTAMP - (s.received_date)::timestamp with time zone))) AS avg_age_days,
            sum(i_1.standard_mrp) AS total_value
           FROM (public.stock_serial_numbers s
             JOIN public.items i_1 ON ((s.item_id = i_1.id)))
          GROUP BY s.client_id, s.item_id, s.warehouse_id, s.status
        ), movement_metrics AS (
         SELECT stock_movements.client_id,
            stock_movements.item_id,
            stock_movements.to_warehouse_id AS warehouse_id,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'RECEIVE'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '30 days'::interval)))) AS received_30d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'DISPATCH'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '30 days'::interval)))) AS dispatched_30d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'RECEIVE'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '7 days'::interval)))) AS received_7d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'DISPATCH'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '7 days'::interval)))) AS dispatched_7d,
            max(stock_movements.movement_date) FILTER (WHERE ((stock_movements.movement_type)::text = 'DISPATCH'::text)) AS last_dispatch_date,
            max(stock_movements.movement_date) FILTER (WHERE ((stock_movements.movement_type)::text = 'RECEIVE'::text)) AS last_receive_date
           FROM public.stock_movements
          WHERE (stock_movements.is_reversed = false)
          GROUP BY stock_movements.client_id, stock_movements.item_id, stock_movements.to_warehouse_id
        )
 SELECT c.client_code,
    c.client_name,
    i.item_code,
    i.item_name,
    ic.category_name,
    w.warehouse_code,
    w.warehouse_name,
    COALESCE(sum(sm.quantity) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text)), (0)::numeric) AS qty_in_stock,
    COALESCE(sum(sm.quantity) FILTER (WHERE ((sm.status)::text = 'RESERVED'::text)), (0)::numeric) AS qty_reserved,
    COALESCE(sum(sm.quantity) FILTER (WHERE ((sm.status)::text = 'DISPATCHED'::text)), (0)::numeric) AS qty_dispatched,
    COALESCE(sum(sm.quantity), (0)::numeric) AS qty_total,
    COALESCE(sum(sm.total_value) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text)), (0)::numeric) AS value_in_stock,
    COALESCE(sum(sm.total_value) FILTER (WHERE ((sm.status)::text = 'RESERVED'::text)), (0)::numeric) AS value_reserved,
    COALESCE(sum(sm.total_value), (0)::numeric) AS value_total,
    min(sm.oldest_stock_date) AS oldest_stock_date,
    max(sm.newest_stock_date) AS newest_stock_date,
    round((avg(sm.avg_age_days))::numeric, 1) AS avg_age_days,
    COALESCE(max(mm.received_30d), (0)::bigint) AS received_last_30d,
    COALESCE(max(mm.dispatched_30d), (0)::bigint) AS dispatched_last_30d,
    COALESCE(max(mm.received_7d), (0)::bigint) AS received_last_7d,
    COALESCE(max(mm.dispatched_7d), (0)::bigint) AS dispatched_last_7d,
    max(mm.last_receive_date) AS last_receive_date,
    max(mm.last_dispatch_date) AS last_dispatch_date,
        CASE
            WHEN (avg(sm.quantity) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text)) > (0)::numeric) THEN round((((max(mm.dispatched_30d))::numeric / avg(sm.quantity) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text))) * (12)::numeric), 2)
            ELSE (0)::numeric
        END AS annual_turnover_rate,
        CASE
            WHEN (max(mm.last_dispatch_date) IS NULL) THEN 'NO_MOVEMENT'::text
            WHEN (max(mm.last_dispatch_date) < (CURRENT_DATE - '90 days'::interval)) THEN 'SLOW_MOVING'::text
            WHEN (max(mm.dispatched_30d) > max(mm.received_30d)) THEN 'DEPLETING'::text
            WHEN (max(mm.received_30d) > max(mm.dispatched_30d)) THEN 'ACCUMULATING'::text
            ELSE 'BALANCED'::text
        END AS stock_health,
        CASE
            WHEN (COALESCE(sum(sm.quantity) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text)), (0)::numeric) = (0)::numeric) THEN 'OUT_OF_STOCK'::text
            WHEN (COALESCE(sum(sm.quantity) FILTER (WHERE ((sm.status)::text = 'IN_STOCK'::text)), (0)::numeric) < (COALESCE(i.min_stock_alert, 5))::numeric) THEN 'LOW_STOCK'::text
            WHEN (avg(sm.avg_age_days) > (180)::double precision) THEN 'AGED_STOCK'::text
            ELSE 'NORMAL'::text
        END AS alert_level
   FROM (((((public.clients c
     CROSS JOIN public.items i)
     CROSS JOIN public.warehouses w)
     LEFT JOIN public.item_categories ic ON ((i.category_id = ic.id)))
     LEFT JOIN stock_metrics sm ON (((c.id = sm.client_id) AND (i.id = sm.item_id) AND (w.id = sm.warehouse_id))))
     LEFT JOIN movement_metrics mm ON (((c.id = mm.client_id) AND (i.id = mm.item_id) AND (w.id = mm.warehouse_id))))
  WHERE ((sm.quantity IS NOT NULL) OR (mm.received_30d IS NOT NULL))
  GROUP BY c.client_code, c.client_name, i.item_code, i.item_name, ic.category_name, i.min_stock_alert, w.warehouse_code, w.warehouse_name
 HAVING ((COALESCE(sum(sm.quantity), (0)::numeric) > (0)::numeric) OR (COALESCE(max(mm.received_30d), (0)::bigint) > 0))
  ORDER BY c.client_name, i.item_name, w.warehouse_name;


--
-- Name: v_stock_velocity_analysis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_velocity_analysis AS
 WITH stock_levels AS (
         SELECT stock_serial_numbers.client_id,
            stock_serial_numbers.item_id,
            stock_serial_numbers.warehouse_id,
            count(*) FILTER (WHERE ((stock_serial_numbers.status)::text = 'IN_STOCK'::text)) AS current_stock,
            avg(date_part('day'::text, (CURRENT_TIMESTAMP - (stock_serial_numbers.received_date)::timestamp with time zone))) AS avg_age_days
           FROM public.stock_serial_numbers
          WHERE ((stock_serial_numbers.status)::text = ANY ((ARRAY['IN_STOCK'::character varying, 'RESERVED'::character varying])::text[]))
          GROUP BY stock_serial_numbers.client_id, stock_serial_numbers.item_id, stock_serial_numbers.warehouse_id
        ), movement_velocity AS (
         SELECT stock_movements.client_id,
            stock_movements.item_id,
            stock_movements.to_warehouse_id AS warehouse_id,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'RECEIVE'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '30 days'::interval)))) AS received_30d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'DISPATCH'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '30 days'::interval)))) AS dispatched_30d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'RECEIVE'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '60 days'::interval)))) AS received_60d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'DISPATCH'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '60 days'::interval)))) AS dispatched_60d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'RECEIVE'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '90 days'::interval)))) AS received_90d,
            count(*) FILTER (WHERE (((stock_movements.movement_type)::text = 'DISPATCH'::text) AND (stock_movements.movement_date >= (CURRENT_DATE - '90 days'::interval)))) AS dispatched_90d
           FROM public.stock_movements
          WHERE (stock_movements.is_reversed = false)
          GROUP BY stock_movements.client_id, stock_movements.item_id, stock_movements.to_warehouse_id
        )
 SELECT c.client_code,
    c.client_name,
    i.item_code,
    i.item_name,
    ic.category_name,
    w.warehouse_code,
    w.warehouse_name,
    sl.current_stock,
    round((sl.avg_age_days)::numeric, 1) AS avg_age_days,
    mv.dispatched_30d,
    mv.dispatched_60d,
    mv.dispatched_90d,
        CASE
            WHEN (sl.current_stock > 0) THEN round((((mv.dispatched_30d)::numeric / (sl.current_stock)::numeric) * (12)::numeric), 2)
            ELSE (0)::numeric
        END AS annual_turnover_rate,
        CASE
            WHEN (mv.dispatched_30d > 0) THEN round(((sl.current_stock)::numeric / ((mv.dispatched_30d)::numeric / (30)::numeric)), 1)
            ELSE (999)::numeric
        END AS days_of_supply,
        CASE
            WHEN (mv.dispatched_30d >= 20) THEN 'A_FAST'::text
            WHEN (mv.dispatched_30d >= 10) THEN 'B_MEDIUM'::text
            WHEN (mv.dispatched_30d >= 5) THEN 'C_SLOW'::text
            WHEN (mv.dispatched_30d > 0) THEN 'D_VERY_SLOW'::text
            ELSE 'E_NO_MOVEMENT'::text
        END AS velocity_class,
        CASE
            WHEN (sl.current_stock = 0) THEN 'OUT_OF_STOCK'::text
            WHEN ((sl.current_stock < 5) AND (mv.dispatched_30d > 10)) THEN 'UNDERSTOCKED'::text
            WHEN ((sl.current_stock > 50) AND (mv.dispatched_30d < 5)) THEN 'OVERSTOCKED'::text
            WHEN (((sl.current_stock)::numeric / (NULLIF(mv.dispatched_30d, 0))::numeric) > (90)::numeric) THEN 'EXCESSIVE'::text
            ELSE 'NORMAL'::text
        END AS stock_status,
        CASE
            WHEN (sl.current_stock = 0) THEN 'URGENT_REORDER'::text
            WHEN ((mv.dispatched_30d > 0) AND (((sl.current_stock)::numeric / ((mv.dispatched_30d)::numeric / (30)::numeric)) < (14)::numeric)) THEN 'REORDER_SOON'::text
            WHEN ((mv.dispatched_30d > 0) AND (((sl.current_stock)::numeric / ((mv.dispatched_30d)::numeric / (30)::numeric)) < (30)::numeric)) THEN 'MONITOR'::text
            ELSE 'ADEQUATE'::text
        END AS reorder_recommendation,
    i.standard_mrp AS unit_value,
    ((sl.current_stock)::numeric * COALESCE(i.standard_mrp, (0)::numeric)) AS inventory_value
   FROM (((((public.clients c
     CROSS JOIN public.items i)
     CROSS JOIN public.warehouses w)
     LEFT JOIN public.item_categories ic ON ((i.category_id = ic.id)))
     LEFT JOIN stock_levels sl ON (((c.id = sl.client_id) AND (i.id = sl.item_id) AND (w.id = sl.warehouse_id))))
     LEFT JOIN movement_velocity mv ON (((c.id = mv.client_id) AND (i.id = mv.item_id) AND (w.id = mv.warehouse_id))))
  WHERE ((sl.current_stock IS NOT NULL) OR (mv.dispatched_90d IS NOT NULL))
  ORDER BY
        CASE
            WHEN (mv.dispatched_30d >= 20) THEN 1
            WHEN (mv.dispatched_30d >= 10) THEN 2
            WHEN (mv.dispatched_30d >= 5) THEN 3
            WHEN (mv.dispatched_30d > 0) THEN 4
            ELSE 5
        END, c.client_name, i.item_name;


--
-- Name: v_stock_with_expiry; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_with_expiry AS
 SELECT s.client_id,
    c.client_name,
    s.item_id,
    i.item_code,
    i.item_name,
    s.warehouse_id,
    w.warehouse_name,
    s.batch_number,
    s.expiry_date,
    count(s.id) AS quantity,
    min(s.received_date) AS oldest_received_date,
    min(s.remaining_shelf_life_days) AS min_shelf_life_days,
    array_agg(s.serial_number ORDER BY s.received_date) AS serial_numbers
   FROM (((public.stock_serial_numbers s
     JOIN public.clients c ON ((s.client_id = c.id)))
     JOIN public.items i ON ((s.item_id = i.id)))
     JOIN public.warehouses w ON ((s.warehouse_id = w.id)))
  WHERE ((s.status)::text = 'IN_STOCK'::text)
  GROUP BY s.client_id, c.client_name, s.item_id, i.item_code, i.item_name, s.warehouse_id, w.warehouse_name, s.batch_number, s.expiry_date;


--
-- Name: v_warehouse_utilization; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_warehouse_utilization AS
 WITH zone_utilization AS (
         SELECT stock_serial_numbers.warehouse_id,
            stock_serial_numbers.zone_id,
            count(*) AS items_stored,
            count(*) FILTER (WHERE ((stock_serial_numbers.status)::text = 'IN_STOCK'::text)) AS items_available,
            count(*) FILTER (WHERE ((stock_serial_numbers.status)::text = 'RESERVED'::text)) AS items_reserved
           FROM public.stock_serial_numbers
          GROUP BY stock_serial_numbers.warehouse_id, stock_serial_numbers.zone_id
        )
 SELECT w.warehouse_code,
    w.warehouse_name,
    w.city,
    z.zone_code,
    z.zone_name,
    z.zone_type,
    z.capacity_cubic_meters,
    zu.items_stored,
    zu.items_available,
    zu.items_reserved,
        CASE
            WHEN (z.capacity_cubic_meters > (0)::numeric) THEN round((((zu.items_stored)::numeric / z.capacity_cubic_meters) * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS utilization_percentage,
        CASE
            WHEN ((z.capacity_cubic_meters > (0)::numeric) AND (((zu.items_stored)::numeric / z.capacity_cubic_meters) >= 0.95)) THEN 'CRITICAL'::text
            WHEN ((z.capacity_cubic_meters > (0)::numeric) AND (((zu.items_stored)::numeric / z.capacity_cubic_meters) >= 0.80)) THEN 'HIGH'::text
            WHEN ((z.capacity_cubic_meters > (0)::numeric) AND (((zu.items_stored)::numeric / z.capacity_cubic_meters) >= 0.60)) THEN 'MODERATE'::text
            WHEN ((z.capacity_cubic_meters > (0)::numeric) AND (((zu.items_stored)::numeric / z.capacity_cubic_meters) >= 0.40)) THEN 'LOW'::text
            ELSE 'MINIMAL'::text
        END AS capacity_status,
    z.is_active AS zone_active
   FROM ((public.warehouses w
     LEFT JOIN public.warehouse_zones z ON ((w.id = z.warehouse_id)))
     LEFT JOIN zone_utilization zu ON (((w.id = zu.warehouse_id) AND (z.id = zu.zone_id))))
  WHERE (w.is_active = true)
  ORDER BY w.warehouse_name, z.zone_code;


--
-- Name: workforce_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_tasks (
    id integer NOT NULL,
    warehouse_id integer NOT NULL,
    user_id integer NOT NULL,
    task_type character varying(50) NOT NULL,
    task_reference_type character varying(50),
    task_reference_id integer,
    start_time timestamp without time zone NOT NULL,
    end_time timestamp without time zone,
    duration_minutes integer,
    quantity_processed integer DEFAULT 0,
    items_count integer DEFAULT 0,
    errors_count integer DEFAULT 0,
    quality_score numeric(5,2),
    status character varying(50) DEFAULT 'IN_PROGRESS'::character varying,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    CONSTRAINT workforce_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['IN_PROGRESS'::character varying, 'COMPLETED'::character varying, 'PAUSED'::character varying, 'CANCELLED'::character varying])::text[])))
);

ALTER TABLE ONLY public.workforce_tasks FORCE ROW LEVEL SECURITY;


--
-- Name: v_workforce_productivity; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_workforce_productivity AS
 SELECT wt.warehouse_id,
    w.warehouse_name,
    wt.user_id,
    u.full_name,
    u.role,
    date(wt.start_time) AS work_date,
    wt.task_type,
    count(*) AS tasks_completed,
    sum(wt.quantity_processed) AS total_quantity,
    avg(wt.duration_minutes) AS avg_task_duration,
    sum(wt.duration_minutes) AS total_work_minutes,
    avg(wt.quality_score) AS avg_quality_score,
    sum(wt.errors_count) AS total_errors
   FROM ((public.workforce_tasks wt
     JOIN public.warehouses w ON ((wt.warehouse_id = w.id)))
     JOIN public.users u ON ((wt.user_id = u.id)))
  WHERE ((wt.status)::text = 'COMPLETED'::text)
  GROUP BY wt.warehouse_id, w.warehouse_name, wt.user_id, u.full_name, u.role, (date(wt.start_time)), wt.task_type;


--
-- Name: warehouse_zone_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_zone_layouts (
    id integer NOT NULL,
    warehouse_id integer NOT NULL,
    zone_code character varying(30) NOT NULL,
    zone_name character varying(100) NOT NULL,
    rack_code character varying(30) NOT NULL,
    rack_name character varying(100) NOT NULL,
    bin_code character varying(40) NOT NULL,
    bin_name character varying(120) NOT NULL,
    capacity_units integer,
    sort_order integer DEFAULT 0 NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    zone_type character varying(30) DEFAULT 'STORAGE'::character varying NOT NULL,
    bin_status character varying(20) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    warehouse_zone_id integer,
    CONSTRAINT warehouse_zone_layouts_bin_status_check CHECK (((bin_status)::text = ANY ((ARRAY['AVAILABLE'::character varying, 'BLOCKED'::character varying, 'HOLD'::character varying, 'DAMAGED'::character varying, 'COUNTING'::character varying])::text[]))),
    CONSTRAINT warehouse_zone_layouts_zone_type_check CHECK (((zone_type)::text = ANY ((ARRAY['RECEIVING'::character varying, 'STORAGE'::character varying, 'PICKING'::character varying, 'PACKING'::character varying, 'STAGING'::character varying, 'DISPATCH'::character varying, 'RETURNS'::character varying, 'QC'::character varying, 'QUARANTINE'::character varying, 'DAMAGE'::character varying])::text[])))
);

ALTER TABLE ONLY public.warehouse_zone_layouts FORCE ROW LEVEL SECURITY;


--
-- Name: warehouse_zone_layouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_zone_layouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_zone_layouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_zone_layouts_id_seq OWNED BY public.warehouse_zone_layouts.id;


--
-- Name: warehouse_zones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_zones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_zones_id_seq OWNED BY public.warehouse_zones.id;


--
-- Name: warehouses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouses_id_seq OWNED BY public.warehouses.id;


--
-- Name: wes_command_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wes_command_queue (
    id bigint NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    equipment_id integer NOT NULL,
    command_type character varying(40) NOT NULL,
    command_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id character varying(120),
    requested_by integer,
    priority integer DEFAULT 50 NOT NULL,
    status character varying(20) DEFAULT 'QUEUED'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone,
    dispatched_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_wes_command_status CHECK (((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'DISPATCHING'::character varying, 'ACKED'::character varying, 'DONE'::character varying, 'RETRY'::character varying, 'DEAD_LETTER'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT ck_wes_command_type CHECK (((command_type)::text = ANY ((ARRAY['MOVE'::character varying, 'PICK'::character varying, 'DROP'::character varying, 'CHARGE'::character varying, 'PAUSE'::character varying, 'RESUME'::character varying, 'RESET'::character varying, 'ESTOP'::character varying, 'CUSTOM'::character varying])::text[]))),
    CONSTRAINT wes_command_queue_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 20))),
    CONSTRAINT wes_command_queue_priority_check CHECK (((priority >= 1) AND (priority <= 100)))
);

ALTER TABLE ONLY public.wes_command_queue FORCE ROW LEVEL SECURITY;


--
-- Name: wes_command_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wes_command_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wes_command_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wes_command_queue_id_seq OWNED BY public.wes_command_queue.id;


--
-- Name: wes_equipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wes_equipment (
    id integer NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    equipment_code character varying(60) NOT NULL,
    equipment_name character varying(150) NOT NULL,
    equipment_type character varying(30) NOT NULL,
    adapter_type character varying(30) DEFAULT 'MOCK'::character varying NOT NULL,
    warehouse_id integer,
    zone_layout_id integer,
    status character varying(20) DEFAULT 'IDLE'::character varying NOT NULL,
    safety_mode boolean DEFAULT false NOT NULL,
    heartbeat_timeout_seconds integer DEFAULT 60 NOT NULL,
    last_heartbeat_at timestamp with time zone,
    last_error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_wes_adapter_type CHECK (((adapter_type)::text = ANY ((ARRAY['MOCK'::character varying, 'REST'::character varying, 'MQTT'::character varying, 'PLC'::character varying, 'OPCUA'::character varying])::text[]))),
    CONSTRAINT ck_wes_equipment_status CHECK (((status)::text = ANY ((ARRAY['OFFLINE'::character varying, 'IDLE'::character varying, 'READY'::character varying, 'BUSY'::character varying, 'CHARGING'::character varying, 'PAUSED'::character varying, 'FAULT'::character varying, 'ESTOP'::character varying])::text[]))),
    CONSTRAINT ck_wes_equipment_type CHECK (((equipment_type)::text = ANY ((ARRAY['AMR'::character varying, 'CONVEYOR'::character varying, 'SORTER'::character varying, 'ASRS'::character varying, 'SHUTTLE'::character varying, 'PICK_ARM'::character varying, 'OTHER'::character varying])::text[]))),
    CONSTRAINT wes_equipment_heartbeat_timeout_seconds_check CHECK (((heartbeat_timeout_seconds >= 10) AND (heartbeat_timeout_seconds <= 600)))
);

ALTER TABLE ONLY public.wes_equipment FORCE ROW LEVEL SECURITY;


--
-- Name: wes_equipment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wes_equipment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wes_equipment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wes_equipment_id_seq OWNED BY public.wes_equipment.id;


--
-- Name: wes_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wes_event_log (
    id bigint NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    equipment_id integer,
    command_id bigint,
    event_type character varying(40) NOT NULL,
    event_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_type character varying(20) DEFAULT 'SYSTEM'::character varying NOT NULL,
    source_ref character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_wes_event_source CHECK (((source_type)::text = ANY ((ARRAY['SYSTEM'::character varying, 'ADAPTER'::character varying, 'OPERATOR'::character varying, 'DEVICE'::character varying])::text[]))),
    CONSTRAINT ck_wes_event_type CHECK (((event_type)::text = ANY ((ARRAY['HEARTBEAT'::character varying, 'STATUS'::character varying, 'COMMAND_ACCEPTED'::character varying, 'COMMAND_FAILED'::character varying, 'COMMAND_DONE'::character varying, 'SAFETY_TRIP'::character varying, 'FAILOVER'::character varying, 'ALARM'::character varying, 'CUSTOM'::character varying])::text[])))
);

ALTER TABLE ONLY public.wes_event_log FORCE ROW LEVEL SECURITY;


--
-- Name: wes_event_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wes_event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wes_event_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wes_event_log_id_seq OWNED BY public.wes_event_log.id;


--
-- Name: wes_failover_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wes_failover_incidents (
    id bigint NOT NULL,
    company_id integer DEFAULT (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer NOT NULL,
    equipment_id integer,
    command_id bigint,
    incident_type character varying(30) NOT NULL,
    severity character varying(20) DEFAULT 'HIGH'::character varying NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    reason text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    resolved_by integer,
    resolution_notes text,
    CONSTRAINT ck_wes_incident_severity CHECK (((severity)::text = ANY ((ARRAY['LOW'::character varying, 'MEDIUM'::character varying, 'HIGH'::character varying, 'CRITICAL'::character varying])::text[]))),
    CONSTRAINT ck_wes_incident_status CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'ACKNOWLEDGED'::character varying, 'RESOLVED'::character varying, 'CLOSED'::character varying])::text[]))),
    CONSTRAINT ck_wes_incident_type CHECK (((incident_type)::text = ANY ((ARRAY['COMMAND_RETRY_EXHAUSTED'::character varying, 'HEARTBEAT_TIMEOUT'::character varying, 'SAFETY_TRIP'::character varying, 'STATE_MACHINE_GUARD'::character varying, 'ADAPTER_FAILURE'::character varying])::text[])))
);

ALTER TABLE ONLY public.wes_failover_incidents FORCE ROW LEVEL SECURITY;


--
-- Name: wes_failover_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wes_failover_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wes_failover_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wes_failover_incidents_id_seq OWNED BY public.wes_failover_incidents.id;


--
-- Name: workforce_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workforce_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workforce_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workforce_tasks_id_seq OWNED BY public.workforce_tasks.id;


--
-- Name: api_idempotency_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency_keys ALTER COLUMN id SET DEFAULT nextval('public.api_idempotency_keys_id_seq'::regclass);


--
-- Name: asn_carton_details id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details ALTER COLUMN id SET DEFAULT nextval('public.asn_carton_details_id_seq'::regclass);


--
-- Name: asn_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header ALTER COLUMN id SET DEFAULT nextval('public.asn_header_id_seq'::regclass);


--
-- Name: asn_line_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items ALTER COLUMN id SET DEFAULT nextval('public.asn_line_items_id_seq'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: billing_job_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_job_runs ALTER COLUMN id SET DEFAULT nextval('public.billing_job_runs_id_seq'::regclass);


--
-- Name: billing_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions ALTER COLUMN id SET DEFAULT nextval('public.billing_transactions_id_seq'::regclass);


--
-- Name: chart_of_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts ALTER COLUMN id SET DEFAULT nextval('public.chart_of_accounts_id_seq'::regclass);


--
-- Name: client_billing_profile id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile ALTER COLUMN id SET DEFAULT nextval('public.client_billing_profile_id_seq'::regclass);


--
-- Name: client_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts ALTER COLUMN id SET DEFAULT nextval('public.client_contacts_id_seq'::regclass);


--
-- Name: client_contracts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts ALTER COLUMN id SET DEFAULT nextval('public.client_contracts_id_seq'::regclass);


--
-- Name: client_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_documents ALTER COLUMN id SET DEFAULT nextval('public.client_documents_id_seq'::regclass);


--
-- Name: client_portal_asn_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests ALTER COLUMN id SET DEFAULT nextval('public.client_portal_asn_requests_id_seq'::regclass);


--
-- Name: client_rate_details id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details ALTER COLUMN id SET DEFAULT nextval('public.client_rate_details_id_seq'::regclass);


--
-- Name: client_rate_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master ALTER COLUMN id SET DEFAULT nextval('public.client_rate_master_id_seq'::regclass);


--
-- Name: clients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients ALTER COLUMN id SET DEFAULT nextval('public.clients_id_seq'::regclass);


--
-- Name: companies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies ALTER COLUMN id SET DEFAULT nextval('public.companies_id_seq'::regclass);


--
-- Name: credit_note_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header ALTER COLUMN id SET DEFAULT nextval('public.credit_note_header_id_seq'::regclass);


--
-- Name: credit_note_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines ALTER COLUMN id SET DEFAULT nextval('public.credit_note_lines_id_seq'::regclass);


--
-- Name: customer_label_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates ALTER COLUMN id SET DEFAULT nextval('public.customer_label_templates_id_seq'::regclass);


--
-- Name: cycle_count_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans ALTER COLUMN id SET DEFAULT nextval('public.cycle_count_plans_id_seq'::regclass);


--
-- Name: daily_kpi_summary id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary ALTER COLUMN id SET DEFAULT nextval('public.daily_kpi_summary_id_seq'::regclass);


--
-- Name: debit_note_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header ALTER COLUMN id SET DEFAULT nextval('public.debit_note_header_id_seq'::regclass);


--
-- Name: debit_note_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines ALTER COLUMN id SET DEFAULT nextval('public.debit_note_lines_id_seq'::regclass);


--
-- Name: delivery_note_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header ALTER COLUMN id SET DEFAULT nextval('public.delivery_note_header_id_seq'::regclass);


--
-- Name: delivery_note_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines ALTER COLUMN id SET DEFAULT nextval('public.delivery_note_lines_id_seq'::regclass);


--
-- Name: do_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header ALTER COLUMN id SET DEFAULT nextval('public.do_header_id_seq'::regclass);


--
-- Name: do_line_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items ALTER COLUMN id SET DEFAULT nextval('public.do_line_items_id_seq'::regclass);


--
-- Name: do_pack_unit_serials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials ALTER COLUMN id SET DEFAULT nextval('public.do_pack_unit_serials_id_seq'::regclass);


--
-- Name: do_pack_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units ALTER COLUMN id SET DEFAULT nextval('public.do_pack_units_id_seq'::regclass);


--
-- Name: do_pick_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks ALTER COLUMN id SET DEFAULT nextval('public.do_pick_tasks_id_seq'::regclass);


--
-- Name: do_wave_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header ALTER COLUMN id SET DEFAULT nextval('public.do_wave_header_id_seq'::regclass);


--
-- Name: do_wave_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders ALTER COLUMN id SET DEFAULT nextval('public.do_wave_orders_id_seq'::regclass);


--
-- Name: edi_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edi_transactions ALTER COLUMN id SET DEFAULT nextval('public.edi_transactions_id_seq'::regclass);


--
-- Name: ff_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents ALTER COLUMN id SET DEFAULT nextval('public.ff_documents_id_seq'::regclass);


--
-- Name: ff_milestones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_milestones ALTER COLUMN id SET DEFAULT nextval('public.ff_milestones_id_seq'::regclass);


--
-- Name: ff_shipment_legs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipment_legs ALTER COLUMN id SET DEFAULT nextval('public.ff_shipment_legs_id_seq'::regclass);


--
-- Name: ff_shipments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments ALTER COLUMN id SET DEFAULT nextval('public.ff_shipments_id_seq'::regclass);


--
-- Name: gate_in id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in ALTER COLUMN id SET DEFAULT nextval('public.gate_in_id_seq'::regclass);


--
-- Name: gate_out id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out ALTER COLUMN id SET DEFAULT nextval('public.gate_out_id_seq'::regclass);


--
-- Name: goods_issue_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header ALTER COLUMN id SET DEFAULT nextval('public.goods_issue_header_id_seq'::regclass);


--
-- Name: goods_issue_pack_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units ALTER COLUMN id SET DEFAULT nextval('public.goods_issue_pack_units_id_seq'::regclass);


--
-- Name: grn_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header ALTER COLUMN id SET DEFAULT nextval('public.grn_header_id_seq'::regclass);


--
-- Name: grn_line_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items ALTER COLUMN id SET DEFAULT nextval('public.grn_line_items_id_seq'::regclass);


--
-- Name: integration_connector_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials ALTER COLUMN id SET DEFAULT nextval('public.integration_connector_credentials_id_seq'::regclass);


--
-- Name: integration_connectors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors ALTER COLUMN id SET DEFAULT nextval('public.integration_connectors_id_seq'::regclass);


--
-- Name: integration_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_events ALTER COLUMN id SET DEFAULT nextval('public.integration_events_id_seq'::regclass);


--
-- Name: integration_mapping_fields id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_mapping_fields ALTER COLUMN id SET DEFAULT nextval('public.integration_mapping_fields_id_seq'::regclass);


--
-- Name: integration_schema_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings ALTER COLUMN id SET DEFAULT nextval('public.integration_schema_mappings_id_seq'::regclass);


--
-- Name: invoice_header id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header ALTER COLUMN id SET DEFAULT nextval('public.invoice_header_id_seq'::regclass);


--
-- Name: invoice_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines ALTER COLUMN id SET DEFAULT nextval('public.invoice_lines_id_seq'::regclass);


--
-- Name: invoice_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments ALTER COLUMN id SET DEFAULT nextval('public.invoice_payments_id_seq'::regclass);


--
-- Name: invoice_tax_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_tax_lines ALTER COLUMN id SET DEFAULT nextval('public.invoice_tax_lines_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: item_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_categories ALTER COLUMN id SET DEFAULT nextval('public.item_categories_id_seq'::regclass);


--
-- Name: items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items ALTER COLUMN id SET DEFAULT nextval('public.items_id_seq'::regclass);


--
-- Name: journal_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries ALTER COLUMN id SET DEFAULT nextval('public.journal_entries_id_seq'::regclass);


--
-- Name: journal_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines ALTER COLUMN id SET DEFAULT nextval('public.journal_lines_id_seq'::regclass);


--
-- Name: labor_productivity_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events ALTER COLUMN id SET DEFAULT nextval('public.labor_productivity_events_id_seq'::regclass);


--
-- Name: labor_shift_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments ALTER COLUMN id SET DEFAULT nextval('public.labor_shift_assignments_id_seq'::regclass);


--
-- Name: labor_shifts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts ALTER COLUMN id SET DEFAULT nextval('public.labor_shifts_id_seq'::regclass);


--
-- Name: labor_standards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards ALTER COLUMN id SET DEFAULT nextval('public.labor_standards_id_seq'::regclass);


--
-- Name: mobile_grn_captures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures ALTER COLUMN id SET DEFAULT nextval('public.mobile_grn_captures_id_seq'::regclass);


--
-- Name: mobile_sync_task_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_sync_task_queue ALTER COLUMN id SET DEFAULT nextval('public.mobile_sync_task_queue_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: outbound_load_pack_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units ALTER COLUMN id SET DEFAULT nextval('public.outbound_load_pack_units_id_seq'::regclass);


--
-- Name: outbound_loads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads ALTER COLUMN id SET DEFAULT nextval('public.outbound_loads_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);


--
-- Name: portal_client_sla_policies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies ALTER COLUMN id SET DEFAULT nextval('public.portal_client_sla_policies_id_seq'::regclass);


--
-- Name: portal_invoice_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions ALTER COLUMN id SET DEFAULT nextval('public.portal_invoice_actions_id_seq'::regclass);


--
-- Name: portal_invoice_dispute_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_dispute_events ALTER COLUMN id SET DEFAULT nextval('public.portal_invoice_dispute_events_id_seq'::regclass);


--
-- Name: portal_invoice_disputes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes ALTER COLUMN id SET DEFAULT nextval('public.portal_invoice_disputes_id_seq'::regclass);


--
-- Name: portal_user_clients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients ALTER COLUMN id SET DEFAULT nextval('public.portal_user_clients_id_seq'::regclass);


--
-- Name: portal_user_invites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites ALTER COLUMN id SET DEFAULT nextval('public.portal_user_invites_id_seq'::regclass);


--
-- Name: portal_user_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_permissions ALTER COLUMN id SET DEFAULT nextval('public.portal_user_permissions_id_seq'::regclass);


--
-- Name: printed_labels_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log ALTER COLUMN id SET DEFAULT nextval('public.printed_labels_log_id_seq'::regclass);


--
-- Name: rbac_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permissions ALTER COLUMN id SET DEFAULT nextval('public.rbac_permissions_id_seq'::regclass);


--
-- Name: rbac_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_roles ALTER COLUMN id SET DEFAULT nextval('public.rbac_roles_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);


--
-- Name: sequence_counters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_counters ALTER COLUMN id SET DEFAULT nextval('public.sequence_counters_id_seq'::regclass);


--
-- Name: stock_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements ALTER COLUMN id SET DEFAULT nextval('public.stock_movements_id_seq'::regclass);


--
-- Name: stock_putaway_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements ALTER COLUMN id SET DEFAULT nextval('public.stock_putaway_movements_id_seq'::regclass);


--
-- Name: stock_serial_numbers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers ALTER COLUMN id SET DEFAULT nextval('public.stock_serial_numbers_id_seq'::regclass);


--
-- Name: storage_snapshot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot ALTER COLUMN id SET DEFAULT nextval('public.storage_snapshot_id_seq'::regclass);


--
-- Name: system_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);


--
-- Name: tenant_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products ALTER COLUMN id SET DEFAULT nextval('public.tenant_products_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: warehouse_zone_layouts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zone_layouts ALTER COLUMN id SET DEFAULT nextval('public.warehouse_zone_layouts_id_seq'::regclass);


--
-- Name: warehouse_zones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zones ALTER COLUMN id SET DEFAULT nextval('public.warehouse_zones_id_seq'::regclass);


--
-- Name: warehouses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses ALTER COLUMN id SET DEFAULT nextval('public.warehouses_id_seq'::regclass);


--
-- Name: wes_command_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_command_queue ALTER COLUMN id SET DEFAULT nextval('public.wes_command_queue_id_seq'::regclass);


--
-- Name: wes_equipment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment ALTER COLUMN id SET DEFAULT nextval('public.wes_equipment_id_seq'::regclass);


--
-- Name: wes_event_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_event_log ALTER COLUMN id SET DEFAULT nextval('public.wes_event_log_id_seq'::regclass);


--
-- Name: wes_failover_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents ALTER COLUMN id SET DEFAULT nextval('public.wes_failover_incidents_id_seq'::regclass);


--
-- Name: workforce_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_tasks ALTER COLUMN id SET DEFAULT nextval('public.workforce_tasks_id_seq'::regclass);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: api_idempotency_keys api_idempotency_keys_company_id_key_hash_route_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency_keys
    ADD CONSTRAINT api_idempotency_keys_company_id_key_hash_route_key_key UNIQUE (company_id, key_hash, route_key);


--
-- Name: api_idempotency_keys api_idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency_keys
    ADD CONSTRAINT api_idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: asn_carton_details asn_carton_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_pkey PRIMARY KEY (id);


--
-- Name: asn_carton_details asn_carton_details_sscc_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_sscc_key UNIQUE (sscc);


--
-- Name: asn_header asn_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_pkey PRIMARY KEY (id);


--
-- Name: asn_line_items asn_line_items_asn_header_id_line_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_asn_header_id_line_number_key UNIQUE (asn_header_id, line_number);


--
-- Name: asn_line_items asn_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: billing_invoice_seq billing_invoice_seq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoice_seq
    ADD CONSTRAINT billing_invoice_seq_pkey PRIMARY KEY (company_id);


--
-- Name: billing_job_runs billing_job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_job_runs
    ADD CONSTRAINT billing_job_runs_pkey PRIMARY KEY (id);


--
-- Name: billing_transactions billing_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_pkey PRIMARY KEY (id);


--
-- Name: chart_of_accounts chart_of_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_pkey PRIMARY KEY (id);


--
-- Name: client_billing_profile client_billing_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT client_billing_profile_pkey PRIMARY KEY (id);


--
-- Name: client_contacts client_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts
    ADD CONSTRAINT client_contacts_pkey PRIMARY KEY (id);


--
-- Name: client_contracts client_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT client_contracts_pkey PRIMARY KEY (id);


--
-- Name: client_documents client_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_documents
    ADD CONSTRAINT client_documents_pkey PRIMARY KEY (id);


--
-- Name: client_portal_asn_requests client_portal_asn_requests_company_id_request_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests
    ADD CONSTRAINT client_portal_asn_requests_company_id_request_number_key UNIQUE (company_id, request_number);


--
-- Name: client_portal_asn_requests client_portal_asn_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests
    ADD CONSTRAINT client_portal_asn_requests_pkey PRIMARY KEY (id);


--
-- Name: client_rate_details client_rate_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_pkey PRIMARY KEY (id);


--
-- Name: client_rate_master client_rate_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT client_rate_master_pkey PRIMARY KEY (id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: companies companies_company_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_company_code_key UNIQUE (company_code);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: credit_note_header credit_note_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT credit_note_header_pkey PRIMARY KEY (id);


--
-- Name: credit_note_lines credit_note_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines
    ADD CONSTRAINT credit_note_lines_pkey PRIMARY KEY (id);


--
-- Name: customer_label_templates customer_label_templates_client_id_template_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates
    ADD CONSTRAINT customer_label_templates_client_id_template_code_key UNIQUE (client_id, template_code);


--
-- Name: customer_label_templates customer_label_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates
    ADD CONSTRAINT customer_label_templates_pkey PRIMARY KEY (id);


--
-- Name: cycle_count_plans cycle_count_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_pkey PRIMARY KEY (id);


--
-- Name: daily_kpi_summary daily_kpi_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary
    ADD CONSTRAINT daily_kpi_summary_pkey PRIMARY KEY (id);


--
-- Name: daily_kpi_summary daily_kpi_summary_warehouse_id_user_id_kpi_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary
    ADD CONSTRAINT daily_kpi_summary_warehouse_id_user_id_kpi_date_key UNIQUE (warehouse_id, user_id, kpi_date);


--
-- Name: debit_note_header debit_note_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT debit_note_header_pkey PRIMARY KEY (id);


--
-- Name: debit_note_lines debit_note_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines
    ADD CONSTRAINT debit_note_lines_pkey PRIMARY KEY (id);


--
-- Name: delivery_note_header delivery_note_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_pkey PRIMARY KEY (id);


--
-- Name: delivery_note_lines delivery_note_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines
    ADD CONSTRAINT delivery_note_lines_pkey PRIMARY KEY (id);


--
-- Name: do_header do_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_pkey PRIMARY KEY (id);


--
-- Name: do_line_items do_line_items_do_header_id_line_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items
    ADD CONSTRAINT do_line_items_do_header_id_line_number_key UNIQUE (do_header_id, line_number);


--
-- Name: do_line_items do_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items
    ADD CONSTRAINT do_line_items_pkey PRIMARY KEY (id);


--
-- Name: do_pack_unit_serials do_pack_unit_serials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_pkey PRIMARY KEY (id);


--
-- Name: do_pack_units do_pack_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_pkey PRIMARY KEY (id);


--
-- Name: do_pick_tasks do_pick_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_pkey PRIMARY KEY (id);


--
-- Name: do_wave_header do_wave_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_pkey PRIMARY KEY (id);


--
-- Name: do_wave_orders do_wave_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders
    ADD CONSTRAINT do_wave_orders_pkey PRIMARY KEY (id);


--
-- Name: edi_transactions edi_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edi_transactions
    ADD CONSTRAINT edi_transactions_pkey PRIMARY KEY (id);


--
-- Name: ff_documents ff_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents
    ADD CONSTRAINT ff_documents_pkey PRIMARY KEY (id);


--
-- Name: ff_milestones ff_milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_milestones
    ADD CONSTRAINT ff_milestones_pkey PRIMARY KEY (id);


--
-- Name: ff_shipment_legs ff_shipment_legs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipment_legs
    ADD CONSTRAINT ff_shipment_legs_pkey PRIMARY KEY (id);


--
-- Name: ff_shipments ff_shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT ff_shipments_pkey PRIMARY KEY (id);


--
-- Name: gate_in gate_in_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_pkey PRIMARY KEY (id);


--
-- Name: gate_out gate_out_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_pkey PRIMARY KEY (id);


--
-- Name: goods_issue_header goods_issue_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_pkey PRIMARY KEY (id);


--
-- Name: goods_issue_pack_units goods_issue_pack_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units
    ADD CONSTRAINT goods_issue_pack_units_pkey PRIMARY KEY (id);


--
-- Name: grn_header grn_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_pkey PRIMARY KEY (id);


--
-- Name: grn_line_items grn_line_items_grn_header_id_line_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_grn_header_id_line_number_key UNIQUE (grn_header_id, line_number);


--
-- Name: grn_line_items grn_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_pkey PRIMARY KEY (id);


--
-- Name: integration_connector_credentials integration_connector_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT integration_connector_credentials_pkey PRIMARY KEY (id);


--
-- Name: integration_connectors integration_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors
    ADD CONSTRAINT integration_connectors_pkey PRIMARY KEY (id);


--
-- Name: integration_events integration_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_events
    ADD CONSTRAINT integration_events_pkey PRIMARY KEY (id);


--
-- Name: integration_mapping_fields integration_mapping_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_mapping_fields
    ADD CONSTRAINT integration_mapping_fields_pkey PRIMARY KEY (id);


--
-- Name: integration_schema_mappings integration_schema_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT integration_schema_mappings_pkey PRIMARY KEY (id);


--
-- Name: invoice_header invoice_header_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_pkey PRIMARY KEY (id);


--
-- Name: invoice_lines invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: invoice_payments invoice_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_pkey PRIMARY KEY (id);


--
-- Name: invoice_tax_lines invoice_tax_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_tax_lines
    ADD CONSTRAINT invoice_tax_lines_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: item_categories item_categories_category_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_categories
    ADD CONSTRAINT item_categories_category_code_key UNIQUE (category_code);


--
-- Name: item_categories item_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_categories
    ADD CONSTRAINT item_categories_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_lines journal_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_pkey PRIMARY KEY (id);


--
-- Name: labor_productivity_events labor_productivity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_pkey PRIMARY KEY (id);


--
-- Name: labor_shift_assignments labor_shift_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT labor_shift_assignments_pkey PRIMARY KEY (id);


--
-- Name: labor_shifts labor_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT labor_shifts_pkey PRIMARY KEY (id);


--
-- Name: labor_standards labor_standards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards
    ADD CONSTRAINT labor_standards_pkey PRIMARY KEY (id);


--
-- Name: mobile_approval_requests mobile_approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_approval_requests
    ADD CONSTRAINT mobile_approval_requests_pkey PRIMARY KEY (id);


--
-- Name: mobile_auth_sessions mobile_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_auth_sessions
    ADD CONSTRAINT mobile_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: mobile_cycle_count_submissions mobile_cycle_count_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_cycle_count_submissions
    ADD CONSTRAINT mobile_cycle_count_submissions_pkey PRIMARY KEY (id);


--
-- Name: mobile_cycle_count_tasks mobile_cycle_count_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_cycle_count_tasks
    ADD CONSTRAINT mobile_cycle_count_tasks_pkey PRIMARY KEY (id);


--
-- Name: mobile_dock_appointments mobile_dock_appointments_company_id_warehouse_id_appointmen_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_dock_appointments
    ADD CONSTRAINT mobile_dock_appointments_company_id_warehouse_id_appointmen_key UNIQUE (company_id, warehouse_id, appointment_no);


--
-- Name: mobile_dock_appointments mobile_dock_appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_dock_appointments
    ADD CONSTRAINT mobile_dock_appointments_pkey PRIMARY KEY (id);


--
-- Name: mobile_dock_checkins mobile_dock_checkins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_dock_checkins
    ADD CONSTRAINT mobile_dock_checkins_pkey PRIMARY KEY (id);


--
-- Name: mobile_dock_slots mobile_dock_slots_company_id_warehouse_id_slot_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_dock_slots
    ADD CONSTRAINT mobile_dock_slots_company_id_warehouse_id_slot_code_key UNIQUE (company_id, warehouse_id, slot_code);


--
-- Name: mobile_dock_slots mobile_dock_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_dock_slots
    ADD CONSTRAINT mobile_dock_slots_pkey PRIMARY KEY (id);


--
-- Name: mobile_grn_captures mobile_grn_captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures
    ADD CONSTRAINT mobile_grn_captures_pkey PRIMARY KEY (id);


--
-- Name: mobile_inbound_receiving_tasks mobile_inbound_receiving_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_inbound_receiving_tasks
    ADD CONSTRAINT mobile_inbound_receiving_tasks_pkey PRIMARY KEY (id);


--
-- Name: mobile_lp_nested mobile_lp_nested_lp_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_lp_nested
    ADD CONSTRAINT mobile_lp_nested_lp_code_key UNIQUE (lp_code);


--
-- Name: mobile_lp_nested mobile_lp_nested_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_lp_nested
    ADD CONSTRAINT mobile_lp_nested_pkey PRIMARY KEY (id);


--
-- Name: mobile_lp_records mobile_lp_records_lp_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_lp_records
    ADD CONSTRAINT mobile_lp_records_lp_code_key UNIQUE (lp_code);


--
-- Name: mobile_lp_records mobile_lp_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_lp_records
    ADD CONSTRAINT mobile_lp_records_pkey PRIMARY KEY (id);


--
-- Name: mobile_outbound_shipments mobile_outbound_shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_outbound_shipments
    ADD CONSTRAINT mobile_outbound_shipments_pkey PRIMARY KEY (id);


--
-- Name: mobile_packing_confirmations mobile_packing_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_packing_confirmations
    ADD CONSTRAINT mobile_packing_confirmations_pkey PRIMARY KEY (id);


--
-- Name: mobile_packing_lines mobile_packing_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_packing_lines
    ADD CONSTRAINT mobile_packing_lines_pkey PRIMARY KEY (id);


--
-- Name: mobile_print_queue mobile_print_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_print_queue
    ADD CONSTRAINT mobile_print_queue_pkey PRIMARY KEY (id);


--
-- Name: mobile_qc_holds mobile_qc_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_qc_holds
    ADD CONSTRAINT mobile_qc_holds_pkey PRIMARY KEY (id);


--
-- Name: mobile_qc_results mobile_qc_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_qc_results
    ADD CONSTRAINT mobile_qc_results_pkey PRIMARY KEY (id);


--
-- Name: mobile_returns_dispositions mobile_returns_dispositions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_dispositions
    ADD CONSTRAINT mobile_returns_dispositions_pkey PRIMARY KEY (id);


--
-- Name: mobile_returns_headers mobile_returns_headers_company_id_warehouse_id_client_id_rm_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_headers
    ADD CONSTRAINT mobile_returns_headers_company_id_warehouse_id_client_id_rm_key UNIQUE (company_id, warehouse_id, client_id, rma_id);


--
-- Name: mobile_returns_headers mobile_returns_headers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_headers
    ADD CONSTRAINT mobile_returns_headers_pkey PRIMARY KEY (id);


--
-- Name: mobile_returns_lines mobile_returns_lines_header_id_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_lines
    ADD CONSTRAINT mobile_returns_lines_header_id_line_id_key UNIQUE (header_id, line_id);


--
-- Name: mobile_returns_lines mobile_returns_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_lines
    ADD CONSTRAINT mobile_returns_lines_pkey PRIMARY KEY (id);


--
-- Name: mobile_returns_putaway_tasks mobile_returns_putaway_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_putaway_tasks
    ADD CONSTRAINT mobile_returns_putaway_tasks_pkey PRIMARY KEY (id);


--
-- Name: mobile_returns_receipts mobile_returns_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_receipts
    ADD CONSTRAINT mobile_returns_receipts_pkey PRIMARY KEY (id);


--
-- Name: mobile_sync_task_queue mobile_sync_task_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_sync_task_queue
    ADD CONSTRAINT mobile_sync_task_queue_pkey PRIMARY KEY (id);


--
-- Name: mobile_task_cancellation_logs mobile_task_cancellation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_task_cancellation_logs
    ADD CONSTRAINT mobile_task_cancellation_logs_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: outbound_load_pack_units outbound_load_pack_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units
    ADD CONSTRAINT outbound_load_pack_units_pkey PRIMARY KEY (id);


--
-- Name: outbound_loads outbound_loads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: portal_client_sla_policies portal_client_sla_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT portal_client_sla_policies_pkey PRIMARY KEY (id);


--
-- Name: portal_invoice_actions portal_invoice_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions
    ADD CONSTRAINT portal_invoice_actions_pkey PRIMARY KEY (id);


--
-- Name: portal_invoice_dispute_events portal_invoice_dispute_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_dispute_events
    ADD CONSTRAINT portal_invoice_dispute_events_pkey PRIMARY KEY (id);


--
-- Name: portal_invoice_disputes portal_invoice_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_pkey PRIMARY KEY (id);


--
-- Name: portal_user_clients portal_user_clients_company_id_user_id_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients
    ADD CONSTRAINT portal_user_clients_company_id_user_id_client_id_key UNIQUE (company_id, user_id, client_id);


--
-- Name: portal_user_clients portal_user_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients
    ADD CONSTRAINT portal_user_clients_pkey PRIMARY KEY (id);


--
-- Name: portal_user_invites portal_user_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites
    ADD CONSTRAINT portal_user_invites_pkey PRIMARY KEY (id);


--
-- Name: portal_user_permissions portal_user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_permissions
    ADD CONSTRAINT portal_user_permissions_pkey PRIMARY KEY (id);


--
-- Name: printed_labels_log printed_labels_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log
    ADD CONSTRAINT printed_labels_log_pkey PRIMARY KEY (id);


--
-- Name: rbac_permissions rbac_permissions_permission_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permissions
    ADD CONSTRAINT rbac_permissions_permission_key_key UNIQUE (permission_key);


--
-- Name: rbac_permissions rbac_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permissions
    ADD CONSTRAINT rbac_permissions_pkey PRIMARY KEY (id);


--
-- Name: rbac_role_permissions rbac_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permissions
    ADD CONSTRAINT rbac_role_permissions_pkey PRIMARY KEY (role_id, permission_id);


--
-- Name: rbac_roles rbac_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_roles
    ADD CONSTRAINT rbac_roles_pkey PRIMARY KEY (id);


--
-- Name: rbac_roles rbac_roles_role_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_roles
    ADD CONSTRAINT rbac_roles_role_code_key UNIQUE (role_code);


--
-- Name: rbac_user_roles rbac_user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_user_roles
    ADD CONSTRAINT rbac_user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: sequence_counters sequence_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_counters
    ADD CONSTRAINT sequence_counters_pkey PRIMARY KEY (id);


--
-- Name: sequence_counters sequence_counters_sequence_name_year_warehouse_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_counters
    ADD CONSTRAINT sequence_counters_sequence_name_year_warehouse_id_key UNIQUE (sequence_name, year, warehouse_id);


--
-- Name: stock_movements stock_movements_movement_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_movement_number_key UNIQUE (movement_number);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: stock_putaway_movements stock_putaway_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_pkey PRIMARY KEY (id);


--
-- Name: stock_serial_numbers stock_serial_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_pkey PRIMARY KEY (id);


--
-- Name: stock_serial_numbers stock_serial_numbers_serial_number_item_id_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_serial_number_item_id_client_id_key UNIQUE (serial_number, item_id, client_id);


--
-- Name: storage_snapshot storage_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot
    ADD CONSTRAINT storage_snapshot_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_setting_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_setting_key_key UNIQUE (setting_key);


--
-- Name: tenant_products tenant_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products
    ADD CONSTRAINT tenant_products_pkey PRIMARY KEY (id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (company_id);


--
-- Name: billing_job_runs uq_bjr_company_job_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_job_runs
    ADD CONSTRAINT uq_bjr_company_job_key UNIQUE (company_id, job_type, run_key);


--
-- Name: cycle_count_plans uq_ccp_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT uq_ccp_company_number UNIQUE (company_id, plan_number);


--
-- Name: client_billing_profile uq_client_billing_profile_company_client; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT uq_client_billing_profile_company_client UNIQUE (company_id, client_id);


--
-- Name: client_contracts uq_client_contracts_company_contract_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT uq_client_contracts_company_contract_code UNIQUE (company_id, contract_code);


--
-- Name: credit_note_header uq_cnh_company_note_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT uq_cnh_company_note_number UNIQUE (company_id, note_number);


--
-- Name: credit_note_lines uq_cnl_note_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines
    ADD CONSTRAINT uq_cnl_note_line UNIQUE (credit_note_id, line_no);


--
-- Name: client_rate_master uq_crm_company_client_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT uq_crm_company_client_code UNIQUE (company_id, client_id, rate_card_code);


--
-- Name: delivery_note_header uq_dn_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT uq_dn_company_number UNIQUE (company_id, delivery_note_number);


--
-- Name: delivery_note_header uq_dn_load; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT uq_dn_load UNIQUE (company_id, load_id);


--
-- Name: debit_note_header uq_dnh_company_note_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT uq_dnh_company_note_number UNIQUE (company_id, note_number);


--
-- Name: debit_note_lines uq_dnl_note_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines
    ADD CONSTRAINT uq_dnl_note_line UNIQUE (debit_note_id, line_no);


--
-- Name: do_pick_tasks uq_do_pick_task_wave_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT uq_do_pick_task_wave_line UNIQUE (wave_id, do_line_item_id);


--
-- Name: do_wave_header uq_do_wave_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT uq_do_wave_company_number UNIQUE (company_id, wave_number);


--
-- Name: do_wave_orders uq_do_wave_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders
    ADD CONSTRAINT uq_do_wave_order UNIQUE (wave_id, do_header_id);


--
-- Name: ff_documents uq_ff_documents_company_shipment_doc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents
    ADD CONSTRAINT uq_ff_documents_company_shipment_doc UNIQUE (company_id, shipment_id, doc_type, doc_no);


--
-- Name: ff_shipment_legs uq_ff_shipment_legs_company_shipment_leg; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipment_legs
    ADD CONSTRAINT uq_ff_shipment_legs_company_shipment_leg UNIQUE (company_id, shipment_id, leg_no);


--
-- Name: ff_shipments uq_ff_shipments_company_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT uq_ff_shipments_company_no UNIQUE (company_id, shipment_no);


--
-- Name: goods_issue_header uq_gi_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT uq_gi_company_number UNIQUE (company_id, gi_number);


--
-- Name: goods_issue_pack_units uq_gi_pack_unit; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units
    ADD CONSTRAINT uq_gi_pack_unit UNIQUE (company_id, pack_unit_id);


--
-- Name: integration_connectors uq_integration_connector_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors
    ADD CONSTRAINT uq_integration_connector_company_code UNIQUE (company_id, connector_code);


--
-- Name: integration_connector_credentials uq_integration_credential_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT uq_integration_credential_key UNIQUE (company_id, connector_id, credential_key);


--
-- Name: integration_mapping_fields uq_integration_mapping_field; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_mapping_fields
    ADD CONSTRAINT uq_integration_mapping_field UNIQUE (mapping_id, source_path, target_path);


--
-- Name: integration_schema_mappings uq_integration_mapping_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT uq_integration_mapping_version UNIQUE (company_id, connector_id, entity_type, direction, mapping_version);


--
-- Name: invoice_header uq_invoice_header_company_client_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT uq_invoice_header_company_client_period UNIQUE (company_id, client_id, period_from, period_to);


--
-- Name: invoice_header uq_invoice_header_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT uq_invoice_header_company_number UNIQUE (company_id, invoice_number);


--
-- Name: invoice_lines uq_invoice_lines_invoice_line_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT uq_invoice_lines_invoice_line_no UNIQUE (invoice_id, line_no);


--
-- Name: labor_shift_assignments uq_labor_shift_assignment; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT uq_labor_shift_assignment UNIQUE (company_id, shift_id, shift_date, user_id);


--
-- Name: labor_shifts uq_labor_shift_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT uq_labor_shift_company_code UNIQUE (company_id, shift_code);


--
-- Name: labor_standards uq_labor_standard_company_operation; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards
    ADD CONSTRAINT uq_labor_standard_company_operation UNIQUE (company_id, operation_code);


--
-- Name: outbound_loads uq_load_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT uq_load_company_number UNIQUE (company_id, load_number);


--
-- Name: outbound_load_pack_units uq_load_pack_unit; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units
    ADD CONSTRAINT uq_load_pack_unit UNIQUE (company_id, pack_unit_id);


--
-- Name: do_pack_units uq_pack_unit_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT uq_pack_unit_company_code UNIQUE (company_id, pack_code);


--
-- Name: do_pack_unit_serials uq_pack_unit_serial; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT uq_pack_unit_serial UNIQUE (company_id, serial_id);


--
-- Name: portal_invoice_disputes uq_portal_dispute_company_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT uq_portal_dispute_company_number UNIQUE (company_id, dispute_number);


--
-- Name: portal_client_sla_policies uq_portal_sla_company_client; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT uq_portal_sla_company_client UNIQUE (company_id, client_id);


--
-- Name: portal_user_invites uq_portal_user_invites_company_token; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites
    ADD CONSTRAINT uq_portal_user_invites_company_token UNIQUE (company_id, invite_token);


--
-- Name: portal_user_permissions uq_portal_user_permissions_company_user_feature; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_permissions
    ADD CONSTRAINT uq_portal_user_permissions_company_user_feature UNIQUE (company_id, user_id, feature_key);


--
-- Name: tenant_products uq_tenant_products_company_product; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products
    ADD CONSTRAINT uq_tenant_products_company_product UNIQUE (company_id, product_code);


--
-- Name: wes_equipment uq_wes_equipment_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT uq_wes_equipment_company_code UNIQUE (company_id, equipment_code);


--
-- Name: user_scopes user_scopes_company_id_user_id_scope_type_scope_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_company_id_user_id_scope_type_scope_id_key UNIQUE (company_id, user_id, scope_type, scope_id);


--
-- Name: user_scopes user_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: warehouse_zone_layouts warehouse_zone_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zone_layouts
    ADD CONSTRAINT warehouse_zone_layouts_pkey PRIMARY KEY (id);


--
-- Name: warehouse_zones warehouse_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zones
    ADD CONSTRAINT warehouse_zones_pkey PRIMARY KEY (id);


--
-- Name: warehouse_zones warehouse_zones_warehouse_id_zone_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zones
    ADD CONSTRAINT warehouse_zones_warehouse_id_zone_code_key UNIQUE (warehouse_id, zone_code);


--
-- Name: warehouses warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);


--
-- Name: wes_command_queue wes_command_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_command_queue
    ADD CONSTRAINT wes_command_queue_pkey PRIMARY KEY (id);


--
-- Name: wes_equipment wes_equipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_pkey PRIMARY KEY (id);


--
-- Name: wes_event_log wes_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_event_log
    ADD CONSTRAINT wes_event_log_pkey PRIMARY KEY (id);


--
-- Name: wes_failover_incidents wes_failover_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents
    ADD CONSTRAINT wes_failover_incidents_pkey PRIMARY KEY (id);


--
-- Name: workforce_tasks workforce_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_tasks
    ADD CONSTRAINT workforce_tasks_pkey PRIMARY KEY (id);


--
-- Name: idx_asn_carton_asn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_carton_asn ON public.asn_carton_details USING btree (asn_header_id);


--
-- Name: idx_asn_carton_details_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_carton_details_company_id ON public.asn_carton_details USING btree (company_id);


--
-- Name: idx_asn_carton_pallet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_carton_pallet ON public.asn_carton_details USING btree (pallet_sscc);


--
-- Name: idx_asn_carton_sscc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_carton_sscc ON public.asn_carton_details USING btree (sscc);


--
-- Name: idx_asn_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_client ON public.asn_header USING btree (client_id);


--
-- Name: idx_asn_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_do ON public.asn_header USING btree (do_header_id);


--
-- Name: idx_asn_header_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_header_company_id ON public.asn_header USING btree (company_id);


--
-- Name: idx_asn_line_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_line_do ON public.asn_line_items USING btree (do_line_item_id);


--
-- Name: idx_asn_line_header; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_line_header ON public.asn_line_items USING btree (asn_header_id);


--
-- Name: idx_asn_line_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_line_item ON public.asn_line_items USING btree (item_id);


--
-- Name: idx_asn_line_items_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_line_items_company_id ON public.asn_line_items USING btree (company_id);


--
-- Name: idx_asn_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_number ON public.asn_header USING btree (asn_number);


--
-- Name: idx_asn_ship_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_ship_date ON public.asn_header USING btree (actual_ship_date);


--
-- Name: idx_asn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_status ON public.asn_header USING btree (status);


--
-- Name: idx_asn_tracking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_tracking ON public.asn_header USING btree (tracking_number);


--
-- Name: idx_asn_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asn_warehouse ON public.asn_header USING btree (warehouse_id);


--
-- Name: idx_attachments_company_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachments_company_reference ON public.attachments USING btree (company_id, reference_type, reference_no);


--
-- Name: idx_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_date ON public.audit_logs USING btree (changed_at);


--
-- Name: idx_audit_logs_company_action_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_company_action_created_at ON public.audit_logs USING btree (company_id, action, created_at DESC);


--
-- Name: idx_audit_logs_company_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_company_created_at ON public.audit_logs USING btree (company_id, created_at DESC);


--
-- Name: idx_audit_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_record ON public.audit_logs USING btree (record_id);


--
-- Name: idx_audit_table; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_table ON public.audit_logs USING btree (table_name);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user ON public.audit_logs USING btree (changed_by);


--
-- Name: idx_bjr_company_job_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bjr_company_job_started ON public.billing_job_runs USING btree (company_id, job_type, started_at DESC);


--
-- Name: idx_bt_company_charge_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bt_company_charge_type ON public.billing_transactions USING btree (company_id, charge_type);


--
-- Name: idx_bt_company_client_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bt_company_client_event_date ON public.billing_transactions USING btree (company_id, client_id, event_date);


--
-- Name: idx_bt_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bt_company_invoice ON public.billing_transactions USING btree (company_id, invoice_id);


--
-- Name: idx_bt_company_status_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bt_company_status_event_date ON public.billing_transactions USING btree (company_id, status, event_date);


--
-- Name: idx_category_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_category_active ON public.item_categories USING btree (is_active);


--
-- Name: idx_category_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_category_code ON public.item_categories USING btree (category_code);


--
-- Name: idx_category_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_category_parent ON public.item_categories USING btree (parent_category_id);


--
-- Name: idx_cbp_company_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cbp_company_client_active ON public.client_billing_profile USING btree (company_id, client_id, is_active);


--
-- Name: idx_cc_subs_company_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_subs_company_approval ON public.mobile_cycle_count_submissions USING btree (company_id, approval_status, created_at DESC);


--
-- Name: idx_cc_subs_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_subs_task ON public.mobile_cycle_count_submissions USING btree (task_id);


--
-- Name: idx_cc_tasks_company_bin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_tasks_company_bin ON public.mobile_cycle_count_tasks USING btree (company_id, warehouse_id, bin_id);


--
-- Name: idx_cc_tasks_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_tasks_company_status ON public.mobile_cycle_count_tasks USING btree (company_id, status, created_at DESC);


--
-- Name: idx_cc_tasks_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cc_tasks_plan ON public.mobile_cycle_count_tasks USING btree (plan_id);


--
-- Name: idx_ccp_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ccp_company_status ON public.cycle_count_plans USING btree (company_id, status, created_at DESC);


--
-- Name: idx_chart_of_accounts_company_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chart_of_accounts_company_type ON public.chart_of_accounts USING btree (company_id, account_type);


--
-- Name: idx_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_active ON public.clients USING btree (is_active);


--
-- Name: idx_client_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_code ON public.clients USING btree (client_code);


--
-- Name: idx_client_contact_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_contact_client ON public.client_contacts USING btree (client_id);


--
-- Name: idx_client_contact_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_contact_primary ON public.client_contacts USING btree (is_primary);


--
-- Name: idx_client_contacts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_contacts_company_id ON public.client_contacts USING btree (company_id);


--
-- Name: idx_client_contracts_company_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_contracts_company_client_active ON public.client_contracts USING btree (company_id, client_id, is_active);


--
-- Name: idx_client_contracts_effective_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_contracts_effective_from ON public.client_contracts USING btree (effective_from DESC);


--
-- Name: idx_client_doc_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_doc_client ON public.client_documents USING btree (client_id);


--
-- Name: idx_client_doc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_doc_type ON public.client_documents USING btree (document_type);


--
-- Name: idx_client_documents_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_documents_company_id ON public.client_documents USING btree (company_id);


--
-- Name: idx_client_gst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_gst ON public.clients USING btree (gst_number);


--
-- Name: idx_client_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_name ON public.clients USING btree (client_name);


--
-- Name: idx_client_portal_asn_company_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_portal_asn_company_client ON public.client_portal_asn_requests USING btree (company_id, client_id, created_at DESC);


--
-- Name: idx_clients_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_company_id ON public.clients USING btree (company_id);


--
-- Name: idx_cnh_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cnh_company_invoice ON public.credit_note_header USING btree (company_id, invoice_id, note_date DESC);


--
-- Name: idx_cnl_company_credit_note; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cnl_company_credit_note ON public.credit_note_lines USING btree (company_id, credit_note_id);


--
-- Name: idx_crd_company_master_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crd_company_master_active ON public.client_rate_details USING btree (company_id, rate_master_id, is_active);


--
-- Name: idx_crd_company_master_charge_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crd_company_master_charge_item ON public.client_rate_details USING btree (company_id, rate_master_id, charge_type, item_id, is_active);


--
-- Name: idx_crm_company_client_active_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_company_client_active_dates ON public.client_rate_master USING btree (company_id, client_id, is_active, effective_from DESC);


--
-- Name: idx_customer_label_templates_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_label_templates_company_id ON public.customer_label_templates USING btree (company_id);


--
-- Name: idx_daily_kpi_summary_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_kpi_summary_company_id ON public.daily_kpi_summary USING btree (company_id);


--
-- Name: idx_dn_company_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dn_company_do ON public.delivery_note_header USING btree (company_id, do_header_id, status);


--
-- Name: idx_dn_lines_dn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dn_lines_dn ON public.delivery_note_lines USING btree (company_id, delivery_note_id);


--
-- Name: idx_dnh_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dnh_company_invoice ON public.debit_note_header USING btree (company_id, invoice_id, note_date DESC);


--
-- Name: idx_dnl_company_debit_note; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dnl_company_debit_note ON public.debit_note_lines USING btree (company_id, debit_note_id);


--
-- Name: idx_do_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_client ON public.do_header USING btree (client_id);


--
-- Name: idx_do_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_date ON public.do_header USING btree (request_date);


--
-- Name: idx_do_header_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_header_company_id ON public.do_header USING btree (company_id);


--
-- Name: idx_do_line_header; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_line_header ON public.do_line_items USING btree (do_header_id);


--
-- Name: idx_do_line_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_line_item ON public.do_line_items USING btree (item_id);


--
-- Name: idx_do_line_items_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_line_items_company_id ON public.do_line_items USING btree (company_id);


--
-- Name: idx_do_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_number ON public.do_header USING btree (do_number);


--
-- Name: idx_do_pick_tasks_company_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_pick_tasks_company_assignee ON public.do_pick_tasks USING btree (company_id, assigned_to, status);


--
-- Name: idx_do_pick_tasks_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_pick_tasks_company_status ON public.do_pick_tasks USING btree (company_id, status, created_at DESC);


--
-- Name: idx_do_pick_tasks_company_wave; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_pick_tasks_company_wave ON public.do_pick_tasks USING btree (company_id, wave_id, status);


--
-- Name: idx_do_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_status ON public.do_header USING btree (status);


--
-- Name: idx_do_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_warehouse ON public.do_header USING btree (warehouse_id);


--
-- Name: idx_do_wave_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_wave_company_status ON public.do_wave_header USING btree (company_id, status, created_at DESC);


--
-- Name: idx_do_wave_company_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_wave_company_warehouse ON public.do_wave_header USING btree (company_id, warehouse_id, created_at DESC);


--
-- Name: idx_do_wave_orders_company_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_wave_orders_company_do ON public.do_wave_orders USING btree (company_id, do_header_id);


--
-- Name: idx_do_wave_orders_company_wave; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_do_wave_orders_company_wave ON public.do_wave_orders USING btree (company_id, wave_id, pick_sequence);


--
-- Name: idx_edi_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_client ON public.edi_transactions USING btree (client_id);


--
-- Name: idx_edi_control; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_control ON public.edi_transactions USING btree (control_number);


--
-- Name: idx_edi_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_date ON public.edi_transactions USING btree (received_at);


--
-- Name: idx_edi_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_reference ON public.edi_transactions USING btree (reference_type, reference_id);


--
-- Name: idx_edi_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_status ON public.edi_transactions USING btree (status);


--
-- Name: idx_edi_transactions_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_transactions_company_id ON public.edi_transactions USING btree (company_id);


--
-- Name: idx_edi_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edi_type ON public.edi_transactions USING btree (transaction_type, message_type);


--
-- Name: idx_ff_documents_company_shipment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ff_documents_company_shipment ON public.ff_documents USING btree (company_id, shipment_id, doc_type);


--
-- Name: idx_ff_milestones_company_shipment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ff_milestones_company_shipment ON public.ff_milestones USING btree (company_id, shipment_id, planned_at);


--
-- Name: idx_ff_shipment_legs_company_shipment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ff_shipment_legs_company_shipment ON public.ff_shipment_legs USING btree (company_id, shipment_id, leg_no);


--
-- Name: idx_ff_shipments_company_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ff_shipments_company_client ON public.ff_shipments USING btree (company_id, client_id, created_at DESC);


--
-- Name: idx_ff_shipments_company_status_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ff_shipments_company_status_mode ON public.ff_shipments USING btree (company_id, status, mode, created_at DESC);


--
-- Name: idx_gate_in_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gate_in_company_id ON public.gate_in USING btree (company_id);


--
-- Name: idx_gate_in_departure_datetime; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gate_in_departure_datetime ON public.gate_in USING btree (departure_datetime);


--
-- Name: idx_gate_out_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gate_out_company_id ON public.gate_out USING btree (company_id);


--
-- Name: idx_gatein_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gatein_client ON public.gate_in USING btree (client_id);


--
-- Name: idx_gatein_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gatein_date ON public.gate_in USING btree (arrival_datetime);


--
-- Name: idx_gatein_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gatein_number ON public.gate_in USING btree (gate_in_number);


--
-- Name: idx_gatein_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gatein_status ON public.gate_in USING btree (status);


--
-- Name: idx_gatein_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gatein_warehouse ON public.gate_in USING btree (warehouse_id);


--
-- Name: idx_gateout_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateout_client ON public.gate_out USING btree (client_id);


--
-- Name: idx_gateout_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateout_date ON public.gate_out USING btree (gate_out_datetime);


--
-- Name: idx_gateout_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateout_do ON public.gate_out USING btree (do_header_id);


--
-- Name: idx_gateout_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateout_number ON public.gate_out USING btree (gate_out_number);


--
-- Name: idx_gateout_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gateout_warehouse ON public.gate_out USING btree (warehouse_id);


--
-- Name: idx_gi_company_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gi_company_do ON public.goods_issue_header USING btree (company_id, do_header_id, status);


--
-- Name: idx_gi_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gi_company_status ON public.goods_issue_header USING btree (company_id, status, issued_at DESC);


--
-- Name: idx_gi_pack_units_gi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gi_pack_units_gi ON public.goods_issue_pack_units USING btree (company_id, goods_issue_id);


--
-- Name: idx_grn_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_client ON public.grn_header USING btree (client_id);


--
-- Name: idx_grn_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_date ON public.grn_header USING btree (grn_date);


--
-- Name: idx_grn_gatein; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_gatein ON public.grn_header USING btree (gate_in_id);


--
-- Name: idx_grn_header_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_header_company_id ON public.grn_header USING btree (company_id);


--
-- Name: idx_grn_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_invoice ON public.grn_header USING btree (invoice_number);


--
-- Name: idx_grn_line_header; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_line_header ON public.grn_line_items USING btree (grn_header_id);


--
-- Name: idx_grn_line_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_line_item ON public.grn_line_items USING btree (item_id);


--
-- Name: idx_grn_line_items_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_line_items_company_id ON public.grn_line_items USING btree (company_id);


--
-- Name: idx_grn_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_number ON public.grn_header USING btree (grn_number);


--
-- Name: idx_grn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_status ON public.grn_header USING btree (status);


--
-- Name: idx_grn_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_warehouse ON public.grn_header USING btree (warehouse_id);


--
-- Name: idx_ih_company_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ih_company_client_date ON public.invoice_header USING btree (company_id, client_id, invoice_date DESC);


--
-- Name: idx_ih_company_status_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ih_company_status_date ON public.invoice_header USING btree (company_id, status, invoice_date DESC);


--
-- Name: idx_il_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_il_company_invoice ON public.invoice_lines USING btree (company_id, invoice_id);


--
-- Name: idx_il_company_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_il_company_source ON public.invoice_lines USING btree (company_id, source_type, source_doc_id);


--
-- Name: idx_integration_connectors_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_connectors_company_status ON public.integration_connectors USING btree (company_id, status, provider_type, connector_name);


--
-- Name: idx_integration_credentials_company_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_credentials_company_connector ON public.integration_connector_credentials USING btree (company_id, connector_id, is_active);


--
-- Name: idx_integration_events_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_company_status ON public.integration_events USING btree (company_id, status, created_at DESC);


--
-- Name: idx_integration_events_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_retry ON public.integration_events USING btree (company_id, status, next_retry_at) WHERE ((status)::text = ANY ((ARRAY['RETRY'::character varying, 'DEAD_LETTER'::character varying, 'QUEUED'::character varying])::text[]));


--
-- Name: idx_integration_mapping_fields_mapping_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_mapping_fields_mapping_seq ON public.integration_mapping_fields USING btree (mapping_id, sequence_no);


--
-- Name: idx_integration_mappings_company_connector_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_mappings_company_connector_entity ON public.integration_schema_mappings USING btree (company_id, connector_id, entity_type, direction, is_active);


--
-- Name: idx_invoice_payments_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_payments_company_invoice ON public.invoice_payments USING btree (company_id, invoice_id);


--
-- Name: idx_invoices_company_invoice_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_invoice_date ON public.invoices USING btree (company_id, invoice_date DESC);


--
-- Name: idx_item_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_active ON public.items USING btree (is_active);


--
-- Name: idx_item_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_approval ON public.items USING btree (approval_status);


--
-- Name: idx_item_categories_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_categories_company_id ON public.item_categories USING btree (company_id);


--
-- Name: idx_item_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_category ON public.items USING btree (category_id);


--
-- Name: idx_item_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_code ON public.items USING btree (item_code);


--
-- Name: idx_item_hsn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_hsn ON public.items USING btree (hsn_code);


--
-- Name: idx_item_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_name ON public.items USING btree (item_name);


--
-- Name: idx_item_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_name_trgm ON public.items USING gin (item_name public.gin_trgm_ops);


--
-- Name: idx_items_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_company_id ON public.items USING btree (company_id);


--
-- Name: idx_itl_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_itl_company_invoice ON public.invoice_tax_lines USING btree (company_id, invoice_id);


--
-- Name: idx_journal_entries_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_entries_company_date ON public.journal_entries USING btree (company_id, entry_date);


--
-- Name: idx_journal_lines_company_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_lines_company_entry ON public.journal_lines USING btree (company_id, journal_entry_id);


--
-- Name: idx_kpi_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_date ON public.daily_kpi_summary USING btree (kpi_date);


--
-- Name: idx_kpi_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_user ON public.daily_kpi_summary USING btree (user_id);


--
-- Name: idx_kpi_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_warehouse ON public.daily_kpi_summary USING btree (warehouse_id);


--
-- Name: idx_label_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_label_active ON public.customer_label_templates USING btree (is_active);


--
-- Name: idx_label_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_label_client ON public.customer_label_templates USING btree (client_id);


--
-- Name: idx_label_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_label_type ON public.customer_label_templates USING btree (label_type);


--
-- Name: idx_labor_productivity_company_event_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labor_productivity_company_event_ts ON public.labor_productivity_events USING btree (company_id, event_ts DESC);


--
-- Name: idx_labor_productivity_company_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labor_productivity_company_user ON public.labor_productivity_events USING btree (company_id, user_id, event_ts DESC);


--
-- Name: idx_labor_shift_assignments_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labor_shift_assignments_company_date ON public.labor_shift_assignments USING btree (company_id, shift_date DESC, shift_id);


--
-- Name: idx_labor_shifts_company_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labor_shifts_company_active ON public.labor_shifts USING btree (company_id, is_active, shift_name);


--
-- Name: idx_labor_standards_company_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labor_standards_company_active ON public.labor_standards USING btree (company_id, is_active, operation_name);


--
-- Name: idx_load_pack_units_load; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_load_pack_units_load ON public.outbound_load_pack_units USING btree (company_id, load_id);


--
-- Name: idx_loads_company_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loads_company_do ON public.outbound_loads USING btree (company_id, do_header_id, status);


--
-- Name: idx_loads_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loads_company_status ON public.outbound_loads USING btree (company_id, status, created_at DESC);


--
-- Name: idx_mobile_auth_sessions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_auth_sessions_company ON public.mobile_auth_sessions USING btree (company_id, revoked_at);


--
-- Name: idx_mobile_auth_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_auth_sessions_user ON public.mobile_auth_sessions USING btree (user_id, revoked_at);


--
-- Name: idx_mobile_grn_captures_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_grn_captures_company_id ON public.mobile_grn_captures USING btree (company_id);


--
-- Name: idx_mobile_grn_captures_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_grn_captures_status_created ON public.mobile_grn_captures USING btree (status, created_at DESC);


--
-- Name: idx_mobile_sync_task_queue_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_sync_task_queue_company_code ON public.mobile_sync_task_queue USING btree (company_code);


--
-- Name: idx_mobile_sync_task_queue_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobile_sync_task_queue_status_created_at ON public.mobile_sync_task_queue USING btree (status, created_at);


--
-- Name: idx_mv_snapshot_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mv_snapshot_client ON public.mv_daily_stock_snapshot USING btree (client_id);


--
-- Name: idx_mv_snapshot_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mv_snapshot_date ON public.mv_daily_stock_snapshot USING btree (snapshot_date);


--
-- Name: idx_mv_snapshot_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mv_snapshot_item ON public.mv_daily_stock_snapshot USING btree (item_id);


--
-- Name: idx_mv_snapshot_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mv_snapshot_warehouse ON public.mv_daily_stock_snapshot USING btree (warehouse_id);


--
-- Name: idx_notifications_company_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_company_created_at ON public.notifications USING btree (company_id, created_at DESC);


--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, read_at, created_at DESC);


--
-- Name: idx_pack_unit_serials_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pack_unit_serials_line ON public.do_pack_unit_serials USING btree (company_id, do_line_item_id);


--
-- Name: idx_pack_unit_serials_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pack_unit_serials_unit ON public.do_pack_unit_serials USING btree (company_id, pack_unit_id);


--
-- Name: idx_pack_units_company_do; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pack_units_company_do ON public.do_pack_units USING btree (company_id, do_header_id, status);


--
-- Name: idx_pack_units_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pack_units_company_status ON public.do_pack_units USING btree (company_id, status, created_at DESC);


--
-- Name: idx_portal_dispute_events_company_dispute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_dispute_events_company_dispute ON public.portal_invoice_dispute_events USING btree (company_id, dispute_id, created_at DESC);


--
-- Name: idx_portal_disputes_company_client_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_disputes_company_client_status ON public.portal_invoice_disputes USING btree (company_id, client_id, status, raised_at DESC);


--
-- Name: idx_portal_disputes_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_disputes_company_invoice ON public.portal_invoice_disputes USING btree (company_id, invoice_id, raised_at DESC);


--
-- Name: idx_portal_invoice_actions_company_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_invoice_actions_company_invoice ON public.portal_invoice_actions USING btree (company_id, invoice_id, created_at DESC);


--
-- Name: idx_portal_sla_company_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_sla_company_client_active ON public.portal_client_sla_policies USING btree (company_id, client_id, is_active);


--
-- Name: idx_portal_user_clients_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_user_clients_lookup ON public.portal_user_clients USING btree (company_id, user_id, client_id, is_active);


--
-- Name: idx_portal_user_invites_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_user_invites_lookup ON public.portal_user_invites USING btree (company_id, user_id, status, expires_at DESC);


--
-- Name: idx_portal_user_permissions_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_user_permissions_lookup ON public.portal_user_permissions USING btree (company_id, user_id, feature_key, is_allowed);


--
-- Name: idx_printed_labels_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_printed_labels_client ON public.printed_labels_log USING btree (client_id);


--
-- Name: idx_printed_labels_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_printed_labels_date ON public.printed_labels_log USING btree (printed_at);


--
-- Name: idx_printed_labels_log_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_printed_labels_log_company_id ON public.printed_labels_log USING btree (company_id);


--
-- Name: idx_printed_labels_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_printed_labels_ref ON public.printed_labels_log USING btree (reference_type, reference_id);


--
-- Name: idx_printed_labels_sscc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_printed_labels_sscc ON public.printed_labels_log USING btree (sscc);


--
-- Name: idx_putaway_movements_stock_serial_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_putaway_movements_stock_serial_id ON public.stock_putaway_movements USING btree (stock_serial_id);


--
-- Name: idx_putaway_movements_warehouse_moved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_putaway_movements_warehouse_moved_at ON public.stock_putaway_movements USING btree (warehouse_id, moved_at DESC);


--
-- Name: idx_refresh_token_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_token_active ON public.refresh_tokens USING btree (is_revoked) WHERE (is_revoked = false);


--
-- Name: idx_refresh_token_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_token_expiry ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_token_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_token_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_token_user ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_reset_token_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_token_expiry ON public.password_reset_tokens USING btree (expires_at);


--
-- Name: idx_reset_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_token_hash ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: idx_reset_token_unused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_token_unused ON public.password_reset_tokens USING btree (is_used) WHERE (is_used = false);


--
-- Name: idx_sequence_counters_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequence_counters_company_id ON public.sequence_counters USING btree (company_id);


--
-- Name: idx_setting_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_setting_key ON public.system_settings USING btree (setting_key);


--
-- Name: idx_ss_company_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ss_company_client_date ON public.storage_snapshot USING btree (company_id, client_id, snapshot_date DESC);


--
-- Name: idx_ss_company_warehouse_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ss_company_warehouse_date ON public.storage_snapshot USING btree (company_id, warehouse_id, snapshot_date DESC);


--
-- Name: idx_stock_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_batch ON public.stock_serial_numbers USING btree (batch_number) WHERE (batch_number IS NOT NULL);


--
-- Name: idx_stock_expiry_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_expiry_date ON public.stock_serial_numbers USING btree (expiry_date) WHERE (expiry_date IS NOT NULL);


--
-- Name: idx_stock_fifo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_fifo ON public.stock_serial_numbers USING btree (client_id, item_id, status, received_date);


--
-- Name: idx_stock_movements_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_movements_company_id ON public.stock_movements USING btree (company_id);


--
-- Name: idx_stock_putaway_movements_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_putaway_movements_company_id ON public.stock_putaway_movements USING btree (company_id);


--
-- Name: idx_stock_serial_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_serial_batch ON public.stock_serial_numbers USING btree (company_id, item_id, batch_number) WHERE (batch_number IS NOT NULL);


--
-- Name: idx_stock_serial_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_serial_expiry ON public.stock_serial_numbers USING btree (company_id, warehouse_id, client_id, item_id, expiry_date) WHERE ((status)::text = ANY ((ARRAY['IN_STOCK'::character varying, 'RESERVED'::character varying])::text[]));


--
-- Name: idx_stock_serial_numbers_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_serial_numbers_company_id ON public.stock_serial_numbers USING btree (company_id);


--
-- Name: idx_stock_serial_numbers_lp_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_serial_numbers_lp_record ON public.stock_serial_numbers USING btree (lp_record_id) WHERE (lp_record_id IS NOT NULL);


--
-- Name: idx_stock_serial_numbers_zone_layout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_serial_numbers_zone_layout ON public.stock_serial_numbers USING btree (zone_layout_id);


--
-- Name: idx_stock_shelf_life; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_shelf_life ON public.stock_serial_numbers USING btree (remaining_shelf_life_days) WHERE (remaining_shelf_life_days IS NOT NULL);


--
-- Name: idx_stock_sn_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_client ON public.stock_serial_numbers USING btree (client_id);


--
-- Name: idx_stock_sn_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_item ON public.stock_serial_numbers USING btree (item_id);


--
-- Name: idx_stock_sn_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_number ON public.stock_serial_numbers USING btree (serial_number);


--
-- Name: idx_stock_sn_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_received ON public.stock_serial_numbers USING btree (received_date);


--
-- Name: idx_stock_sn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_status ON public.stock_serial_numbers USING btree (status);


--
-- Name: idx_stock_sn_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_warehouse ON public.stock_serial_numbers USING btree (warehouse_id);


--
-- Name: idx_stock_sn_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_sn_zone ON public.stock_serial_numbers USING btree (zone_id);


--
-- Name: idx_stockmov_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_client ON public.stock_movements USING btree (client_id);


--
-- Name: idx_stockmov_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_created_by ON public.stock_movements USING btree (created_by);


--
-- Name: idx_stockmov_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_date ON public.stock_movements USING btree (movement_date);


--
-- Name: idx_stockmov_do_header; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_do_header ON public.stock_movements USING btree (do_header_id);


--
-- Name: idx_stockmov_from_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_from_warehouse ON public.stock_movements USING btree (from_warehouse_id);


--
-- Name: idx_stockmov_from_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_from_zone ON public.stock_movements USING btree (from_zone_id);


--
-- Name: idx_stockmov_gate_in; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_gate_in ON public.stock_movements USING btree (gate_in_id);


--
-- Name: idx_stockmov_gate_out; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_gate_out ON public.stock_movements USING btree (gate_out_id);


--
-- Name: idx_stockmov_grn_header; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_grn_header ON public.stock_movements USING btree (grn_header_id);


--
-- Name: idx_stockmov_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_item ON public.stock_movements USING btree (item_id);


--
-- Name: idx_stockmov_item_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_item_client_date ON public.stock_movements USING btree (item_id, client_id, movement_date DESC);


--
-- Name: idx_stockmov_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_number ON public.stock_movements USING btree (movement_number);


--
-- Name: idx_stockmov_reversed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_reversed ON public.stock_movements USING btree (is_reversed) WHERE (is_reversed = false);


--
-- Name: idx_stockmov_serial; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_serial ON public.stock_movements USING btree (serial_number_id);


--
-- Name: idx_stockmov_serial_chrono; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_serial_chrono ON public.stock_movements USING btree (serial_number_id, movement_date DESC);


--
-- Name: idx_stockmov_to_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_to_warehouse ON public.stock_movements USING btree (to_warehouse_id);


--
-- Name: idx_stockmov_to_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_to_zone ON public.stock_movements USING btree (to_zone_id);


--
-- Name: idx_stockmov_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stockmov_type ON public.stock_movements USING btree (movement_type);


--
-- Name: idx_system_settings_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_settings_company_id ON public.system_settings USING btree (company_id);


--
-- Name: idx_tenant_products_company_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_products_company_product ON public.tenant_products USING btree (company_id, product_code);


--
-- Name: idx_tenant_products_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_products_company_status ON public.tenant_products USING btree (company_id, status, product_code);


--
-- Name: idx_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_active ON public.users USING btree (is_active);


--
-- Name: idx_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_email ON public.users USING btree (email);


--
-- Name: idx_user_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role ON public.users USING btree (role);


--
-- Name: idx_user_scopes_company_user_scope_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_scopes_company_user_scope_type ON public.user_scopes USING btree (company_id, user_id, scope_type);


--
-- Name: idx_user_sessions_company_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_company_active ON public.user_sessions USING btree (company_id, revoked_at, created_at DESC);


--
-- Name: idx_user_sessions_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_last_seen ON public.user_sessions USING btree (last_seen_at DESC);


--
-- Name: idx_user_sessions_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_active ON public.user_sessions USING btree (user_id, revoked_at, created_at DESC);


--
-- Name: idx_user_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_username ON public.users USING btree (username);


--
-- Name: idx_user_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_warehouse ON public.users USING btree (warehouse_id);


--
-- Name: idx_users_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_company_id ON public.users USING btree (company_id);


--
-- Name: idx_warehouse_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_active ON public.warehouses USING btree (is_active);


--
-- Name: idx_warehouse_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_code ON public.warehouses USING btree (warehouse_code);


--
-- Name: idx_warehouse_zone_layouts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_zone_layouts_company_id ON public.warehouse_zone_layouts USING btree (company_id);


--
-- Name: idx_warehouse_zones_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_zones_company_id ON public.warehouse_zones USING btree (company_id);


--
-- Name: idx_warehouses_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouses_company_id ON public.warehouses USING btree (company_id);


--
-- Name: idx_wes_command_queue_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wes_command_queue_company_status ON public.wes_command_queue USING btree (company_id, status, priority, created_at);


--
-- Name: idx_wes_command_queue_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wes_command_queue_retry ON public.wes_command_queue USING btree (company_id, status, next_attempt_at) WHERE ((status)::text = ANY ((ARRAY['RETRY'::character varying, 'QUEUED'::character varying])::text[]));


--
-- Name: idx_wes_equipment_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wes_equipment_company_status ON public.wes_equipment USING btree (company_id, warehouse_id, status, updated_at DESC);


--
-- Name: idx_wes_event_log_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wes_event_log_company_created ON public.wes_event_log USING btree (company_id, created_at DESC);


--
-- Name: idx_wes_failover_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wes_failover_company_status ON public.wes_failover_incidents USING btree (company_id, status, opened_at DESC);


--
-- Name: idx_workforce_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_date ON public.workforce_tasks USING btree (start_time);


--
-- Name: idx_workforce_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_status ON public.workforce_tasks USING btree (status);


--
-- Name: idx_workforce_tasks_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_tasks_company_id ON public.workforce_tasks USING btree (company_id);


--
-- Name: idx_workforce_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_type ON public.workforce_tasks USING btree (task_type);


--
-- Name: idx_workforce_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_user ON public.workforce_tasks USING btree (user_id);


--
-- Name: idx_workforce_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_warehouse ON public.workforce_tasks USING btree (warehouse_id);


--
-- Name: idx_zone_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zone_active ON public.warehouse_zones USING btree (is_active);


--
-- Name: idx_zone_layout_warehouse_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zone_layout_warehouse_active ON public.warehouse_zone_layouts USING btree (warehouse_id, is_active);


--
-- Name: idx_zone_layout_warehouse_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zone_layout_warehouse_zone ON public.warehouse_zone_layouts USING btree (warehouse_zone_id);


--
-- Name: idx_zone_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zone_warehouse ON public.warehouse_zones USING btree (warehouse_id);


--
-- Name: mobile_qc_holds_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mobile_qc_holds_open_idx ON public.mobile_qc_holds USING btree (company_id) WHERE (status = 'OPEN'::text);


--
-- Name: mobile_qc_results_reason_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mobile_qc_results_reason_code_idx ON public.mobile_qc_results USING btree (company_id, reason_code) WHERE (reason_code IS NOT NULL);


--
-- Name: uq_asn_header_company_asn_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_asn_header_company_asn_number ON public.asn_header USING btree (company_id, asn_number);


--
-- Name: uq_bt_company_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bt_company_event_key ON public.billing_transactions USING btree (company_id, source_type, COALESCE(source_doc_id, 0), COALESCE(source_line_id, 0), charge_type, event_date, COALESCE(period_from, event_date), COALESCE(period_to, event_date));


--
-- Name: uq_chart_of_accounts_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_chart_of_accounts_company_code ON public.chart_of_accounts USING btree (company_id, account_code);


--
-- Name: uq_clients_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_clients_company_code ON public.clients USING btree (company_id, client_code);


--
-- Name: uq_crd_company_master_charge_slab; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_crd_company_master_charge_slab ON public.client_rate_details USING btree (company_id, rate_master_id, charge_type, uom, COALESCE(min_qty, (0)::numeric), COALESCE(max_qty, (999999999)::numeric));


--
-- Name: uq_do_header_company_do_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_do_header_company_do_number ON public.do_header USING btree (company_id, do_number);


--
-- Name: uq_gate_in_company_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gate_in_company_number ON public.gate_in USING btree (company_id, gate_in_number);


--
-- Name: uq_gate_out_company_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gate_out_company_number ON public.gate_out USING btree (company_id, gate_out_number);


--
-- Name: uq_grn_header_company_grn_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_grn_header_company_grn_number ON public.grn_header USING btree (company_id, grn_number);


--
-- Name: uq_integration_event_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_integration_event_idempotency ON public.integration_events USING btree (company_id, connector_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_invoices_company_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoices_company_number ON public.invoices USING btree (company_id, invoice_number);


--
-- Name: uq_items_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_items_company_code ON public.items USING btree (company_id, item_code);


--
-- Name: uq_journal_entries_company_external_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_journal_entries_company_external_ref ON public.journal_entries USING btree (company_id, external_ref);


--
-- Name: uq_journal_lines_entry_line_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_journal_lines_entry_line_no ON public.journal_lines USING btree (journal_entry_id, line_no);


--
-- Name: uq_mobile_grn_capture_company_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_mobile_grn_capture_company_ref ON public.mobile_grn_captures USING btree (company_id, capture_ref);


--
-- Name: uq_rbac_user_roles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rbac_user_roles_user_id ON public.rbac_user_roles USING btree (user_id);


--
-- Name: uq_ss_company_daily_grain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ss_company_daily_grain ON public.storage_snapshot USING btree (company_id, client_id, warehouse_id, snapshot_date, COALESCE(item_id, 0));


--
-- Name: uq_users_company_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_company_email ON public.users USING btree (company_id, email);


--
-- Name: uq_users_company_username; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_company_username ON public.users USING btree (company_id, username);


--
-- Name: uq_warehouses_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_warehouses_company_code ON public.warehouses USING btree (company_id, warehouse_code);


--
-- Name: uq_zone_layout_wh_zone_rack_bin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_zone_layout_wh_zone_rack_bin ON public.warehouse_zone_layouts USING btree (warehouse_id, zone_code, rack_code, bin_code);


--
-- Name: users_putaway_pin_approver_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_putaway_pin_approver_idx ON public.users USING btree (company_id) WHERE ((putaway_pin_hash IS NOT NULL) AND ((role)::text = ANY ((ARRAY['SUPERVISOR'::character varying, 'WAREHOUSE_MANAGER'::character varying, 'ADMIN'::character varying, 'SUPER_ADMIN'::character varying])::text[])));


--
-- Name: v_asn_with_details _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_asn_with_details AS
 SELECT ah.id,
    ah.asn_number,
    ah.customer_po_number,
    c.client_code,
    c.client_name,
    c.gst_number,
    w.warehouse_name,
    ah.ship_to_name,
    ah.ship_to_address,
    ah.carrier_name,
    ah.tracking_number,
    ah.actual_ship_date,
    ah.total_cartons,
    ah.total_pallets,
    ah.edi_format,
    ah.status,
    count(DISTINCT ali.item_id) AS total_items,
    sum(ali.quantity_shipped) AS total_quantity,
    u.full_name AS created_by_name
   FROM ((((public.asn_header ah
     JOIN public.clients c ON ((ah.client_id = c.id)))
     JOIN public.warehouses w ON ((ah.warehouse_id = w.id)))
     LEFT JOIN public.asn_line_items ali ON ((ah.id = ali.asn_header_id)))
     JOIN public.users u ON ((ah.created_by = u.id)))
  GROUP BY ah.id, c.client_code, c.client_name, c.gst_number, w.warehouse_name, u.full_name;


--
-- Name: clients trg_audit_clients; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_clients AFTER INSERT OR DELETE OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: do_header trg_audit_do_header; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_do_header AFTER INSERT OR DELETE OR UPDATE ON public.do_header FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: do_line_items trg_audit_do_line_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_do_line_items AFTER INSERT OR DELETE OR UPDATE ON public.do_line_items FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: gate_in trg_audit_gate_in; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_gate_in AFTER INSERT OR DELETE OR UPDATE ON public.gate_in FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: gate_out trg_audit_gate_out; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_gate_out AFTER INSERT OR DELETE OR UPDATE ON public.gate_out FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: grn_header trg_audit_grn_header; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_grn_header AFTER INSERT OR DELETE OR UPDATE ON public.grn_header FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: grn_line_items trg_audit_grn_line_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_grn_line_items AFTER INSERT OR DELETE OR UPDATE ON public.grn_line_items FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: items trg_audit_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_items AFTER INSERT OR DELETE OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: stock_serial_numbers trg_audit_stock_serial_numbers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_stock_serial_numbers AFTER INSERT OR DELETE OR UPDATE ON public.stock_serial_numbers FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: users trg_audit_users; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_users AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.audit_log_function();


--
-- Name: workforce_tasks trg_calculate_duration; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_calculate_duration BEFORE INSERT OR UPDATE OF start_time, end_time ON public.workforce_tasks FOR EACH ROW EXECUTE FUNCTION public.calculate_task_duration();


--
-- Name: stock_serial_numbers trg_calculate_shelf_life; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_calculate_shelf_life BEFORE INSERT OR UPDATE OF expiry_date ON public.stock_serial_numbers FOR EACH ROW EXECUTE FUNCTION public.calculate_shelf_life();


--
-- Name: refresh_tokens trg_enforce_single_device; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_single_device AFTER INSERT ON public.refresh_tokens FOR EACH ROW EXECUTE FUNCTION public.enforce_single_device_login();


--
-- Name: stock_serial_numbers trg_track_serial_movements; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_track_serial_movements AFTER INSERT OR UPDATE ON public.stock_serial_numbers FOR EACH ROW EXECUTE FUNCTION public.fn_track_serial_movements();


--
-- Name: asn_line_items trg_update_asn_totals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_asn_totals AFTER INSERT OR DELETE OR UPDATE ON public.asn_line_items FOR EACH ROW EXECUTE FUNCTION public.update_asn_totals();


--
-- Name: do_line_items trg_update_do_totals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_do_totals AFTER INSERT OR DELETE OR UPDATE ON public.do_line_items FOR EACH ROW EXECUTE FUNCTION public.update_do_totals();


--
-- Name: grn_line_items trg_update_grn_totals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_grn_totals AFTER INSERT OR DELETE OR UPDATE ON public.grn_line_items FOR EACH ROW EXECUTE FUNCTION public.update_grn_totals();


--
-- Name: asn_header trg_update_timestamp_asn_header; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_asn_header BEFORE UPDATE ON public.asn_header FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: clients trg_update_timestamp_clients; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_clients BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: do_header trg_update_timestamp_do_header; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_do_header BEFORE UPDATE ON public.do_header FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: gate_in trg_update_timestamp_gate_in; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_gate_in BEFORE UPDATE ON public.gate_in FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: grn_header trg_update_timestamp_grn_header; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_grn_header BEFORE UPDATE ON public.grn_header FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: items trg_update_timestamp_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_items BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: customer_label_templates trg_update_timestamp_label_templates; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_label_templates BEFORE UPDATE ON public.customer_label_templates FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: users trg_update_timestamp_users; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_users BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: warehouses trg_update_timestamp_warehouses; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_timestamp_warehouses BEFORE UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: api_idempotency_keys api_idempotency_keys_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency_keys
    ADD CONSTRAINT api_idempotency_keys_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: asn_carton_details asn_carton_details_asn_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_asn_header_id_fkey FOREIGN KEY (asn_header_id) REFERENCES public.asn_header(id) ON DELETE CASCADE;


--
-- Name: asn_carton_details asn_carton_details_asn_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_asn_line_item_id_fkey FOREIGN KEY (asn_line_item_id) REFERENCES public.asn_line_items(id) ON DELETE CASCADE;


--
-- Name: asn_carton_details asn_carton_details_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: asn_carton_details asn_carton_details_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_carton_details
    ADD CONSTRAINT asn_carton_details_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: asn_header asn_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: asn_header asn_header_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: asn_header asn_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: asn_header asn_header_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id);


--
-- Name: asn_header asn_header_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: asn_header asn_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_header
    ADD CONSTRAINT asn_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: asn_line_items asn_line_items_asn_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_asn_header_id_fkey FOREIGN KEY (asn_header_id) REFERENCES public.asn_header(id) ON DELETE CASCADE;


--
-- Name: asn_line_items asn_line_items_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: asn_line_items asn_line_items_do_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_do_line_item_id_fkey FOREIGN KEY (do_line_item_id) REFERENCES public.do_line_items(id);


--
-- Name: asn_line_items asn_line_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asn_line_items
    ADD CONSTRAINT asn_line_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: attachments attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: audit_logs audit_logs_actor_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: billing_invoice_seq billing_invoice_seq_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoice_seq
    ADD CONSTRAINT billing_invoice_seq_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: billing_job_runs billing_job_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_job_runs
    ADD CONSTRAINT billing_job_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: billing_job_runs billing_job_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_job_runs
    ADD CONSTRAINT billing_job_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: billing_transactions billing_transactions_billed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_billed_by_fkey FOREIGN KEY (billed_by) REFERENCES public.users(id);


--
-- Name: billing_transactions billing_transactions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: billing_transactions billing_transactions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: billing_transactions billing_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: billing_transactions billing_transactions_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id);


--
-- Name: billing_transactions billing_transactions_rate_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_rate_detail_id_fkey FOREIGN KEY (rate_detail_id) REFERENCES public.client_rate_details(id);


--
-- Name: billing_transactions billing_transactions_rate_master_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_rate_master_id_fkey FOREIGN KEY (rate_master_id) REFERENCES public.client_rate_master(id);


--
-- Name: billing_transactions billing_transactions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: billing_transactions billing_transactions_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_transactions
    ADD CONSTRAINT billing_transactions_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: chart_of_accounts chart_of_accounts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: chart_of_accounts chart_of_accounts_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_parent_account_id_fkey FOREIGN KEY (parent_account_id) REFERENCES public.chart_of_accounts(id);


--
-- Name: client_billing_profile client_billing_profile_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT client_billing_profile_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: client_billing_profile client_billing_profile_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT client_billing_profile_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_billing_profile client_billing_profile_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT client_billing_profile_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: client_billing_profile client_billing_profile_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_profile
    ADD CONSTRAINT client_billing_profile_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: client_contacts client_contacts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts
    ADD CONSTRAINT client_contacts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_contacts client_contacts_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts
    ADD CONSTRAINT client_contacts_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_contracts client_contracts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT client_contracts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: client_contracts client_contracts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT client_contracts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_contracts client_contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT client_contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: client_contracts client_contracts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT client_contracts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: client_documents client_documents_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_documents
    ADD CONSTRAINT client_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_documents client_documents_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_documents
    ADD CONSTRAINT client_documents_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_documents client_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_documents
    ADD CONSTRAINT client_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: client_portal_asn_requests client_portal_asn_requests_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests
    ADD CONSTRAINT client_portal_asn_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: client_portal_asn_requests client_portal_asn_requests_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests
    ADD CONSTRAINT client_portal_asn_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_portal_asn_requests client_portal_asn_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_asn_requests
    ADD CONSTRAINT client_portal_asn_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: client_rate_details client_rate_details_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_rate_details client_rate_details_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: client_rate_details client_rate_details_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: client_rate_details client_rate_details_rate_master_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_rate_master_id_fkey FOREIGN KEY (rate_master_id) REFERENCES public.client_rate_master(id) ON DELETE CASCADE;


--
-- Name: client_rate_details client_rate_details_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_details
    ADD CONSTRAINT client_rate_details_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: client_rate_master client_rate_master_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT client_rate_master_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: client_rate_master client_rate_master_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT client_rate_master_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: client_rate_master client_rate_master_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT client_rate_master_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: client_rate_master client_rate_master_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_rate_master
    ADD CONSTRAINT client_rate_master_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: clients clients_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: clients clients_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: clients clients_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: credit_note_header credit_note_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT credit_note_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: credit_note_header credit_note_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT credit_note_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: credit_note_header credit_note_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT credit_note_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: credit_note_header credit_note_header_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_header
    ADD CONSTRAINT credit_note_header_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id);


--
-- Name: credit_note_lines credit_note_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines
    ADD CONSTRAINT credit_note_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: credit_note_lines credit_note_lines_credit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines
    ADD CONSTRAINT credit_note_lines_credit_note_id_fkey FOREIGN KEY (credit_note_id) REFERENCES public.credit_note_header(id) ON DELETE CASCADE;


--
-- Name: credit_note_lines credit_note_lines_invoice_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_note_lines
    ADD CONSTRAINT credit_note_lines_invoice_line_id_fkey FOREIGN KEY (invoice_line_id) REFERENCES public.invoice_lines(id);


--
-- Name: customer_label_templates customer_label_templates_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates
    ADD CONSTRAINT customer_label_templates_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: customer_label_templates customer_label_templates_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates
    ADD CONSTRAINT customer_label_templates_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: customer_label_templates customer_label_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_label_templates
    ADD CONSTRAINT customer_label_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cycle_count_plans cycle_count_plans_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: cycle_count_plans cycle_count_plans_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: cycle_count_plans cycle_count_plans_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: cycle_count_plans cycle_count_plans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cycle_count_plans cycle_count_plans_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_count_plans
    ADD CONSTRAINT cycle_count_plans_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: daily_kpi_summary daily_kpi_summary_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary
    ADD CONSTRAINT daily_kpi_summary_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: daily_kpi_summary daily_kpi_summary_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary
    ADD CONSTRAINT daily_kpi_summary_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: daily_kpi_summary daily_kpi_summary_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_kpi_summary
    ADD CONSTRAINT daily_kpi_summary_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: debit_note_header debit_note_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT debit_note_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: debit_note_header debit_note_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT debit_note_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: debit_note_header debit_note_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT debit_note_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: debit_note_header debit_note_header_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_header
    ADD CONSTRAINT debit_note_header_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id);


--
-- Name: debit_note_lines debit_note_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines
    ADD CONSTRAINT debit_note_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: debit_note_lines debit_note_lines_debit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines
    ADD CONSTRAINT debit_note_lines_debit_note_id_fkey FOREIGN KEY (debit_note_id) REFERENCES public.debit_note_header(id) ON DELETE CASCADE;


--
-- Name: debit_note_lines debit_note_lines_invoice_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debit_note_lines
    ADD CONSTRAINT debit_note_lines_invoice_line_id_fkey FOREIGN KEY (invoice_line_id) REFERENCES public.invoice_lines(id);


--
-- Name: delivery_note_header delivery_note_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: delivery_note_header delivery_note_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: delivery_note_header delivery_note_header_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: delivery_note_header delivery_note_header_finalized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_finalized_by_fkey FOREIGN KEY (finalized_by) REFERENCES public.users(id);


--
-- Name: delivery_note_header delivery_note_header_load_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_load_id_fkey FOREIGN KEY (load_id) REFERENCES public.outbound_loads(id) ON DELETE CASCADE;


--
-- Name: delivery_note_header delivery_note_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_header
    ADD CONSTRAINT delivery_note_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: delivery_note_lines delivery_note_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines
    ADD CONSTRAINT delivery_note_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: delivery_note_lines delivery_note_lines_delivery_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines
    ADD CONSTRAINT delivery_note_lines_delivery_note_id_fkey FOREIGN KEY (delivery_note_id) REFERENCES public.delivery_note_header(id) ON DELETE CASCADE;


--
-- Name: delivery_note_lines delivery_note_lines_do_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines
    ADD CONSTRAINT delivery_note_lines_do_line_item_id_fkey FOREIGN KEY (do_line_item_id) REFERENCES public.do_line_items(id) ON DELETE CASCADE;


--
-- Name: delivery_note_lines delivery_note_lines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_note_lines
    ADD CONSTRAINT delivery_note_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: do_header do_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: do_header do_header_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_header do_header_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: do_header do_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: do_header do_header_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: do_header do_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_header
    ADD CONSTRAINT do_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: do_line_items do_line_items_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items
    ADD CONSTRAINT do_line_items_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_line_items do_line_items_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items
    ADD CONSTRAINT do_line_items_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: do_line_items do_line_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_line_items
    ADD CONSTRAINT do_line_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: do_pack_unit_serials do_pack_unit_serials_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_pack_unit_serials do_pack_unit_serials_do_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_do_line_item_id_fkey FOREIGN KEY (do_line_item_id) REFERENCES public.do_line_items(id) ON DELETE CASCADE;


--
-- Name: do_pack_unit_serials do_pack_unit_serials_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: do_pack_unit_serials do_pack_unit_serials_pack_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_pack_unit_id_fkey FOREIGN KEY (pack_unit_id) REFERENCES public.do_pack_units(id) ON DELETE CASCADE;


--
-- Name: do_pack_unit_serials do_pack_unit_serials_serial_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_unit_serials
    ADD CONSTRAINT do_pack_unit_serials_serial_id_fkey FOREIGN KEY (serial_id) REFERENCES public.stock_serial_numbers(id);


--
-- Name: do_pack_units do_pack_units_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: do_pack_units do_pack_units_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: do_pack_units do_pack_units_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_pack_units do_pack_units_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: do_pack_units do_pack_units_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: do_pack_units do_pack_units_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: do_pack_units do_pack_units_wave_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pack_units
    ADD CONSTRAINT do_pack_units_wave_id_fkey FOREIGN KEY (wave_id) REFERENCES public.do_wave_header(id) ON DELETE SET NULL;


--
-- Name: do_pick_tasks do_pick_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: do_pick_tasks do_pick_tasks_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: do_pick_tasks do_pick_tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_pick_tasks do_pick_tasks_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: do_pick_tasks do_pick_tasks_do_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_do_line_item_id_fkey FOREIGN KEY (do_line_item_id) REFERENCES public.do_line_items(id) ON DELETE CASCADE;


--
-- Name: do_pick_tasks do_pick_tasks_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: do_pick_tasks do_pick_tasks_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: do_pick_tasks do_pick_tasks_wave_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_pick_tasks
    ADD CONSTRAINT do_pick_tasks_wave_id_fkey FOREIGN KEY (wave_id) REFERENCES public.do_wave_header(id) ON DELETE CASCADE;


--
-- Name: do_wave_header do_wave_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: do_wave_header do_wave_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_wave_header do_wave_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: do_wave_header do_wave_header_released_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);


--
-- Name: do_wave_header do_wave_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_header
    ADD CONSTRAINT do_wave_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: do_wave_orders do_wave_orders_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders
    ADD CONSTRAINT do_wave_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: do_wave_orders do_wave_orders_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders
    ADD CONSTRAINT do_wave_orders_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: do_wave_orders do_wave_orders_wave_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.do_wave_orders
    ADD CONSTRAINT do_wave_orders_wave_id_fkey FOREIGN KEY (wave_id) REFERENCES public.do_wave_header(id) ON DELETE CASCADE;


--
-- Name: edi_transactions edi_transactions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edi_transactions
    ADD CONSTRAINT edi_transactions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: edi_transactions edi_transactions_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edi_transactions
    ADD CONSTRAINT edi_transactions_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: edi_transactions edi_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edi_transactions
    ADD CONSTRAINT edi_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: ff_documents ff_documents_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents
    ADD CONSTRAINT ff_documents_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE SET NULL;


--
-- Name: ff_documents ff_documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents
    ADD CONSTRAINT ff_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: ff_documents ff_documents_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_documents
    ADD CONSTRAINT ff_documents_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.ff_shipments(id) ON DELETE CASCADE;


--
-- Name: ff_milestones ff_milestones_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_milestones
    ADD CONSTRAINT ff_milestones_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: ff_milestones ff_milestones_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_milestones
    ADD CONSTRAINT ff_milestones_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.ff_shipments(id) ON DELETE CASCADE;


--
-- Name: ff_shipment_legs ff_shipment_legs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipment_legs
    ADD CONSTRAINT ff_shipment_legs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: ff_shipment_legs ff_shipment_legs_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipment_legs
    ADD CONSTRAINT ff_shipment_legs_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.ff_shipments(id) ON DELETE CASCADE;


--
-- Name: ff_shipments ff_shipments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT ff_shipments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: ff_shipments ff_shipments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT ff_shipments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: ff_shipments ff_shipments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT ff_shipments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: ff_shipments ff_shipments_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ff_shipments
    ADD CONSTRAINT ff_shipments_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: stock_serial_numbers fk_stock_do_line; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT fk_stock_do_line FOREIGN KEY (do_line_item_id) REFERENCES public.do_line_items(id);


--
-- Name: users fk_users_creator; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_creator FOREIGN KEY (created_by) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: warehouses fk_warehouse_creator; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT fk_warehouse_creator FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: warehouses fk_warehouse_updater; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT fk_warehouse_updater FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: gate_in gate_in_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: gate_in gate_in_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: gate_in gate_in_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: gate_in gate_in_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: gate_in gate_in_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_in
    ADD CONSTRAINT gate_in_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: gate_out gate_out_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: gate_out gate_out_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: gate_out gate_out_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: gate_out gate_out_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id);


--
-- Name: gate_out gate_out_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_out
    ADD CONSTRAINT gate_out_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: goods_issue_header goods_issue_header_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id);


--
-- Name: goods_issue_header goods_issue_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: goods_issue_header goods_issue_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: goods_issue_header goods_issue_header_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: goods_issue_header goods_issue_header_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id);


--
-- Name: goods_issue_header goods_issue_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_header
    ADD CONSTRAINT goods_issue_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: goods_issue_pack_units goods_issue_pack_units_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units
    ADD CONSTRAINT goods_issue_pack_units_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: goods_issue_pack_units goods_issue_pack_units_goods_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units
    ADD CONSTRAINT goods_issue_pack_units_goods_issue_id_fkey FOREIGN KEY (goods_issue_id) REFERENCES public.goods_issue_header(id) ON DELETE CASCADE;


--
-- Name: goods_issue_pack_units goods_issue_pack_units_pack_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_issue_pack_units
    ADD CONSTRAINT goods_issue_pack_units_pack_unit_id_fkey FOREIGN KEY (pack_unit_id) REFERENCES public.do_pack_units(id) ON DELETE CASCADE;


--
-- Name: grn_header grn_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: grn_header grn_header_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: grn_header grn_header_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: grn_header grn_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: grn_header grn_header_gate_in_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_gate_in_id_fkey FOREIGN KEY (gate_in_id) REFERENCES public.gate_in(id);


--
-- Name: grn_header grn_header_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: grn_header grn_header_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_header
    ADD CONSTRAINT grn_header_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: grn_line_items grn_line_items_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: grn_line_items grn_line_items_grn_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_grn_header_id_fkey FOREIGN KEY (grn_header_id) REFERENCES public.grn_header(id) ON DELETE CASCADE;


--
-- Name: grn_line_items grn_line_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: grn_line_items grn_line_items_zone_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_line_items
    ADD CONSTRAINT grn_line_items_zone_layout_id_fkey FOREIGN KEY (zone_layout_id) REFERENCES public.warehouse_zone_layouts(id);


--
-- Name: integration_connector_credentials integration_connector_credentials_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT integration_connector_credentials_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: integration_connector_credentials integration_connector_credentials_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT integration_connector_credentials_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.integration_connectors(id) ON DELETE CASCADE;


--
-- Name: integration_connector_credentials integration_connector_credentials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT integration_connector_credentials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: integration_connector_credentials integration_connector_credentials_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connector_credentials
    ADD CONSTRAINT integration_connector_credentials_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: integration_connectors integration_connectors_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors
    ADD CONSTRAINT integration_connectors_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: integration_connectors integration_connectors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors
    ADD CONSTRAINT integration_connectors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: integration_connectors integration_connectors_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connectors
    ADD CONSTRAINT integration_connectors_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: integration_events integration_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_events
    ADD CONSTRAINT integration_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: integration_events integration_events_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_events
    ADD CONSTRAINT integration_events_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.integration_connectors(id) ON DELETE CASCADE;


--
-- Name: integration_events integration_events_mapping_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_events
    ADD CONSTRAINT integration_events_mapping_id_fkey FOREIGN KEY (mapping_id) REFERENCES public.integration_schema_mappings(id);


--
-- Name: integration_mapping_fields integration_mapping_fields_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_mapping_fields
    ADD CONSTRAINT integration_mapping_fields_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: integration_mapping_fields integration_mapping_fields_mapping_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_mapping_fields
    ADD CONSTRAINT integration_mapping_fields_mapping_id_fkey FOREIGN KEY (mapping_id) REFERENCES public.integration_schema_mappings(id) ON DELETE CASCADE;


--
-- Name: integration_schema_mappings integration_schema_mappings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT integration_schema_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: integration_schema_mappings integration_schema_mappings_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT integration_schema_mappings_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.integration_connectors(id) ON DELETE CASCADE;


--
-- Name: integration_schema_mappings integration_schema_mappings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT integration_schema_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: integration_schema_mappings integration_schema_mappings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_schema_mappings
    ADD CONSTRAINT integration_schema_mappings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: invoice_header invoice_header_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: invoice_header invoice_header_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_header invoice_header_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: invoice_header invoice_header_finalized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_finalized_by_fkey FOREIGN KEY (finalized_by) REFERENCES public.users(id);


--
-- Name: invoice_header invoice_header_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_header
    ADD CONSTRAINT invoice_header_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: invoice_lines invoice_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_lines invoice_lines_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id) ON DELETE CASCADE;


--
-- Name: invoice_payments invoice_payments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_payments invoice_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: invoice_payments invoice_payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id) ON DELETE CASCADE;


--
-- Name: invoice_tax_lines invoice_tax_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_tax_lines
    ADD CONSTRAINT invoice_tax_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_tax_lines invoice_tax_lines_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_tax_lines
    ADD CONSTRAINT invoice_tax_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id) ON DELETE CASCADE;


--
-- Name: invoice_tax_lines invoice_tax_lines_invoice_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_tax_lines
    ADD CONSTRAINT invoice_tax_lines_invoice_line_id_fkey FOREIGN KEY (invoice_line_id) REFERENCES public.invoice_lines(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: invoices invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: item_categories item_categories_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_categories
    ADD CONSTRAINT item_categories_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: item_categories item_categories_parent_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_categories
    ADD CONSTRAINT item_categories_parent_category_id_fkey FOREIGN KEY (parent_category_id) REFERENCES public.item_categories(id);


--
-- Name: items items_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: items items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.item_categories(id);


--
-- Name: items items_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: items items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: items items_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: journal_entries journal_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: journal_entries journal_entries_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES public.users(id);


--
-- Name: journal_lines journal_lines_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id);


--
-- Name: journal_lines journal_lines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: journal_lines journal_lines_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_journal_entry_id_fkey FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;


--
-- Name: labor_productivity_events labor_productivity_events_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.labor_shift_assignments(id);


--
-- Name: labor_productivity_events labor_productivity_events_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: labor_productivity_events labor_productivity_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: labor_productivity_events labor_productivity_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: labor_productivity_events labor_productivity_events_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.labor_shifts(id);


--
-- Name: labor_productivity_events labor_productivity_events_standard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_standard_id_fkey FOREIGN KEY (standard_id) REFERENCES public.labor_standards(id);


--
-- Name: labor_productivity_events labor_productivity_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: labor_productivity_events labor_productivity_events_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_productivity_events
    ADD CONSTRAINT labor_productivity_events_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: labor_shift_assignments labor_shift_assignments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT labor_shift_assignments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: labor_shift_assignments labor_shift_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT labor_shift_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: labor_shift_assignments labor_shift_assignments_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT labor_shift_assignments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.labor_shifts(id) ON DELETE CASCADE;


--
-- Name: labor_shift_assignments labor_shift_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shift_assignments
    ADD CONSTRAINT labor_shift_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: labor_shifts labor_shifts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT labor_shifts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: labor_shifts labor_shifts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT labor_shifts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: labor_shifts labor_shifts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT labor_shifts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: labor_shifts labor_shifts_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_shifts
    ADD CONSTRAINT labor_shifts_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: labor_standards labor_standards_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards
    ADD CONSTRAINT labor_standards_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: labor_standards labor_standards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards
    ADD CONSTRAINT labor_standards_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: labor_standards labor_standards_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_standards
    ADD CONSTRAINT labor_standards_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: mobile_cycle_count_submissions mobile_cycle_count_submissions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_cycle_count_submissions
    ADD CONSTRAINT mobile_cycle_count_submissions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: mobile_cycle_count_tasks mobile_cycle_count_tasks_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_cycle_count_tasks
    ADD CONSTRAINT mobile_cycle_count_tasks_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.cycle_count_plans(id) ON DELETE SET NULL;


--
-- Name: mobile_grn_captures mobile_grn_captures_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures
    ADD CONSTRAINT mobile_grn_captures_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: mobile_grn_captures mobile_grn_captures_approved_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures
    ADD CONSTRAINT mobile_grn_captures_approved_grn_id_fkey FOREIGN KEY (approved_grn_id) REFERENCES public.grn_header(id);


--
-- Name: mobile_grn_captures mobile_grn_captures_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures
    ADD CONSTRAINT mobile_grn_captures_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: mobile_grn_captures mobile_grn_captures_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_grn_captures
    ADD CONSTRAINT mobile_grn_captures_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: mobile_lp_nested mobile_lp_nested_parent_lp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_lp_nested
    ADD CONSTRAINT mobile_lp_nested_parent_lp_id_fkey FOREIGN KEY (parent_lp_id) REFERENCES public.mobile_lp_records(id) ON DELETE CASCADE;


--
-- Name: mobile_packing_lines mobile_packing_lines_confirmation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_packing_lines
    ADD CONSTRAINT mobile_packing_lines_confirmation_id_fkey FOREIGN KEY (confirmation_id) REFERENCES public.mobile_packing_confirmations(id) ON DELETE CASCADE;


--
-- Name: mobile_qc_holds mobile_qc_holds_qc_result_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_qc_holds
    ADD CONSTRAINT mobile_qc_holds_qc_result_id_fkey FOREIGN KEY (qc_result_id) REFERENCES public.mobile_qc_results(id) ON DELETE CASCADE;


--
-- Name: mobile_returns_dispositions mobile_returns_dispositions_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_dispositions
    ADD CONSTRAINT mobile_returns_dispositions_header_id_fkey FOREIGN KEY (header_id) REFERENCES public.mobile_returns_headers(id) ON DELETE CASCADE;


--
-- Name: mobile_returns_lines mobile_returns_lines_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_lines
    ADD CONSTRAINT mobile_returns_lines_header_id_fkey FOREIGN KEY (header_id) REFERENCES public.mobile_returns_headers(id) ON DELETE CASCADE;


--
-- Name: mobile_returns_receipts mobile_returns_receipts_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_returns_receipts
    ADD CONSTRAINT mobile_returns_receipts_header_id_fkey FOREIGN KEY (header_id) REFERENCES public.mobile_returns_headers(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: outbound_load_pack_units outbound_load_pack_units_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units
    ADD CONSTRAINT outbound_load_pack_units_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: outbound_load_pack_units outbound_load_pack_units_load_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units
    ADD CONSTRAINT outbound_load_pack_units_load_id_fkey FOREIGN KEY (load_id) REFERENCES public.outbound_loads(id) ON DELETE CASCADE;


--
-- Name: outbound_load_pack_units outbound_load_pack_units_pack_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_load_pack_units
    ADD CONSTRAINT outbound_load_pack_units_pack_unit_id_fkey FOREIGN KEY (pack_unit_id) REFERENCES public.do_pack_units(id) ON DELETE CASCADE;


--
-- Name: outbound_loads outbound_loads_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: outbound_loads outbound_loads_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: outbound_loads outbound_loads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: outbound_loads outbound_loads_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id) ON DELETE CASCADE;


--
-- Name: outbound_loads outbound_loads_goods_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_goods_issue_id_fkey FOREIGN KEY (goods_issue_id) REFERENCES public.goods_issue_header(id) ON DELETE SET NULL;


--
-- Name: outbound_loads outbound_loads_loaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_loaded_by_fkey FOREIGN KEY (loaded_by) REFERENCES public.users(id);


--
-- Name: outbound_loads outbound_loads_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_loads
    ADD CONSTRAINT outbound_loads_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: portal_client_sla_policies portal_client_sla_policies_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT portal_client_sla_policies_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: portal_client_sla_policies portal_client_sla_policies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT portal_client_sla_policies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_client_sla_policies portal_client_sla_policies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT portal_client_sla_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: portal_client_sla_policies portal_client_sla_policies_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_client_sla_policies
    ADD CONSTRAINT portal_client_sla_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: portal_invoice_actions portal_invoice_actions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions
    ADD CONSTRAINT portal_invoice_actions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: portal_invoice_actions portal_invoice_actions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions
    ADD CONSTRAINT portal_invoice_actions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_actions portal_invoice_actions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions
    ADD CONSTRAINT portal_invoice_actions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_actions portal_invoice_actions_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_actions
    ADD CONSTRAINT portal_invoice_actions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_dispute_events portal_invoice_dispute_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_dispute_events
    ADD CONSTRAINT portal_invoice_dispute_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: portal_invoice_dispute_events portal_invoice_dispute_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_dispute_events
    ADD CONSTRAINT portal_invoice_dispute_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_dispute_events portal_invoice_dispute_events_dispute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_dispute_events
    ADD CONSTRAINT portal_invoice_dispute_events_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES public.portal_invoice_disputes(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_disputes portal_invoice_disputes_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: portal_invoice_disputes portal_invoice_disputes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_disputes portal_invoice_disputes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_disputes portal_invoice_disputes_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice_header(id) ON DELETE CASCADE;


--
-- Name: portal_invoice_disputes portal_invoice_disputes_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_invoice_disputes
    ADD CONSTRAINT portal_invoice_disputes_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.users(id);


--
-- Name: portal_user_clients portal_user_clients_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients
    ADD CONSTRAINT portal_user_clients_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: portal_user_clients portal_user_clients_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients
    ADD CONSTRAINT portal_user_clients_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: portal_user_clients portal_user_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_clients
    ADD CONSTRAINT portal_user_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: portal_user_invites portal_user_invites_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites
    ADD CONSTRAINT portal_user_invites_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_user_invites portal_user_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites
    ADD CONSTRAINT portal_user_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_user_invites portal_user_invites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_invites
    ADD CONSTRAINT portal_user_invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: portal_user_permissions portal_user_permissions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_permissions
    ADD CONSTRAINT portal_user_permissions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_user_permissions portal_user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_user_permissions
    ADD CONSTRAINT portal_user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: printed_labels_log printed_labels_log_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log
    ADD CONSTRAINT printed_labels_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: printed_labels_log printed_labels_log_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log
    ADD CONSTRAINT printed_labels_log_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: printed_labels_log printed_labels_log_printed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log
    ADD CONSTRAINT printed_labels_log_printed_by_fkey FOREIGN KEY (printed_by) REFERENCES public.users(id);


--
-- Name: printed_labels_log printed_labels_log_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printed_labels_log
    ADD CONSTRAINT printed_labels_log_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.customer_label_templates(id);


--
-- Name: rbac_role_permissions rbac_role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permissions
    ADD CONSTRAINT rbac_role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.rbac_permissions(id) ON DELETE CASCADE;


--
-- Name: rbac_role_permissions rbac_role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permissions
    ADD CONSTRAINT rbac_role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.rbac_roles(id) ON DELETE CASCADE;


--
-- Name: rbac_user_roles rbac_user_roles_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_user_roles
    ADD CONSTRAINT rbac_user_roles_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: rbac_user_roles rbac_user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_user_roles
    ADD CONSTRAINT rbac_user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.rbac_roles(id) ON DELETE CASCADE;


--
-- Name: rbac_user_roles rbac_user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_user_roles
    ADD CONSTRAINT rbac_user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sequence_counters sequence_counters_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_counters
    ADD CONSTRAINT sequence_counters_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: sequence_counters sequence_counters_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_counters
    ADD CONSTRAINT sequence_counters_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_movements stock_movements_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: stock_movements stock_movements_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_movements stock_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: stock_movements stock_movements_do_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_do_header_id_fkey FOREIGN KEY (do_header_id) REFERENCES public.do_header(id);


--
-- Name: stock_movements stock_movements_do_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_do_line_id_fkey FOREIGN KEY (do_line_id) REFERENCES public.do_line_items(id);


--
-- Name: stock_movements stock_movements_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_movements stock_movements_from_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_from_zone_id_fkey FOREIGN KEY (from_zone_id) REFERENCES public.warehouse_zones(id);


--
-- Name: stock_movements stock_movements_gate_in_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_gate_in_id_fkey FOREIGN KEY (gate_in_id) REFERENCES public.gate_in(id);


--
-- Name: stock_movements stock_movements_gate_out_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_gate_out_id_fkey FOREIGN KEY (gate_out_id) REFERENCES public.gate_out(id);


--
-- Name: stock_movements stock_movements_grn_header_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_grn_header_id_fkey FOREIGN KEY (grn_header_id) REFERENCES public.grn_header(id);


--
-- Name: stock_movements stock_movements_grn_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_grn_line_id_fkey FOREIGN KEY (grn_line_id) REFERENCES public.grn_line_items(id);


--
-- Name: stock_movements stock_movements_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_movements stock_movements_reversed_by_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_reversed_by_movement_id_fkey FOREIGN KEY (reversed_by_movement_id) REFERENCES public.stock_movements(id);


--
-- Name: stock_movements stock_movements_serial_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_serial_number_id_fkey FOREIGN KEY (serial_number_id) REFERENCES public.stock_serial_numbers(id) ON DELETE RESTRICT;


--
-- Name: stock_movements stock_movements_to_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_movements stock_movements_to_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_to_zone_id_fkey FOREIGN KEY (to_zone_id) REFERENCES public.warehouse_zones(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_from_zone_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_from_zone_layout_id_fkey FOREIGN KEY (from_zone_layout_id) REFERENCES public.warehouse_zone_layouts(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_moved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_moved_by_fkey FOREIGN KEY (moved_by) REFERENCES public.users(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_stock_serial_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_stock_serial_id_fkey FOREIGN KEY (stock_serial_id) REFERENCES public.stock_serial_numbers(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_to_zone_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_to_zone_layout_id_fkey FOREIGN KEY (to_zone_layout_id) REFERENCES public.warehouse_zone_layouts(id);


--
-- Name: stock_putaway_movements stock_putaway_movements_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_putaway_movements
    ADD CONSTRAINT stock_putaway_movements_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_grn_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_grn_line_item_id_fkey FOREIGN KEY (grn_line_item_id) REFERENCES public.grn_line_items(id) ON DELETE CASCADE;


--
-- Name: stock_serial_numbers stock_serial_numbers_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_lp_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_lp_record_id_fkey FOREIGN KEY (lp_record_id) REFERENCES public.mobile_lp_records(id) ON DELETE SET NULL;


--
-- Name: stock_serial_numbers stock_serial_numbers_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.warehouse_zones(id);


--
-- Name: stock_serial_numbers stock_serial_numbers_zone_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_serial_numbers
    ADD CONSTRAINT stock_serial_numbers_zone_layout_id_fkey FOREIGN KEY (zone_layout_id) REFERENCES public.warehouse_zone_layouts(id);


--
-- Name: storage_snapshot storage_snapshot_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot
    ADD CONSTRAINT storage_snapshot_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: storage_snapshot storage_snapshot_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot
    ADD CONSTRAINT storage_snapshot_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: storage_snapshot storage_snapshot_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot
    ADD CONSTRAINT storage_snapshot_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: storage_snapshot storage_snapshot_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshot
    ADD CONSTRAINT storage_snapshot_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: system_settings system_settings_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: system_settings system_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: tenant_products tenant_products_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products
    ADD CONSTRAINT tenant_products_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: tenant_products tenant_products_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products
    ADD CONSTRAINT tenant_products_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: tenant_products tenant_products_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_products
    ADD CONSTRAINT tenant_products_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: tenant_settings tenant_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: tenant_settings tenant_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: user_scopes user_scopes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_scopes user_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: users users_putaway_pin_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_putaway_pin_set_by_fkey FOREIGN KEY (putaway_pin_set_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: warehouse_zone_layouts warehouse_zone_layouts_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zone_layouts
    ADD CONSTRAINT warehouse_zone_layouts_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: warehouse_zone_layouts warehouse_zone_layouts_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zone_layouts
    ADD CONSTRAINT warehouse_zone_layouts_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: warehouse_zone_layouts warehouse_zone_layouts_warehouse_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zone_layouts
    ADD CONSTRAINT warehouse_zone_layouts_warehouse_zone_id_fkey FOREIGN KEY (warehouse_zone_id) REFERENCES public.warehouse_zones(id);


--
-- Name: warehouse_zones warehouse_zones_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zones
    ADD CONSTRAINT warehouse_zones_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: warehouse_zones warehouse_zones_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_zones
    ADD CONSTRAINT warehouse_zones_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON DELETE CASCADE;


--
-- Name: warehouses warehouses_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: wes_command_queue wes_command_queue_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_command_queue
    ADD CONSTRAINT wes_command_queue_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: wes_command_queue wes_command_queue_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_command_queue
    ADD CONSTRAINT wes_command_queue_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.wes_equipment(id) ON DELETE CASCADE;


--
-- Name: wes_command_queue wes_command_queue_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_command_queue
    ADD CONSTRAINT wes_command_queue_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: wes_equipment wes_equipment_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: wes_equipment wes_equipment_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wes_equipment wes_equipment_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: wes_equipment wes_equipment_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: wes_equipment wes_equipment_zone_layout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_equipment
    ADD CONSTRAINT wes_equipment_zone_layout_id_fkey FOREIGN KEY (zone_layout_id) REFERENCES public.warehouse_zone_layouts(id);


--
-- Name: wes_event_log wes_event_log_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_event_log
    ADD CONSTRAINT wes_event_log_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.wes_command_queue(id) ON DELETE SET NULL;


--
-- Name: wes_event_log wes_event_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_event_log
    ADD CONSTRAINT wes_event_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: wes_event_log wes_event_log_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_event_log
    ADD CONSTRAINT wes_event_log_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.wes_equipment(id) ON DELETE SET NULL;


--
-- Name: wes_failover_incidents wes_failover_incidents_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents
    ADD CONSTRAINT wes_failover_incidents_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.wes_command_queue(id) ON DELETE SET NULL;


--
-- Name: wes_failover_incidents wes_failover_incidents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents
    ADD CONSTRAINT wes_failover_incidents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: wes_failover_incidents wes_failover_incidents_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents
    ADD CONSTRAINT wes_failover_incidents_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.wes_equipment(id) ON DELETE SET NULL;


--
-- Name: wes_failover_incidents wes_failover_incidents_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wes_failover_incidents
    ADD CONSTRAINT wes_failover_incidents_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: workforce_tasks workforce_tasks_company_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_tasks
    ADD CONSTRAINT workforce_tasks_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: workforce_tasks workforce_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_tasks
    ADD CONSTRAINT workforce_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: workforce_tasks workforce_tasks_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_tasks
    ADD CONSTRAINT workforce_tasks_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: asn_carton_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asn_carton_details ENABLE ROW LEVEL SECURITY;

--
-- Name: asn_carton_details asn_carton_details_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asn_carton_details_tenant_isolation ON public.asn_carton_details USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: asn_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asn_header ENABLE ROW LEVEL SECURITY;

--
-- Name: asn_header asn_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asn_header_tenant_isolation ON public.asn_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: asn_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asn_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: asn_line_items asn_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY asn_line_items_tenant_isolation ON public.asn_line_items USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: billing_invoice_seq; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_invoice_seq ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_invoice_seq billing_invoice_seq_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_invoice_seq_tenant_isolation ON public.billing_invoice_seq USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: billing_job_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_job_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_job_runs billing_job_runs_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_job_runs_tenant_isolation ON public.billing_job_runs USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: billing_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_transactions billing_transactions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_transactions_tenant_isolation ON public.billing_transactions USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_billing_profile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_billing_profile ENABLE ROW LEVEL SECURITY;

--
-- Name: client_billing_profile client_billing_profile_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_billing_profile_tenant_isolation ON public.client_billing_profile USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: client_contacts client_contacts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_contacts_tenant_isolation ON public.client_contacts USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: client_contracts client_contracts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_contracts_tenant_isolation ON public.client_contracts USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: client_documents client_documents_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_documents_tenant_isolation ON public.client_documents USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_rate_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_rate_details ENABLE ROW LEVEL SECURITY;

--
-- Name: client_rate_details client_rate_details_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_rate_details_tenant_isolation ON public.client_rate_details USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: client_rate_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_rate_master ENABLE ROW LEVEL SECURITY;

--
-- Name: client_rate_master client_rate_master_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_rate_master_tenant_isolation ON public.client_rate_master USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

--
-- Name: clients clients_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_tenant_isolation ON public.clients USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: credit_note_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_note_header ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note_header credit_note_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_note_header_tenant_isolation ON public.credit_note_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: credit_note_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_note_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note_lines credit_note_lines_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_note_lines_tenant_isolation ON public.credit_note_lines USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: customer_label_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_label_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_label_templates customer_label_templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customer_label_templates_tenant_isolation ON public.customer_label_templates USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: daily_kpi_summary; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_kpi_summary ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_kpi_summary daily_kpi_summary_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY daily_kpi_summary_tenant_isolation ON public.daily_kpi_summary USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: debit_note_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.debit_note_header ENABLE ROW LEVEL SECURITY;

--
-- Name: debit_note_header debit_note_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debit_note_header_tenant_isolation ON public.debit_note_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: debit_note_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.debit_note_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: debit_note_lines debit_note_lines_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY debit_note_lines_tenant_isolation ON public.debit_note_lines USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: delivery_note_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_note_header ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_note_header delivery_note_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_note_header_tenant_isolation ON public.delivery_note_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: delivery_note_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_note_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_note_lines delivery_note_lines_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_note_lines_tenant_isolation ON public.delivery_note_lines USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_header ENABLE ROW LEVEL SECURITY;

--
-- Name: do_header do_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_header_tenant_isolation ON public.do_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: do_line_items do_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_line_items_tenant_isolation ON public.do_line_items USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_pack_unit_serials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_pack_unit_serials ENABLE ROW LEVEL SECURITY;

--
-- Name: do_pack_unit_serials do_pack_unit_serials_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_pack_unit_serials_tenant_isolation ON public.do_pack_unit_serials USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_pack_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_pack_units ENABLE ROW LEVEL SECURITY;

--
-- Name: do_pack_units do_pack_units_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_pack_units_tenant_isolation ON public.do_pack_units USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_pick_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_pick_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: do_pick_tasks do_pick_tasks_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_pick_tasks_tenant_isolation ON public.do_pick_tasks USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_wave_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_wave_header ENABLE ROW LEVEL SECURITY;

--
-- Name: do_wave_header do_wave_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_wave_header_tenant_isolation ON public.do_wave_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: do_wave_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.do_wave_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: do_wave_orders do_wave_orders_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY do_wave_orders_tenant_isolation ON public.do_wave_orders USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: edi_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.edi_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: edi_transactions edi_transactions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY edi_transactions_tenant_isolation ON public.edi_transactions USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: ff_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ff_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: ff_documents ff_documents_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ff_documents_tenant_isolation ON public.ff_documents USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: ff_milestones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ff_milestones ENABLE ROW LEVEL SECURITY;

--
-- Name: ff_milestones ff_milestones_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ff_milestones_tenant_isolation ON public.ff_milestones USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: ff_shipment_legs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ff_shipment_legs ENABLE ROW LEVEL SECURITY;

--
-- Name: ff_shipment_legs ff_shipment_legs_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ff_shipment_legs_tenant_isolation ON public.ff_shipment_legs USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: ff_shipments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ff_shipments ENABLE ROW LEVEL SECURITY;

--
-- Name: ff_shipments ff_shipments_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ff_shipments_tenant_isolation ON public.ff_shipments USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: gate_in; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_in ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_in gate_in_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gate_in_tenant_isolation ON public.gate_in USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: gate_out; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_out ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_out gate_out_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gate_out_tenant_isolation ON public.gate_out USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: goods_issue_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goods_issue_header ENABLE ROW LEVEL SECURITY;

--
-- Name: goods_issue_header goods_issue_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goods_issue_header_tenant_isolation ON public.goods_issue_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: goods_issue_pack_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goods_issue_pack_units ENABLE ROW LEVEL SECURITY;

--
-- Name: goods_issue_pack_units goods_issue_pack_units_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY goods_issue_pack_units_tenant_isolation ON public.goods_issue_pack_units USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: grn_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grn_header ENABLE ROW LEVEL SECURITY;

--
-- Name: grn_header grn_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grn_header_tenant_isolation ON public.grn_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: grn_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grn_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: grn_line_items grn_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grn_line_items_tenant_isolation ON public.grn_line_items USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: integration_connector_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_connector_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_connector_credentials integration_connector_credentials_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_connector_credentials_tenant_isolation ON public.integration_connector_credentials USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: integration_connectors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_connectors ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_connectors integration_connectors_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_connectors_tenant_isolation ON public.integration_connectors USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: integration_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_events ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_events integration_events_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_events_tenant_isolation ON public.integration_events USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: integration_mapping_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_mapping_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_mapping_fields integration_mapping_fields_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_mapping_fields_tenant_isolation ON public.integration_mapping_fields USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: integration_schema_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_schema_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_schema_mappings integration_schema_mappings_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_schema_mappings_tenant_isolation ON public.integration_schema_mappings USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: invoice_header; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_header ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_header invoice_header_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoice_header_tenant_isolation ON public.invoice_header USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: invoice_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_lines invoice_lines_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoice_lines_tenant_isolation ON public.invoice_lines USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: invoice_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_payments invoice_payments_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoice_payments_tenant_isolation ON public.invoice_payments USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: invoice_tax_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_tax_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_tax_lines invoice_tax_lines_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoice_tax_lines_tenant_isolation ON public.invoice_tax_lines USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: item_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: item_categories item_categories_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_categories_tenant_isolation ON public.item_categories USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

--
-- Name: items items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_tenant_isolation ON public.items USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: labor_productivity_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_productivity_events ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_productivity_events labor_productivity_events_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY labor_productivity_events_tenant_isolation ON public.labor_productivity_events USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: labor_shift_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_shift_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_shift_assignments labor_shift_assignments_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY labor_shift_assignments_tenant_isolation ON public.labor_shift_assignments USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: labor_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_shifts labor_shifts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY labor_shifts_tenant_isolation ON public.labor_shifts USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: labor_standards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_standards ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_standards labor_standards_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY labor_standards_tenant_isolation ON public.labor_standards USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: mobile_grn_captures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mobile_grn_captures ENABLE ROW LEVEL SECURITY;

--
-- Name: mobile_grn_captures mobile_grn_captures_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mobile_grn_captures_tenant_isolation ON public.mobile_grn_captures USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_tenant_isolation ON public.notifications USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: outbound_load_pack_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbound_load_pack_units ENABLE ROW LEVEL SECURITY;

--
-- Name: outbound_load_pack_units outbound_load_pack_units_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outbound_load_pack_units_tenant_isolation ON public.outbound_load_pack_units USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: outbound_loads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbound_loads ENABLE ROW LEVEL SECURITY;

--
-- Name: outbound_loads outbound_loads_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outbound_loads_tenant_isolation ON public.outbound_loads USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: portal_client_sla_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_client_sla_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_client_sla_policies portal_client_sla_policies_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portal_client_sla_policies_tenant_isolation ON public.portal_client_sla_policies USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: portal_invoice_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_invoice_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_invoice_actions portal_invoice_actions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portal_invoice_actions_tenant_isolation ON public.portal_invoice_actions USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: portal_invoice_dispute_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_invoice_dispute_events ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_invoice_dispute_events portal_invoice_dispute_events_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portal_invoice_dispute_events_tenant_isolation ON public.portal_invoice_dispute_events USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: portal_invoice_disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_invoice_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_invoice_disputes portal_invoice_disputes_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portal_invoice_disputes_tenant_isolation ON public.portal_invoice_disputes USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: printed_labels_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.printed_labels_log ENABLE ROW LEVEL SECURITY;

--
-- Name: printed_labels_log printed_labels_log_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY printed_labels_log_tenant_isolation ON public.printed_labels_log USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: sequence_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sequence_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: sequence_counters sequence_counters_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sequence_counters_tenant_isolation ON public.sequence_counters USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements stock_movements_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_movements_tenant_isolation ON public.stock_movements USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: stock_putaway_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_putaway_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_putaway_movements stock_putaway_movements_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_putaway_movements_tenant_isolation ON public.stock_putaway_movements USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: stock_serial_numbers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_serial_numbers ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_serial_numbers stock_serial_numbers_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_serial_numbers_tenant_isolation ON public.stock_serial_numbers USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: storage_snapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_snapshot storage_snapshot_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY storage_snapshot_tenant_isolation ON public.storage_snapshot USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings system_settings_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY system_settings_tenant_isolation ON public.system_settings USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: tenant_products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_products ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_products tenant_products_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_products_tenant_isolation ON public.tenant_products USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: warehouse_zone_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouse_zone_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouse_zone_layouts warehouse_zone_layouts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY warehouse_zone_layouts_tenant_isolation ON public.warehouse_zone_layouts USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: warehouse_zones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouse_zones ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouse_zones warehouse_zones_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY warehouse_zones_tenant_isolation ON public.warehouse_zones USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: warehouses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouses warehouses_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY warehouses_tenant_isolation ON public.warehouses USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: wes_command_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wes_command_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: wes_command_queue wes_command_queue_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wes_command_queue_tenant_isolation ON public.wes_command_queue USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: wes_equipment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wes_equipment ENABLE ROW LEVEL SECURITY;

--
-- Name: wes_equipment wes_equipment_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wes_equipment_tenant_isolation ON public.wes_equipment USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: wes_event_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wes_event_log ENABLE ROW LEVEL SECURITY;

--
-- Name: wes_event_log wes_event_log_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wes_event_log_tenant_isolation ON public.wes_event_log USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: wes_failover_incidents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wes_failover_incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: wes_failover_incidents wes_failover_incidents_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wes_failover_incidents_tenant_isolation ON public.wes_failover_incidents USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- Name: workforce_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_tasks workforce_tasks_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_tasks_tenant_isolation ON public.workforce_tasks USING ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer)) WITH CHECK ((company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::integer));


--
-- PostgreSQL database dump complete
--

\unrestrict V9cKZ0KGIacLnkyr0aOlDQJNLiQHIBfep4lO7U0PetxOBRwjHxbgzSqdeNSu0LK

