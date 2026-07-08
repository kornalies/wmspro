-- wms_mobile_app (the role wms-mobile-api connects as) already gets SELECT/INSERT/
-- UPDATE/DELETE on notifications automatically, inherited from an existing
-- ALTER DEFAULT PRIVILEGES ... FOR ROLE wms_migrator rule that applies to every
-- table wms_migrator creates. That's broader than intended: per
-- docs/notifications-contract.md, mobile should only ever SELECT/INSERT --
-- read_at is web-owned, and mobile has no business deleting a notification it
-- already sent. Revoke the two privileges the default rule over-grants so the
-- actual permission surface for this table matches the documented contract,
-- without touching the schema-wide default-privileges rule itself (out of scope
-- here -- it governs every other table wms_migrator creates, not just this one).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_mobile_app') THEN
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'notifications'
      ) THEN
        REVOKE UPDATE, DELETE ON TABLE public.notifications FROM wms_mobile_app;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped grant hardening in 050 due to insufficient_privilege';
    END;
  END IF;
END
$$;
