-- =============================================================================
-- REMOVAL of the automated backup (20261114190000 + 20261114190100).
-- Run only with approval. Deletes the run log and file bookkeeping (no
-- personal data) and the Vault secrets; does NOT touch application data.
-- Off-site encrypted copies are not affected: they expire by lifecycle rule.
-- The Edge Function must be deleted separately (dashboard or CLI).
-- =============================================================================
do $$ begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('dlm-backup-daily', 'dlm-backup-verify', 'dlm-backup-health');
end $$;
drop function if exists dlm_backup.invoke(text);
drop function if exists public.dlm_backup_begin(text, text);
drop function if exists public.dlm_backup_files_todo(integer);
drop function if exists public.dlm_backup_files_done(uuid, json);
drop function if exists public.dlm_backup_file_map();
drop function if exists public.dlm_backup_finish(uuid, text, json);
drop function if exists public.dlm_backup_recent(integer);
drop function if exists public.dlm_backup_health();
drop function if exists public.dlm_backup_files_invalidate(uuid, json);
drop function if exists public.dlm_backup_snapshot();
drop schema if exists dlm_backup cascade;
delete from vault.secrets where name in ('dlm_backup_trigger', 'dlm_backup_function_url');
alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader;
revoke select on all tables in schema public from dlm_backup_reader;
revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader;
revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader;
drop role if exists dlm_backup_reader;
-- pg_net is left installed (harmless); remove with: drop extension pg_net;
