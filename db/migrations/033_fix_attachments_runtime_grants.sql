BEGIN;

DO $$
BEGIN
  -- Ensure runtime role can resolve objects under public schema.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT USAGE ON SCHEMA public TO wms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attachments TO wms_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.attachments_id_seq TO wms_app;
  END IF;

  -- CI/local fallback role used in some setups.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms') THEN
    GRANT USAGE ON SCHEMA public TO wms;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attachments TO wms;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.attachments_id_seq TO wms;
  END IF;
END
$$;

COMMIT;
