-- Per-supervisor PIN for the mobile put-away bin-mismatch override.
--
-- Until now the override PIN was validated nowhere: wms-mobile-api only checked
-- that the submitted string was >= 4 chars (putaway.service.ts), so ANY 4-digit
-- value authorised an override. This adds a real, per-user credential so that an
-- override can only be approved by a specific supervisor, and every override is
-- attributable to the approving user.
--
-- The PIN lives on public.users (the canonical, shared user record) so Admins
-- manage it through the existing web user console -- one column, no new table.
-- It is stored as a bcrypt hash (never plaintext); the mobile-api reads it
-- server-side only via bcrypt.compare and never returns it to a client.
--
-- Only users whose role is in the approver set (SUPERVISOR, WAREHOUSE_MANAGER,
-- ADMIN, SUPER_ADMIN -- see 010_allow_super_admin_role.sql) are considered when
-- verifying an override PIN; the column existing on other rows is harmless.
--
-- No explicit GRANT is needed: wms_mobile_app inherits table privileges on
-- public.users from the wms_migrator default-privileges rule, and column
-- privileges follow the table grant.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS putaway_pin_hash   TEXT,
  ADD COLUMN IF NOT EXISTS putaway_pin_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS putaway_pin_set_by INTEGER;

-- Who last set/reset the PIN (an Admin's users.id), for audit. Loose reference
-- -- ON DELETE SET NULL so removing an admin never blocks a supervisor's PIN.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_putaway_pin_set_by_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_putaway_pin_set_by_fkey
      FOREIGN KEY (putaway_pin_set_by) REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Fast lookup of "active approver users in this company that have a PIN set",
-- which is exactly the set the override-verification query scans.
CREATE INDEX IF NOT EXISTS users_putaway_pin_approver_idx
  ON users (company_id)
  WHERE putaway_pin_hash IS NOT NULL
    AND role IN ('SUPERVISOR', 'WAREHOUSE_MANAGER', 'ADMIN', 'SUPER_ADMIN');

COMMIT;
