-- Align legacy table triggers with the tenant-aware audit_logs schema.
CREATE OR REPLACE FUNCTION public.audit_log_function()
RETURNS trigger
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
    (SELECT id FROM companies ORDER BY id LIMIT 1)
  );

  INSERT INTO audit_logs (
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
