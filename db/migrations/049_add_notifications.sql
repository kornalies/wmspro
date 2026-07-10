-- Notifications feed surfaced in the web app. Rows are written either by this app
-- (web-originated events) or directly by wms-mobile-api (mobile-originated events,
-- e.g. GRN capture submitted, gate scan, sync failure) -- see docs/notifications-contract.md.
-- Every row targets exactly one user_id; a notification meant for several users
-- (e.g. "all approvers") is fan-out inserted as one row per recipient rather than
-- a single shared row, since read_at is per-row and a shared row would mean one
-- user's "mark as read" hides it for everyone else too.

BEGIN;

CREATE TABLE IF NOT EXISTS public.notifications (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'mobile',
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id, read_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_company_created_at
  ON public.notifications (company_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_tenant_isolation ON public.notifications;
CREATE POLICY notifications_tenant_isolation ON public.notifications
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

-- Owned by wms_migrator, matching every other migration-managed table -- lets
-- wms-mobile-api's app role be granted only INSERT (no ownership) on this table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_migrator') THEN
    ALTER TABLE public.notifications OWNER TO wms_migrator;
  END IF;
END
$$;

COMMIT;