DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    BEGIN
      GRANT USAGE ON SCHEMA public TO wms_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO wms_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO wms_app;

      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'mobile_lp_records'
      ) THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_lp_records TO wms_app;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.sequences
        WHERE sequence_schema = 'public' AND sequence_name = 'mobile_lp_records_id_seq'
      ) THEN
        GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.mobile_lp_records_id_seq TO wms_app;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped grant hardening in 041 due to insufficient_privilege';
    END;
  END IF;
END
$$;
