-- =============================================================================
-- PROPOSAL — NOT A MIGRATION. NOT APPLIED ANYWHERE IN PRODUCTION.
-- Read-only database login used ONLY by the phone-based backup export.
-- Kept outside supabase/migrations so that no migration run can apply it.
-- Apply only after the operator's explicit approval, in the Supabase dashboard
-- SQL editor of the APP project. This file contains NO password.
-- Tested on the local stack (docs/backup/README.md §9).
--
-- What this login CAN do:
--   * read every row of every table in schema public (BYPASSRLS: sees all
--     laboratories — required for a complete backup), including the legacy
--     patient names and the PIN hashes in public.employee_credentials;
--   * read supabase_migrations.schema_migrations (migration history);
--   * read storage.objects (the LIST of stored files: names, sizes, dates);
--   * like every PostgreSQL login: create TEMPORARY tables for its own session
--     (PUBLIC default) and change its own session settings.
-- What it CANNOT do (verified by scripts/backup/check-connection.mjs, which
-- inspects every schema the login can access):
--   * insert, update, delete or truncate anything; change sequences; create
--     objects in the database or any schema; disable triggers;
--   * execute any SECURITY DEFINER function (the app's write functions);
--   * read Supabase Auth (schema auth) or Vault secrets (schema vault);
--   * download stored file contents (the Storage API needs an API key);
--   * act as superuser, create databases or roles, replicate, or inherit
--     another role's rights (it is a member of no role).
-- default_transaction_read_only = on is an extra guard only: the login could
-- switch it off for its own session, but it still has no write privilege.
-- =============================================================================

create role dlm_backup_reader
  login nosuperuser nocreatedb nocreaterole noreplication noinherit bypassrls
  connection limit 2;                                   -- no password here: see step 2
alter role dlm_backup_reader set default_transaction_read_only = on;
alter role dlm_backup_reader set statement_timeout = '5min';

grant usage  on schema public, supabase_migrations, storage to dlm_backup_reader;
grant select on all tables in schema public to dlm_backup_reader;
grant select on supabase_migrations.schema_migrations to dlm_backup_reader;
grant select on storage.objects to dlm_backup_reader;
-- tables added by FUTURE migrations (created by postgres) become readable too
alter default privileges for role postgres in schema public grant select on tables to dlm_backup_reader;

-- Step 2 — set the password from TERMUX, never in the SQL editor
-- (the SQL editor may keep statement text in its history, and an
-- ALTER ROLE ... PASSWORD '<plain text>' statement can reach server logs):
--
--   read -rs PGPASSWORD; export PGPASSWORD            # the MAIN database password, typed once
--   psql -X 'postgresql://postgres@<host>:5432/postgres?sslmode=verify-full&sslrootcert=<path to supabase CA>'
--   postgres=> \password dlm_backup_reader
--   (type the new backup-login password twice; nothing is echoed)
--   postgres=> \q
--   unset PGPASSWORD
--
-- psql's \password hashes the new password ON THE PHONE (SCRAM-SHA-256) and
-- sends only the verifier: the plain password never reaches the server, its
-- logs, the SQL editor or any chat. To rotate, repeat step 2.

-- -----------------------------------------------------------------------------
-- REMOVAL (also only with approval):
--   alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader;
--   revoke select on all tables in schema public from dlm_backup_reader;
--   revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader;
--   revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader;
--   drop role dlm_backup_reader;
-- -----------------------------------------------------------------------------
