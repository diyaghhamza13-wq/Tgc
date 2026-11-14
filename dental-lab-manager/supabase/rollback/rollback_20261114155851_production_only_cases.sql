-- =============================================================================
-- ROLLBACK for migration 20261114155851_production_only_cases.
-- NOT A MIGRATION. Kept outside supabase/migrations so it is never applied by
-- accident. Run only with explicit approval, in one transaction:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -1 -f supabase/rollback/rollback_20261114155851_production_only_cases.sql
--
-- Restores the previous behaviour (patient name required, all upload types,
-- patients readable by lab members). It deletes NO data:
--   * cases.clinic_order_ref is kept (the previous app ignores it);
--   * cases.patient_id stays nullable: cases created while Phase 1 was live
--     have no patient, and inventing patient rows for them would be wrong.
--     The previous app shows such cases without a patient name.
--   * files uploaded during Phase 1 keep their anonymous names.
-- After running it, re-deploy the previous web build.
-- =============================================================================

-- uploads
drop trigger if exists attachments_production_only on public.attachments;
drop function if exists public._attachments_production_only();

drop policy if exists case_files_insert on storage.objects;
create policy case_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'case-files'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and public.can_upload_to_case(public.storage_case_id(name))
  );

-- attachment history (original definition)
-- Attachment history hooks
create or replace function public._attachment_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public._history(new.case_id, 'file_uploaded', new.uploaded_by, null, new.stage_id,
      p_data => jsonb_build_object('file_name', new.file_name, 'category', new.category, 'attachment_id', new.id));
    return new;
  else
    if exists (select 1 from public.cases where id = old.case_id) then
      perform public._history(old.case_id, 'file_deleted', public.current_employee_id(), null, null,
        p_data => jsonb_build_object('file_name', old.file_name, 'category', old.category));
    end if;
    return old;
  end if;
end;
$$;
drop function if exists public._safe_file_label(text, text);
drop function if exists public._production_file_name(text, text);

-- patients: previous policies and grants
create policy patients_select on public.patients for select to authenticated
  using (lab_id = public.current_lab_id());
create policy patients_insert on public.patients for insert to authenticated
  with check (lab_id = public.current_lab_id() and public.has_permission('cases.create'));
create policy patients_update on public.patients for update to authenticated
  using (lab_id = public.current_lab_id() and public.has_permission('cases.edit'))
  with check (lab_id = public.current_lab_id());
grant select, insert, update on public.patients to authenticated;
comment on table public.patients is null;

revoke update (clinic_order_ref) on public.cases from authenticated;
grant update (patient_id) on public.cases to authenticated;

update public.permissions set description = 'Create new cases and patients'
 where code = 'cases.create' and description = 'Create new cases';

