BEGIN;

DO $$
DECLARE
  v_table text;
  v_policy text;
  v_tables text[] := ARRAY[
    'tenant_products',
    'ff_shipments',
    'ff_shipment_legs',
    'ff_milestones',
    'ff_documents'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      v_policy := v_table || '_tenant_isolation';

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy, v_table);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL USING (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER) WITH CHECK (company_id = NULLIF(current_setting(''app.company_id'', true), '''')::INTEGER)',
        v_policy,
        v_table
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
