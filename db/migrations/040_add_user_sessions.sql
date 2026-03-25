CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL DEFAULT 'web',
  device_id VARCHAR(120),
  device_name VARCHAR(160),
  ip_address VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  revoked_reason VARCHAR(80) NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_user_sessions_actor_type'
  ) THEN
    ALTER TABLE user_sessions
      ADD CONSTRAINT ck_user_sessions_actor_type
      CHECK (actor_type IN ('web', 'mobile', 'portal', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON user_sessions(user_id, revoked_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sessions_company_active
  ON user_sessions(company_id, revoked_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen
  ON user_sessions(last_seen_at DESC);
