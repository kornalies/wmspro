# GWU WMSPro Multi-Tenancy Implementation (PostgreSQL 15/16/18)

This pack implements three tenant isolation plans and strict runtime-role security.
In this repository, tenant identity is currently represented as `company_id` in operational tables.

## 1) Architecture Decision (Basic / Advance / Enterprise)

### Plan Matrix

| Plan | Isolation Model | Security Boundary | Cost | Operational Overhead | Best For |
|---|---|---|---|---|---|
| BASIC | Single DB, shared tables, `company_id` + RLS | Row-level | Lowest | Low | SMB tenants, high density |
| ADVANCE | Single DB, schema-per-tenant | Schema-level | Medium | Medium | Mid-market needing stronger logical separation |
| ENTERPRISE | Database-per-tenant | Database-level | Highest | Highest | Large/regulatory tenants, strict isolation |

### BASIC (Option A)
- Design: All tenant-owned tables include `company_id` (tenant key), with RLS policies bound to `current_setting('app.company_id', true)`.
- Pros: Lowest infra cost, easy cross-tenant analytics (admin-only), one migration stream.
- Cons: Highest risk from developer mistakes if tenant filters/RLS are not strict.
- Risks: RLS bypass if app role has `BYPASSRLS`; connection leak if tenant context not transaction-scoped.
- Controls: `SET LOCAL` tenant context per transaction, `NOBYPASSRLS`, `FORCE ROW LEVEL SECURITY`.

### ADVANCE (Option B)
- Design: Shared/global tables stay in `public`; each tenant has `tenant_<key>` schema for tenant-local transactional tables.
- Pros: Better blast-radius isolation than shared tables, still one cluster.
- Cons: Schema fleet management and multi-schema migrations become operationally heavier.
- Risks: `search_path` injection if schema name is not validated.
- Controls: Allow-list schema names from registry and `SET LOCAL search_path = <schema>, public` only inside transactions.

### ENTERPRISE (Option C)
- Design: Dedicated database per tenant.
- Pros: Strongest isolation by design, tenant-level backup/restore, easier noisy-neighbor control.
- Cons: Highest cost and operational complexity (pooling, migrations, monitoring).
- Risks: Connection explosion if each request opens independent pools.
- Controls: Tenant-aware connection router + capped pool-per-database strategy.

### Tenant Resolution per Request
Use deterministic precedence:
1. API key mapping (service integrations)
2. JWT claim (`company_id`, signed)
3. Host/subdomain mapping (`<tenant>.wmspro.com`)
4. Explicit header only for internal trusted hops (never public clients)

Recommendation: JWT as primary for user traffic, API key for machine traffic, host mapping as additional validation.

### DB-Level Tenant Context by Plan
- BASIC: `SET LOCAL app.company_id = '<company_id>'` (or `set_config(..., true)`) in transaction.
- ADVANCE: `SET LOCAL search_path = tenant_<key>, public` after schema validation.
- ENTERPRISE: Route to tenant-specific `DATABASE_URL`; no shared tenant context needed.

## 2) Database Roles & Security (All Plans)

Use [roles.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/roles.sql) first.

### Before / After `DATABASE_URL`

Before (insecure example):
```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/wmspro
```

After (secure runtime):
```env
MIGRATOR_DATABASE_URL=postgresql://wms_migrator:<MIGRATOR_PASSWORD>@127.0.0.1:5432/wmspro
DATABASE_URL=postgresql://wms_app:<APP_PASSWORD>@127.0.0.1:5432/wmspro
```

### Mandatory runtime safety check
At app startup and health check:
```sql
SELECT app_security.assert_safe_runtime_role();
```

CI/CD gate command:
```bash
npm run check:tenant-safety
```

## 3) BASIC Implementation (Option A)

Use:
- [01_basic_tenant_model_and_rls.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/rls/01_basic_tenant_model_and_rls.sql)
- [tenant_context.ts](/c:/Users/Admin-PC/wms-frontend/app/tenant_context.ts)
- [tenant_isolation_tests.sql](/c:/Users/Admin-PC/wms-frontend/tests/tenant_isolation_tests.sql)

