-- =============================================================================
-- REMOVAL of the production side of the automated backup (20261115090000).
-- Run only with approval. Removes the backup role, the token store (hashes only),
-- the snapshot functions and the Storage download policy. Does NOT touch
-- application data or stored files. Off-site encrypted copies are not affected
-- (they expire by lifecycle rule). The Backup Runner project is separate: stop
-- its schedule (backup-runner/supabase/schedule.sql jobs) or delete that project.
-- Revoking every token (select dlm_backup.revoke_all_tokens();) is enough to cut
-- the runner off immediately without removing anything.
-- =============================================================================
drop policy if exists dlm_backup_runner_download on storage.objects;
drop function if exists public.dlm_backup_runner_snapshot();
drop function if exists public.dlm_backup_snapshot();
drop schema if exists dlm_backup cascade;
alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader;
revoke select on all tables in schema public from dlm_backup_reader;
revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader;
revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader;
drop role if exists dlm_backup_reader;