-- create_case (original definition)
create or replace function public.create_case(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  v_lab record;
  v_seq integer;
  v_case uuid;
  v_patient uuid := nullif(p->>'patient_id', '')::uuid;
  v_template uuid := nullif(p->>'workflow_template_id', '')::uuid;
  v_tech uuid := nullif(p->>'assigned_technician_id', '')::uuid;
  v_tech_dep uuid;
  v_first record;
  v_next uuid;
  v_due date := nullif(p->>'due_date', '')::date;
begin
  if not public.has_permission('cases.create') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_due is null then
    raise exception 'due_date_required' using errcode = 'P0001';
  end if;
  if nullif(p->>'doctor_id', '') is null then
    raise exception 'doctor_required' using errcode = 'P0001';
  end if;
  select * into v_lab from public.laboratories where id = me.lab_id;

  if v_patient is null then
    if length(btrim(coalesce(p->'patient'->>'full_name', ''))) < 2 then
      raise exception 'patient_required' using errcode = 'P0001';
    end if;
    insert into public.patients (lab_id, full_name, reference, notes)
    values (me.lab_id, btrim(p->'patient'->>'full_name'),
            nullif(btrim(p->'patient'->>'reference'), ''), nullif(btrim(p->'patient'->>'notes'), ''))
    returning id into v_patient;
  end if;

  if v_template is null then
    select id into v_template from public.workflow_templates
    where lab_id = me.lab_id and is_default and is_active;
  end if;
  if v_template is null or not exists (select 1 from public.workflow_stages where template_id = v_template) then
    raise exception 'workflow_not_configured' using errcode = 'P0001';
  end if;

  update public.lab_counters set case_seq = case_seq + 1 where lab_id = me.lab_id
  returning case_seq into v_seq;

  insert into public.cases (lab_id, case_number, patient_id, doctor_id, assigned_technician_id,
                            workflow_template_id, received_at, due_date, priority, shade, notes, created_by)
  values (me.lab_id, 'DL-' || lpad(v_seq::text, 6, '0'), v_patient, (p->>'doctor_id')::uuid, v_tech,
          v_template, coalesce(nullif(p->>'received_at', '')::timestamptz, now()), v_due,
          coalesce(nullif(p->>'priority', ''), 'normal')::public.case_priority,
          nullif(btrim(p->>'shade'), ''), nullif(btrim(p->>'notes'), ''), me.id)
  returning id into v_case;

  perform public._save_prescription(v_case, p);

  insert into public.case_workflow_stages (lab_id, case_id, position, name, kind, department_id, assigned_employee_id)
  select me.lab_id, v_case, ws.position, ws.name, ws.kind, ws.department_id, ws.default_assignee_id
  from public.workflow_stages ws where ws.template_id = v_template
  order by ws.position;

  -- The chosen technician takes the first stage of their department.
  if v_tech is not null then
    select department_id into v_tech_dep from public.employees
    where id = v_tech and lab_id = me.lab_id and status = 'active';
    if v_tech_dep is null and not exists (select 1 from public.employees where id = v_tech and lab_id = me.lab_id) then
      raise exception 'invalid_technician' using errcode = 'P0001';
    end if;
    update public.case_workflow_stages set assigned_employee_id = v_tech
    where id = (select id from public.case_workflow_stages
                where case_id = v_case and department_id = v_tech_dep and kind = 'production'
                order by position limit 1);
  end if;

  insert into public.case_assignments (lab_id, case_id, stage_id, employee_id, assigned_by)
  select lab_id, case_id, id, assigned_employee_id, me.id
  from public.case_workflow_stages where case_id = v_case and assigned_employee_id is not null;

  perform public._history(v_case, 'created', me.id, p->>'notes',
    p_data => jsonb_build_object('case_number', 'DL-' || lpad(v_seq::text, 6, '0')));

  select * into v_first from public.case_workflow_stages where case_id = v_case order by position limit 1;
  update public.cases set current_stage_id = v_first.id where id = v_case;

  if v_first.kind = 'reception' and coalesce((v_lab.settings->>'auto_complete_reception')::boolean, true) then
    update public.case_workflow_stages
      set status = 'completed', started_at = now(), completed_at = now(), completed_by = me.id,
          assigned_employee_id = coalesce(assigned_employee_id, me.id)
    where id = v_first.id;
    select id into v_next from public.case_workflow_stages
    where case_id = v_case and position > v_first.position order by position limit 1;
    if v_next is not null then
      perform public._activate_stage(v_case, v_next, me.id, v_first.id, null);
    end if;
  else
    perform public._notify_stage(v_first.id, 'case_arrived', 'New case in your department', v_first.name, me.id);
  end if;

  perform public._refresh_case_status(v_case);
  return v_case;
end;
$$;

-- lab_report (original definition)
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

-- legacy-file access rule and redaction helpers (section 7–8 of the migration).
-- NOTE: file names already redacted by scripts/redact-legacy-files.mjs are NOT
-- restored by this script (only the encrypted backup holds the originals).
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
drop policy if exists case_files_read on storage.objects;
create policy case_files_read on storage.objects for select to authenticated
  using (
    bucket_id = 'case-files'
    and (string_to_array(name, '/'))[1] = public.current_lab_id()::text
    and public.can_view_case(public.storage_case_id(name))
  );
drop function if exists public.can_read_case_object(text);
drop function if exists public.is_legacy_sensitive_file(text, text);
drop function if exists public.redact_legacy_attachment(uuid, text);
drop function if exists public.redact_legacy_file_names();
drop function if exists public._redacted_path(text);

-- migration history: mark 20261114155851 as not applied
delete from supabase_migrations.schema_migrations where version = '20261114155851';