### pgAdmin / psql run order
1. `db/sql/roles.sql`
2. `db/sql/rls/01_basic_tenant_model_and_rls.sql`
3. `tests/tenant_isolation_tests.sql` (BASIC section)

### Existing-data migration sequence (safe)
1. Create `tenants` table and default tenant.
2. Add nullable `company_id` columns.
3. Backfill in batches.
4. Add FK + indexes.
5. Set `company_id NOT NULL`.
6. Enable `RLS + FORCE RLS` and create policies.
7. Deploy app code that uses transaction-scoped tenant context.
8. Run isolation tests.

## 4) ADVANCE Implementation (Option B)

Use:
- [01_template_and_registry.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/schema_per_tenant/01_template_and_registry.sql)
- [02_provision_schema.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/schema_per_tenant/02_provision_schema.sql)
- [03_permissions_and_migrations.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/schema_per_tenant/03_permissions_and_migrations.sql)
- [tenant_context.ts](/c:/Users/Admin-PC/wms-frontend/app/tenant_context.ts)

### Run order
1. `db/sql/roles.sql`
2. `db/sql/schema_per_tenant/01_template_and_registry.sql`
3. `db/sql/schema_per_tenant/02_provision_schema.sql`
4. `db/sql/schema_per_tenant/03_permissions_and_migrations.sql`
5. `tests/tenant_isolation_tests.sql` (ADVANCE section)

### Migration operations across many schemas
- Register target schemas in `public.tenant_registry`.
- Iterate each schema in one controlled deploy job.
- Use advisory locks + per-schema transaction + audit table writes.
- Stop on first failure and keep completed schemas recorded in `schema_migration_audit`.

## 5) ENTERPRISE Implementation (Option C)

Use:
- [01_enterprise_provisioning.sql](/c:/Users/Admin-PC/wms-frontend/db/sql/db_per_tenant/01_enterprise_provisioning.sql)
- [tenant_context.ts](/c:/Users/Admin-PC/wms-frontend/app/tenant_context.ts)
- [tenant_isolation_tests.sql](/c:/Users/Admin-PC/wms-frontend/tests/tenant_isolation_tests.sql)

### Run order
1. On control DB: `db/sql/roles.sql` then `db/sql/db_per_tenant/01_enterprise_provisioning.sql`.
2. For each new tenant DB: run migrations using `wms_migrator`.
3. Route traffic to tenant DB via enterprise router in app layer.

### Backup/restore
- Per-tenant `pg_dump -Fc` + PITR/WAL at cluster level.
- Restore tenant by restoring only that tenant DB.
- Quarterly restore drills with checksum and row-count validation.

## 6) Plan Switching (Upgrade/Downgrade)

### BASIC -> ADVANCE
1. Create target tenant schema (`provision_advance_tenant`).
2. Copy tenant rows from shared tables into tenant schema in deterministic order.
3. Validate counts + hash totals.
4. Freeze writes, apply delta sync.
5. Switch tenant routing to schema mode.
6. Keep source rows read-only for rollback window.

Rollback:
1. Route back to BASIC.
2. Replay captured delta into BASIC.
3. Re-enable writes on BASIC.

### ADVANCE -> ENTERPRISE
1. Create tenant database.
2. Dump schema data and restore into tenant DB.
3. Run migrations and integrity checks.
4. Switch tenant router to tenant DB.
5. Keep old schema for rollback window.

Rollback:
1. Route back to ADVANCE schema.
2. Replay delta from enterprise DB to schema.
3. Keep enterprise DB quarantined until reconciled.

### Downgrades
- ENTERPRISE -> ADVANCE and ADVANCE -> BASIC follow the same flow in reverse with freeze, copy, validate, cutover, rollback window.

## 7) Delivered Structure

```text
/db/sql/roles.sql
/db/sql/rls/01_basic_tenant_model_and_rls.sql
/db/sql/schema_per_tenant/01_template_and_registry.sql
/db/sql/schema_per_tenant/02_provision_schema.sql
/db/sql/schema_per_tenant/03_permissions_and_migrations.sql
/db/sql/db_per_tenant/01_enterprise_provisioning.sql
/app/tenant_context.ts
/tests/tenant_isolation_tests.sql
/docs/multitenancy-implementation.md
```

All scripts use explicit variables (`<...>`) only where environment-specific values are required.
