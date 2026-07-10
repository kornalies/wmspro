# Notifications Contract (v1)

The web app (`wms-frontend`) reads user notifications from a single shared Postgres
table, `public.notifications` (see `db/migrations/049_add_notifications.sql`).
Mobile-originated events are written directly into this table by `wms-mobile-api`
(or whatever service owns the mobile-side action) -- there is no HTTP call from
mobile into `wms-frontend` for this.

## Table

```
notifications (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  source        TEXT NOT NULL DEFAULT 'mobile',
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  read_at       TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

## Rules for writers

- **One row per recipient.** `user_id` is required and a notification is never
  shared across users -- `read_at` lives on the row, so a shared row would let
  one user's "mark as read" hide it for everyone else. If an event should notify
  several people (e.g. all users with `grn.mobile.approve`), insert one row per
  `user_id`.
- **Row Level Security is enabled** on this table (`company_id` tenant isolation,
  same policy shape as `mobile_grn_captures` and other tenant tables). Any writer
  must either run as a role that sets `app.company_id` via
  `SELECT set_config('app.company_id', $1, true)` before inserting, or hold a
  role that bypasses RLS with the insert already scoped correctly by `company_id`.
- `source` should identify the origin, e.g. `'mobile'`, `'gate'`, `'web'`.
- `type` is a free-form dot-namespaced string for future filtering, e.g.
  `'grn.mobile_capture.submitted'`, `'do.mobile_scan.completed'`.
- `data` is an opaque JSON payload the web UI does not currently deep-link from,
  but should carry enough to build one later (e.g. `{ "capture_id": 101 }`).
- `title`/`body` are shown as-is in the web UI -- keep `title` short (fits one
  line in a 320px dropdown).

## Example insert (mobile GRN capture submitted, notifying one approver)

```sql
SELECT set_config('app.company_id', '1', true);

INSERT INTO notifications (company_id, user_id, source, type, title, body, data)
VALUES (
  1, 42, 'mobile',
  'grn.mobile_capture.submitted',
  'New mobile GRN capture pending approval',
  'MGRN-2026-12345678 from ABC Supplier',
  '{"capture_id": 101}'::jsonb
);
```

## Web-side API (this repo)

- `GET /api/notifications?status=unread|all&limit=` -- list for the current session user
- `GET /api/notifications/unread-count` -- badge count
- `POST /api/notifications/:id/read` -- mark one read
- `POST /api/notifications/read-all` -- mark all read

The web app polls these every 20s (`hooks/use-notifications.ts`); there is no
push/WebSocket channel in this v1.
