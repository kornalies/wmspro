# Schema baseline

`db/migrations/001_add_grn_manual_fields.sql` opens with an `ALTER TABLE grn_header`.
The numbered migrations have never contained the base schema — they have only ever
patched a database that already existed. Running `npm run db:migrate` against an empty
database therefore fails on the first file, and **a clean install has never been
possible from this repository alone**.

This directory is the missing half:

| File | Contents |
| --- | --- |
| `schema.sql` | `pg_dump --schema-only --no-owner --no-privileges --schema=public` of the live schema |
| `schema_migrations.sql` | the `schema_migrations` rows, so the migrator treats 001–068 as already applied |

## Standing up an empty database

```sh
psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/baseline/schema.sql
psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/baseline/schema_migrations.sql
npm run db:migrate   # applies only migrations newer than the baseline
npm run db:seed
```

Grants are deliberately **not** in the dump (`--no-privileges`). The application role
is granted separately — see the `db-suites` job in `.github/workflows/ci.yml` — because
role names differ per environment (`wms_app` locally, `wms` in CI).

## Refreshing it

Only when the baseline drifts far enough behind that CI is applying a long tail of
migrations. Re-dump from a database that is fully migrated and has no local
experiments in it:

```sh
pg_dump --schema-only --no-owner --no-privileges --no-comments --schema=public \
  --file=db/baseline/schema.sql "$MIGRATOR_DATABASE_URL"
pg_dump --data-only --no-owner --no-privileges --table=public.schema_migrations \
  --file=db/baseline/schema_migrations.sql "$MIGRATOR_DATABASE_URL"
```

Keep the server version and `pg_dump` version aligned with the `postgres:` image the
CI service uses — newer dumps can emit syntax an older server rejects.

## What this is not

It is not a rewrite of the migration history, and existing migrations are not tested
by CI: they are already applied everywhere that matters. What CI exercises is
**baseline + whatever migrations a PR adds**, which is the part that can still break.
