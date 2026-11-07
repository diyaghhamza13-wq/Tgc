-- =============================================================================
-- Dental Lab Manager — reports, storage, audit logging, realtime, scheduling
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Analytics. Holders of reports.view see the whole laboratory; everybody else
-- is restricted to the work they performed themselves.
-- ---------------------------------------------------------------------------
create or replace function public.lab_report(
  p_from date, p_to date,
  p_employee_id uuid default null, p_department_id uuid default null,
  p_doctor_id uuid default null, p_restoration_type_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  v_emp uuid := p_employee_id;
  v_scope text := 'lab';
  v_result jsonb;
begin
  if not public.has_permission('reports.view') then
    v_emp := me.id;
    v_scope := 'own';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid_date_range' using errcode = 'P0001';
  end if;

  with base as (
    select c.*
    from public.cases c
    where c.lab_id = me.lab_id
      and c.received_at >= p_from::timestamptz
      and c.received_at < (p_to + 1)::timestamptz
      and (p_doctor_id is null or c.doctor_id = p_doctor_id)
      and (p_restoration_type_id is null or exists (
            select 1 from public.case_restorations r
            where r.case_id = c.id and r.restoration_type_id = p_restoration_type_id))
      and (v_emp is null or exists (
            select 1 from public.case_workflow_stages s
            where s.case_id = c.id and (s.completed_by = v_emp or s.assigned_employee_id = v_emp))
           or c.created_by = v_emp)
      and (p_department_id is null or exists (
            select 1 from public.case_workflow_stages s
            where s.case_id = c.id and s.department_id = p_department_id))
  ),
  stages as (
    select s.*
    from public.case_workflow_stages s
    join base b on b.id = s.case_id
    where s.status = 'completed' and s.kind <> 'delivered'
      and (v_emp is null or s.completed_by = v_emp)
      and (p_department_id is null or s.department_id = p_department_id)
  )
  select jsonb_build_object(
    'scope', v_scope,
    'from', p_from,
    'to', p_to,
    'totals', (
      select jsonb_build_object(
        'total', count(*) filter (where status <> 'cancelled'),
        'completed', count(*) filter (where status in ('completed', 'delivered')),
        'in_production', count(*) filter (where status in ('new', 'in_progress', 'waiting', 'ready_for_qc')),
        'delayed', count(*) filter (where status not in ('delivered', 'cancelled') and due_date < current_date),
        'delivered', count(*) filter (where status = 'delivered'),
        'delivered_late', count(*) filter (where status = 'delivered' and delivered_at::date > due_date),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'avg_production_hours', round((avg(extract(epoch from (coalesce(delivered_at, completed_at) - received_at)) / 3600)
                                 filter (where completed_at is not null))::numeric, 1)
      ) from base
    ),
    'departments', (
      select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'department_id', d.id, 'name', d.name,
          'stages_completed', count(s.id),
          'avg_hours', round((avg(s.time_spent_seconds) / 3600.0)::numeric, 2),
          'revisions', coalesce(sum(s.revision_count), 0)) as x
        from stages s join public.departments d on d.id = s.department_id
        group by d.id, d.name
      ) q
    ),
    'employees', (
      select coalesce(jsonb_agg(x order by (x->>'stages_completed')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'employee_id', e.id, 'name', e.full_name, 'code', e.code,
          'stages_completed', count(s.id),
          'cases', count(distinct s.case_id),
          'avg_hours', round((avg(s.time_spent_seconds) / 3600.0)::numeric, 2)) as x
        from stages s join public.employees e on e.id = s.completed_by
        group by e.id, e.full_name, e.code
      ) q
    ),
    'monthly', (
      select coalesce(jsonb_agg(x order by x->>'month'), '[]'::jsonb) from (
        select jsonb_build_object(
          'month', to_char(date_trunc('month', received_at), 'YYYY-MM'),
          'received', count(*),
          'delivered', count(*) filter (where status = 'delivered')) as x
        from base group by date_trunc('month', received_at)
      ) q
    ),
    'materials', (
      select coalesce(jsonb_agg(x order by (x->>'count')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('material_id', m.id, 'name', coalesce(m.name, '—'),
                                  'count', count(*),
                                  'units', coalesce(sum((select count(*) from public.case_teeth t where t.restoration_id = r.id)), 0)) as x
        from public.case_restorations r
        join base b on b.id = r.case_id
        left join public.materials m on m.id = r.material_id
        group by m.id, m.name
      ) q
    ),
    'restoration_types', (
      select coalesce(jsonb_agg(x order by (x->>'count')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('restoration_type_id', rt.id, 'name', rt.name, 'count', count(*)) as x
        from public.case_restorations r
        join base b on b.id = r.case_id
        join public.restoration_types rt on rt.id = r.restoration_type_id
        group by rt.id, rt.name
      ) q
    ),
    'doctors', (
      select coalesce(jsonb_agg(x order by (x->>'count')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('doctor_id', d.id, 'name', d.full_name, 'count', count(*)) as x
        from base b join public.doctors d on d.id = b.doctor_id
        group by d.id, d.full_name
      ) q
    ),
    'cases', (
      select coalesce(jsonb_agg(x order by x->>'received_at' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'case_number', b.case_number, 'patient', p.full_name, 'doctor', d.full_name,
          'received_at', b.received_at, 'due_date', b.due_date, 'status', b.status,
          'priority', b.priority, 'delivered_at', b.delivered_at) as x
        from base b
        join public.patients p on p.id = b.patient_id
        join public.doctors d on d.id = b.doctor_id
        limit 2000
      ) q
    )
  ) into v_result;
  return v_result;
end;
$$;
revoke execute on function public.lab_report(date, date, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.lab_report(date, date, uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private case files, public-read lab assets (logos, avatars)
-- Object layout:
--   case-files/<lab_id>/<case_id>/<uuid>-<file name>
--   lab-assets/<lab_id>/logo/<file>  and  lab-assets/<lab_id>/avatars/<employee_id>/<file>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('case-files', 'case-files', false, 524288000)
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-assets', 'lab-assets', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.storage_case_id(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return (string_to_array(p_name, '/'))[2]::uuid;
exception when others then
  return null;
end;
$$;
revoke execute on function public.storage_case_id(text) from public, anon;
grant execute on function public.storage_case_id(text) to authenticated;

create policy case_files_read on storage.objects for select to authenticated
  using (
    bucket_id = 'case-files'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and public.can_view_case(public.storage_case_id(name))
  );

create policy case_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'case-files'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and public.can_upload_to_case(public.storage_case_id(name))
  );

create policy case_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'case-files' and public.can_delete_attachment_path(name));

create policy lab_assets_write on storage.objects for insert to authenticated
  with check (
    bucket_id = 'lab-assets'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and (
      public.has_permission('lab.settings')
      or public.has_permission('employees.manage')
      or ((string_to_array(name, '/'))[2] = 'avatars'
          and (string_to_array(name, '/'))[3] = public.current_employee_id()::text)
    )
  );

create policy lab_assets_update on storage.objects for update to authenticated
  using (
    bucket_id = 'lab-assets'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and (
      public.has_permission('lab.settings')
      or public.has_permission('employees.manage')
      or ((string_to_array(name, '/'))[2] = 'avatars'
          and (string_to_array(name, '/'))[3] = public.current_employee_id()::text)
    )
  );

create policy lab_assets_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'lab-assets'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and (public.has_permission('lab.settings') or public.has_permission('employees.manage'))
  );

-- ---------------------------------------------------------------------------
-- Audit logging of sensitive tables
-- ---------------------------------------------------------------------------
create or replace function public._audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_lab uuid;
begin
  v_lab := case when tg_table_name = 'laboratories' then (v_row->>'id')::uuid
                else (v_row->>'lab_id')::uuid end;
  insert into public.audit_logs (lab_id, actor_employee_id, actor_user_id, table_name, record_id, action, old_data, new_data)
  values (
    case when tg_op = 'DELETE' and tg_table_name = 'laboratories' then null else v_lab end,
    public.current_employee_id(), auth.uid(), tg_table_name,
    coalesce(v_row->>'id', v_row->>'role_id'), tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;
revoke execute on function public._audit_row() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'laboratories', 'departments', 'roles', 'role_permissions', 'employees', 'doctors',
    'cases', 'case_workflow_stages', 'attachments', 'quality_control', 'deliveries',
    'workflow_templates', 'workflow_stages', 'restoration_types', 'materials',
    'implant_brands', 'implant_systems'
  ] loop
    execute format(
      'create trigger %1$s_audit after insert or update or delete on public.%1$I
         for each row execute function public._audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime (postgres_changes respects RLS)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.cases, public.case_workflow_stages;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hourly deadline scan (pg_cron, when available)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available: deadline scan must be triggered by the app';
    return;
  end;
  perform cron.schedule('dlm-deadline-scan', '7 * * * *', 'select public._check_deadlines(null)');
exception when others then
  raise notice 'Could not schedule deadline scan: %', sqlerrm;
end;
$$;
