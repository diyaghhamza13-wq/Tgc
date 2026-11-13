-- =============================================================================
-- Employee account deletion: privacy hardening
--
-- 1. delete_employee_account(): deletes ONE employee atomically, together with
--    their Supabase Auth account, and removes their personal identifiers from
--    the audit log and from case-history "assigned" events.
-- 2. delete_laboratory(): now also deletes the laboratory's Auth accounts
--    inside the same transaction (no orphaned accounts possible).
-- 3. pending_cleanups: records storage files whose deletion failed after a
--    successful database deletion, so they can be retried / reported.
-- 4. cleanup_report(): read-only report of orphaned Auth accounts and pending
--    cleanups (service role only).
-- 5. One-time anonymization of any previously deleted employees.
--
-- Laboratory work records (cases, stages, QC, deliveries, files, notes) are
-- preserved; only the link to the deleted employee is cleared (existing
-- ON DELETE SET NULL rules). No scheduled job is created by this migration.
-- =============================================================================

-- Personal identifiers removed from audit-log copies of an employee row.
create or replace function public._redact_employee(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p is null then null
              else (p - array['full_name', 'code', 'phone', 'email', 'avatar_path', 'specialty',
                              'auth_user_id', 'last_login_at', 'preferred_language'])
                   || jsonb_build_object('anonymized', true)
         end;
$$;

-- Remove the personal traces of an already-deleted employee (idempotent).
create or replace function public._anonymize_employee_traces(p_employee_id uuid, p_auth_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.audit_logs
     set old_data = public._redact_employee(old_data),
         new_data = public._redact_employee(new_data)
   where table_name = 'employees'
     and record_id = p_employee_id::text
     and coalesce((coalesce(new_data, old_data)->>'anonymized')::boolean, false) = false;

  if p_auth_user_id is not null then
    update public.audit_logs set actor_user_id = null where actor_user_id = p_auth_user_id;
  end if;

  update public.case_history
     set data = jsonb_set(data, '{employee_name}', to_jsonb('Deleted Employee'::text))
   where data->>'employee_id' = p_employee_id::text
     and data ? 'employee_name'
     and data->>'employee_name' is distinct from 'Deleted Employee';
end;
$$;

-- Delete one employee account permanently (service role only).
create or replace function public.delete_employee_account(p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  v_is_admin boolean;
  v_other_admins integer;
begin
  select * into e from public.employees where id = p_employee_id for update;
  if e.id is null then
    raise exception 'employee_not_found' using errcode = 'P0002';
  end if;

  -- the last active administrator must delete the whole laboratory instead
  select exists (select 1 from public.role_permissions
                 where role_id = e.role_id and permission_code = 'employees.manage')
    into v_is_admin;
  if v_is_admin and e.status = 'active' then
    select count(*) into v_other_admins
      from public.employees x
      join public.role_permissions rp on rp.role_id = x.role_id and rp.permission_code = 'employees.manage'
     where x.lab_id = e.lab_id and x.status = 'active' and x.id <> e.id;
    if v_other_admins = 0 then
      raise exception 'last_admin' using errcode = 'P0001';
    end if;
  end if;

  -- work records keep existing (ON DELETE SET NULL); credentials, notifications
  -- and assignment rows are removed (ON DELETE CASCADE)
  delete from public.employees where id = e.id;

  perform public._anonymize_employee_traces(e.id, e.auth_user_id);

  -- the Auth account (cascades to identities, sessions, MFA, tokens)
  if e.auth_user_id is not null then
    delete from auth.users where id = e.auth_user_id;
  end if;

  return jsonb_build_object(
    'employee_id', e.id,
    'lab_id', e.lab_id,
    'auth_user_deleted', e.auth_user_id is not null,
    'avatar_prefix', e.lab_id::text || '/avatars/' || e.id::text);
end;
$$;

-- Laboratory deletion: Auth accounts are now removed in the same transaction.
create or replace function public.delete_laboratory(p_lab_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_auth uuid[];
begin
  select coalesce(array_agg(auth_user_id), '{}') into v_auth
    from public.employees where lab_id = p_lab_id and auth_user_id is not null;
  delete from public.cases where lab_id = p_lab_id;
  delete from public.employees where lab_id = p_lab_id;
  delete from public.laboratories where id = p_lab_id;
  delete from public.audit_logs where lab_id = p_lab_id;
  delete from auth.users where id = any (v_auth);
end;
$$;

-- Storage cleanups that failed after a successful database deletion.
create table public.pending_cleanups (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('storage_prefix')),
  bucket      text not null,
  target      text not null,
  lab_id      uuid,               -- no FK: the laboratory may no longer exist
  attempts    integer not null default 1,
  last_error  text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  unique (bucket, target)
);
alter table public.pending_cleanups enable row level security;
revoke all on public.pending_cleanups from anon, authenticated;
-- (no policies: only the service role and SECURITY DEFINER functions use it)

-- Read-only report for the operator (service role / SQL editor only).
create or replace function public.cleanup_report()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'orphaned_auth_users', (
      select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'created_at', u.created_at) order by u.created_at), '[]'::jsonb)
        from auth.users u
       where not exists (select 1 from public.employees e where e.auth_user_id = u.id)),
    'pending_cleanups', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at), '[]'::jsonb)
        from public.pending_cleanups p where p.resolved_at is null));
$$;

revoke execute on function public._redact_employee(jsonb) from public, anon, authenticated;
revoke execute on function public._anonymize_employee_traces(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.delete_employee_account(uuid) from public, anon, authenticated;
revoke execute on function public.delete_laboratory(uuid) from public, anon, authenticated;
revoke execute on function public.cleanup_report() from public, anon, authenticated;
grant execute on function public.delete_employee_account(uuid) to service_role;
grant execute on function public.delete_laboratory(uuid) to service_role;
grant execute on function public.cleanup_report() to service_role;

-- One-time: anonymize traces of employees deleted before this migration.
do $$
declare
  r record;
begin
  for r in
    select distinct a.record_id::uuid as employee_id
      from public.audit_logs a
     where a.table_name = 'employees'
       and not exists (select 1 from public.employees e where e.id::text = a.record_id)
  loop
    perform public._anonymize_employee_traces(r.employee_id, null);
  end loop;
  -- auth ids of deleted employees, as recorded in their (now anonymized) rows,
  -- are already removed above; clear actor_user_id that no longer exists in auth
  update public.audit_logs a set actor_user_id = null
   where a.actor_user_id is not null
     and not exists (select 1 from auth.users u where u.id = a.actor_user_id);
end;
$$;
