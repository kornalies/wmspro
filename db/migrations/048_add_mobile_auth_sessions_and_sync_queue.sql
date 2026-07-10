-- Formalizes two tables that wms-mobile-api previously created ad hoc at runtime
-- (CREATE TABLE IF NOT EXISTS on every request/interval tick), which required granting
-- CREATE ON SCHEMA public to its app role. Moving them here lets that grant be revoked --
-- every other mobile_* table already follows this pattern, owned by wms_migrator.

CREATE TABLE IF NOT EXISTS public.mobile_auth_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  actor_type VARCHAR(20) NOT NULL DEFAULT 'mobile',
  refresh_jti TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITHOUT TIME ZONE NULL,
  revoked_at TIMESTAMP WITHOUT TIME ZONE NULL,
  revoke_reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_user
  ON public.mobile_auth_sessions (user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_company
  ON public.mobile_auth_sessions (company_id, revoked_at);

CREATE TABLE IF NOT EXISTS public.mobile_sync_task_queue (
  id BIGSERIAL PRIMARY KEY,
  company_code TEXT NOT NULL,
  client_id BIGINT NULL,
  warehouse_id BIGINT NULL,
  worker_id BIGINT NULL,
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_sync_task_queue_status_created_at
  ON public.mobile_sync_task_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_mobile_sync_task_queue_company_code
  ON public.mobile_sync_task_queue (company_code);

-- Both tables may already exist (created ad hoc by wms-mobile-api before this migration
-- existed) and owned by whatever role ran the app at the time -- reassign to the migrator
-- role so ownership matches every other table this migration system manages.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_migrator') THEN
    ALTER TABLE public.mobile_auth_sessions OWNER TO wms_migrator;
    ALTER TABLE public.mobile_sync_task_queue OWNER TO wms_migrator;
  END IF;
END
$$;
