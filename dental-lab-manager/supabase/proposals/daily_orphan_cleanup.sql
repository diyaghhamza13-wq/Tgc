-- =============================================================================
-- PROPOSAL — NOT A MIGRATION. NOT APPLIED ANYWHERE.
-- Review separately before enabling. Kept outside supabase/migrations so that
-- `supabase db push` / migration runs never apply it.
--
-- What it does (once a day, 03:17 UTC):
--   Deletes Supabase Auth accounts that have NO employee row and are older
--   than 24 hours. Such accounts can only exist if an employee creation was
--   interrupted between "create Auth user" and "link to employee"; they cannot
--   access any data (current_employee_id() is null for them).
--
-- What it does NOT do:
--   - It never deletes employees, laboratories or any public.* data.
--   - It does not retry storage deletions: Supabase forbids deleting
--     storage objects with SQL (storage.protect_delete). Rows in
--     public.pending_cleanups must be retried through the Storage API
--     (e.g. a small edge function) — to be proposed separately if needed.
--
-- Permissions: the function is SECURITY DEFINER owned by postgres, executable
-- only by service_role and the cron job (which runs as postgres). Not callable
-- by anon or authenticated users.
-- =============================================================================

create or replace function public.cleanup_orphaned_auth_users(p_min_age interval default interval '24 hours')
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from auth.users u
   where u.created_at < now() - p_min_age
     and not exists (select 1 from public.employees e where e.auth_user_id = u.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.cleanup_orphaned_auth_users(interval) from public, anon, authenticated;
grant execute on function public.cleanup_orphaned_auth_users(interval) to service_role;

-- Schedule (requires the pg_cron extension, already enabled by an earlier
-- migration for the hourly deadline scan):
select cron.schedule('dlm-orphan-auth-cleanup', '17 3 * * *',
                     $job$select public.cleanup_orphaned_auth_users()$job$);

-- To disable later:   select cron.unschedule('dlm-orphan-auth-cleanup');
-- To preview first:   select public.cleanup_report();   (read-only)
