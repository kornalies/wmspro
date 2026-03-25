BEGIN;

CREATE TABLE IF NOT EXISTS portal_user_permissions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key VARCHAR(80) NOT NULL,
  is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_portal_user_permissions_company_user_feature UNIQUE (company_id, user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_permissions_lookup
  ON portal_user_permissions(company_id, user_id, feature_key, is_allowed);

CREATE TABLE IF NOT EXISTS portal_user_invites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_token VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP NULL,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_portal_user_invites_company_token UNIQUE (company_id, invite_token)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_invites_lookup
  ON portal_user_invites(company_id, user_id, status, expires_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_portal_user_invites_status'
  ) THEN
    ALTER TABLE portal_user_invites
      ADD CONSTRAINT ck_portal_user_invites_status
      CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED'));
  END IF;
END $$;

COMMIT;
