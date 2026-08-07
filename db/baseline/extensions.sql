-- Extensions the baseline schema depends on but does not create itself.
--
-- pg_dump --schema=public does not emit CREATE EXTENSION, yet the dump contains
-- objects that need them (a GIN index using public.gin_trgm_ops, for one). They
-- have to exist before schema.sql is restored.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
