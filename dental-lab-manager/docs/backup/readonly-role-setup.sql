-- =============================================================================
-- PROPOSAL — NOT A MIGRATION. NOT APPLIED ANYWHERE IN PRODUCTION.
-- Read-only database login used ONLY by the phone-based backup export.
-- Kept outside supabase/migrations so that no migration run can apply it.
-- Apply only after the operator's explicit approval, in the Supabase dashboard
-- SQL editor of the APP project. Tested on the local stack (docs/backup/README.md).
--
-- What this login CAN do:
--   * read every row of every table in schema public (BYPASSRLS: sees all
--     laboratories — required for a complete backup), including the legacy
--     patient names and the PIN hashes in public.employee_credentials;
--   * read supabase_migrations.schema_migrations (migration history);
--   * read storage.objects (the LIST of stored files: names, sizes, dates).
-- What it CANNOT do (no privilege is granted for it):
--   * insert, update, delete or truncate anything; create or alter objects;
--     disable triggers; call the app's write functions;
--   * read Supabase Auth (schema auth: login accounts, sessions);
--   * download stored file contents (Storage API needs an API key, not this login).
-- default_transaction_read_only = on is an extra guard only: the login could
-- switch it off for its own session, but it still has no write privilege.
-- =============================================================================

create role dlm_backup_reader login bypassrls;          -- no password here: see step 2
alter role dlm_backup_reader set default_transaction_read_only = on;
alter role dlm_backup_reader set statement_timeout = '5min';
alter role dlm_backup_reader connection limit 2;

grant usage  on schema public, supabase_migrations, storage to dlm_backup_reader;
grant select on all tables in schema public to dlm_backup_reader;
grant select on supabase_migrations.schema_migrations to dlm_backup_reader;
grant select on storage.objects to dlm_backup_reader;
-- tables added by FUTURE migrations (created by postgres) become readable too
alter default privileges for role postgres in schema public grant select on tables to dlm_backup_reader;

-- Step 2 (by the operator only, in the SQL editor; never in a file, chat or repository):
--   alter role dlm_backup_reader password '<a long random password>';
-- To rotate: run the same statement with a new password.

-- -----------------------------------------------------------------------------
-- REMOVAL (also only with approval):
--   alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader;
--   revoke select on all tables in schema public from dlm_backup_reader;
--   revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader;
--   revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader;
--   drop role dlm_backup_reader;
-- -----------------------------------------------------------------------------
