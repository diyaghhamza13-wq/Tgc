-- =============================================================================
-- PENDING — NOT APPLIED ANYWHERE IN PRODUCTION. Requires 20261114190000 first.
-- Schedules the automated backup with pg_cron + pg_net.
--
-- BEFORE applying, the function URL must exist in Vault (deployment step; the
-- URL is not secret, it is kept in Vault only so the job text holds no
-- project-specific value):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/dlm-backup',
--                              'dlm_backup_function_url', 'dlm-backup Edge Function URL');
--
-- Jobs (times UTC):
--   dlm-backup-daily    02:17 every day     -> function, mode "backup"
--   dlm-backup-verify   04:27 every Sunday  -> function, mode "verify" (needs the optional read key)
--   dlm-backup-health   03:47 every day     -> SQL only: alert row if no success in 26 h
-- The trigger secret travels in a request header; pg_net keeps queued
-- requests briefly in net.http_request_queue (readable by postgres only).
-- =============================================================================

create or replace function dlm_backup.invoke(p_mode text)
returns bigint language sql volatile security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_function_url'),
    body := json_build_object('mode', p_mode)::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dlm-backup-trigger', (select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger')),
    timeout_milliseconds := 10000);
$$;
revoke all on function dlm_backup.invoke(text) from public, anon, authenticated, service_role;

select cron.schedule('dlm-backup-daily',  '17 2 * * *', $$select dlm_backup.invoke('backup')$$);
select cron.schedule('dlm-backup-verify', '27 4 * * 0', $$select dlm_backup.invoke('verify')$$);
select cron.schedule('dlm-backup-health', '47 3 * * *', $$select public.dlm_backup_health()$$);
