-- =============================================================================
-- BACKUP RUNNER project only (never production). Apply AFTER the dlm-backup
-- function is deployed in the runner project, and after storing its URL in Vault:
--   select vault.create_secret('https://<runner-ref>.supabase.co/functions/v1/dlm-backup',
--                              'dlm_backup_function_url', 'dlm-backup function URL');
--
-- Jobs (times UTC):
--   dlm-backup-daily    02:17 every day     -> function, mode "backup"
--   dlm-backup-verify   04:27 every Sunday  -> function, mode "verify"
--   dlm-backup-health   03:47 every day     -> SQL only: alert row if no success in 26 h
--
-- Every invocation carries "x-region: eu-west-2", so Supabase executes the
-- function in London (it otherwise picks the region closest to the caller). The
-- function additionally refuses to run anywhere else (SB_REGION check).
-- pg_net lives in THIS project only; production does not need it.
-- =============================================================================

create or replace function dlm_runner.invoke(p_mode text)
returns bigint language sql volatile security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_function_url'),
    body := json_build_object('mode', p_mode)::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-west-2',
      'x-dlm-backup-trigger', (select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger')),
    timeout_milliseconds := 10000);
$$;
revoke all on function dlm_runner.invoke(text) from public, anon, authenticated, service_role;

select cron.schedule('dlm-backup-daily',  '17 2 * * *', $$select dlm_runner.invoke('backup')$$);
select cron.schedule('dlm-backup-verify', '27 4 * * 0', $$select dlm_runner.invoke('verify')$$);
select cron.schedule('dlm-backup-health', '47 3 * * *', $$select dlm_runner.health()$$);
