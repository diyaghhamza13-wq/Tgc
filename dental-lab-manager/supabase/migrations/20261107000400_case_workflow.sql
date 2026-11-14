-- =============================================================================
-- Dental Lab Manager — case management & production workflow engine
-- Every state change of a case goes through these SECURITY DEFINER functions,
-- which (1) authorize the caller, (2) apply the change atomically and
-- (3) write history + notifications. Clients cannot update workflow tables
-- directly (no grants / policies for that).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers (not executable by clients)
-- ---------------------------------------------------------------------------
create or replace function public._me()
returns public.employees language plpgsql stable security definer set search_path = '' as $$
declare
  v public.employees;
begin
  select * into v from public.employees where id = public.current_employee_id();
  if v.id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v;
end;
$$;

create or replace function public._notify(
  p_lab uuid, p_recipient uuid, p_case uuid, p_type text, p_title text, p_body text,
  p_data jsonb default '{}'::jsonb, p_dedupe text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (lab_id, recipient_id, case_id, type, title, body, data, dedupe_key)
  values (p_lab, p_recipient, p_case, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

-- Notify the people responsible for a stage: its assignee, or (when the stage
-- is unassigned) every active employee of its department. The actor is skipped.
create or replace function public._notify_stage(
  p_stage_id uuid, p_type text, p_title text, p_body text, p_actor uuid, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s record;
  v_recipients uuid[];
  v_fallback_perm text;
  r uuid;
begin
  select st.*, c.case_number, c.lab_id as c_lab, c.created_by as c_creator
    into s
  from public.case_workflow_stages st join public.cases c on c.id = st.case_id
  where st.id = p_stage_id;
  if s.id is null then return; end if;

  if s.assigned_employee_id is not null then
    v_recipients := array[s.assigned_employee_id];
  else
    select coalesce(array_agg(e.id), '{}') into v_recipients
    from public.employees e
    where e.lab_id = s.c_lab and e.status = 'active'
      and s.department_id is not null and e.department_id = s.department_id;
    -- nobody in that department: fall back to holders of the matching permission
    if cardinality(v_recipients) = 0 then
      v_fallback_perm := case when s.kind = 'qc' then 'qc.perform'
                              when s.kind in ('ready', 'delivered') then 'delivery.manage'
                              else 'workflow.assign' end;
      select coalesce(array_agg(distinct e.id), '{}') into v_recipients
      from public.employees e
      join public.role_permissions rp on rp.role_id = e.role_id and rp.permission_code = v_fallback_perm
      where e.lab_id = s.c_lab and e.status = 'active';
    end if;
  end if;
  -- whoever registered the case hears when it is ready to go out
  if s.kind = 'ready' and s.c_creator is not null then
    v_recipients := v_recipients || s.c_creator;
  end if;

  for r in select distinct x from unnest(v_recipients) x where x is distinct from p_actor loop
    perform public._notify(s.c_lab, r, s.case_id, p_type, p_title, p_body,
      jsonb_build_object('case_number', s.case_number, 'stage_name', s.name, 'stage_id', s.id) || coalesce(p_extra, '{}'::jsonb));
  end loop;
end;
$$;

create or replace function public._history(
  p_case uuid, p_event text, p_actor uuid, p_notes text default null, p_stage uuid default null,
  p_from_stage uuid default null, p_to_stage uuid default null, p_status text default null,
  p_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid;
  v_from_dep uuid;
  v_to_dep uuid;
begin
  select lab_id into v_lab from public.cases where id = p_case;
  if p_from_stage is not null then
    select department_id into v_from_dep from public.case_workflow_stages where id = p_from_stage;
  end if;
  if p_to_stage is not null then
    select department_id into v_to_dep from public.case_workflow_stages where id = p_to_stage;
  end if;
  insert into public.case_history (lab_id, case_id, event_type, stage_id, from_stage_id, to_stage_id,
                                   from_department_id, to_department_id, actor_id, status, notes, data)
  values (v_lab, p_case, p_event, p_stage, p_from_stage, p_to_stage, v_from_dep, v_to_dep,
          p_actor, p_status, nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_data, '{}'::jsonb));
end;
$$;

-- Derive the case status from its current stage.
create or replace function public._refresh_case_status(p_case uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c record;
  s record;
  v_started boolean;
  v_status public.case_status;
begin
  select * into c from public.cases where id = p_case;
  if c.status in ('delivered', 'cancelled') then return; end if;
  select * into s from public.case_workflow_stages where id = c.current_stage_id;
  if s.id is null then return; end if;

  select exists (
    select 1 from public.case_workflow_stages
    where case_id = p_case and kind <> 'reception' and (started_at is not null or completed_at is not null)
  ) into v_started;

  v_status := case
    when s.kind = 'delivered' and s.status = 'completed' then 'delivered'
    when s.kind in ('ready', 'delivered') then 'completed'
    when s.kind = 'qc' then 'ready_for_qc'
    when s.status = 'in_progress' then 'in_progress'
    when not v_started then 'new'
    else 'waiting'
  end::public.case_status;

  update public.cases
    set status = v_status,
        completed_at = case when v_status in ('completed', 'delivered') then coalesce(completed_at, now()) else null end
  where id = p_case;
end;
$$;

-- Can the current employee act on (start / complete / transfer) this stage?
create or replace function public.can_act_on_stage(p_stage_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := public.current_employee_id();
  v_dep uuid := public.current_department_id();
  s record;
begin
  if v_me is null then return false; end if;
  select st.*, c.current_stage_id, c.status as case_status, c.lab_id as c_lab
    into s
  from public.case_workflow_stages st join public.cases c on c.id = st.case_id
  where st.id = p_stage_id;
  if s.id is null or s.c_lab <> public.current_lab_id() then return false; end if;
  if s.current_stage_id is distinct from s.id or s.case_status in ('delivered', 'cancelled') then
    return false;
  end if;
  if public.has_permission('workflow.transfer_any') then return true; end if;
  if s.kind = 'qc' and not public.has_permission('qc.perform') then return false; end if;
  if s.kind in ('ready', 'delivered') and not public.has_permission('delivery.manage') then return false; end if;
  -- NB: coalesce — comparisons with a NULL assignee must never grant access
  return coalesce(
      s.assigned_employee_id = v_me
      or (s.assigned_employee_id is null and v_dep is not null and s.department_id = v_dep)
      or (s.kind in ('ready', 'delivered', 'qc')),
    false);
end;
$$;

create or replace function public._lock_stage(p_stage_id uuid)
returns public.case_workflow_stages language plpgsql security definer set search_path = '' as $$
declare
  s public.case_workflow_stages;
begin
  select * into s from public.case_workflow_stages where id = p_stage_id for update;
  if s.id is null then
    raise exception 'stage_not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.cases where id = s.case_id for update;
  if public.can_act_on_stage(p_stage_id) is not true then
    raise exception 'not_allowed_on_stage' using errcode = '42501';
  end if;
  return s;
end;
$$;

-- Close the running work session of a stage into time_spent_seconds.
create or replace function public._pause_clock(p_stage_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.case_workflow_stages
    set time_spent_seconds = time_spent_seconds
          + coalesce(greatest(0, extract(epoch from (now() - active_since)))::integer, 0),
        active_since = null
  where id = p_stage_id and active_since is not null;
$$;

create or replace function public._assign(p_stage_id uuid, p_employee uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s record;
begin
  select * into s from public.case_workflow_stages where id = p_stage_id;
  if s.assigned_employee_id is not distinct from p_employee then return; end if;
  update public.case_assignments set unassigned_at = now()
  where stage_id = p_stage_id and unassigned_at is null;
  update public.case_workflow_stages set assigned_employee_id = p_employee where id = p_stage_id;
  if p_employee is not null then
    insert into public.case_assignments (lab_id, case_id, stage_id, employee_id, assigned_by)
    values (s.lab_id, s.case_id, p_stage_id, p_employee, p_actor);
  end if;
  perform public._history(s.case_id, 'assigned', p_actor, null, p_stage_id,
    p_data => jsonb_build_object('employee_id', p_employee,
      'employee_name', (select full_name from public.employees where id = p_employee),
      'stage_name', s.name));
end;
$$;

-- Move the case pointer to a stage and notify its owners.
create or replace function public._activate_stage(
  p_case uuid, p_stage uuid, p_actor uuid, p_from_stage uuid, p_notes text, p_notify_type text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s record;
  v_type text;
begin
  select * into s from public.case_workflow_stages where id = p_stage;
  update public.case_workflow_stages
    set status = case when status = 'needs_revision' then status else 'pending' end,
        completed_at = null, completed_by = null, active_since = null
  where id = p_stage;
  update public.cases set current_stage_id = p_stage where id = p_case;
  perform public._history(p_case, 'transferred', p_actor, p_notes, p_stage, p_from_stage, p_stage,
    p_data => jsonb_build_object('stage_name', s.name));
  v_type := case when p_notify_type is not null then p_notify_type
                 when s.kind = 'ready' then 'ready_for_delivery'
                 when s.status = 'needs_revision' then 'revision_requested'
                 else 'case_arrived' end;
  perform public._notify_stage(p_stage, v_type,
    case v_type when 'ready_for_delivery' then 'Case ready for delivery'
                when 'qc_rejected' then 'Quality control rejected the case'
                when 'revision_requested' then 'Case returned for revision'
                else 'New case in your department' end,
    s.name, p_actor, jsonb_build_object('notes', p_notes));
  perform public._refresh_case_status(p_case);
end;
$$;

-- Replace the prescription (restorations, teeth, implants) of a case.
create or replace function public._save_prescription(p_case uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid;
  v_ids uuid[] := '{}';
  v_id uuid;
  r jsonb;
  i integer := 0;
  v_bad integer;
begin
  select lab_id into v_lab from public.cases where id = p_case;

  if jsonb_typeof(p->'teeth') is distinct from 'array' or jsonb_array_length(p->'teeth') = 0 then
    raise exception 'teeth_required' using errcode = 'P0001';
  end if;

  delete from public.case_teeth where case_id = p_case;
  delete from public.case_implants where case_id = p_case;
  delete from public.case_restorations where case_id = p_case;

  for r in select * from jsonb_array_elements(coalesce(p->'restorations', '[]'::jsonb)) loop
    i := i + 1;
    insert into public.case_restorations (
      lab_id, case_id, position, restoration_type_id, material_id, material_brand, material_type,
      shade, thickness, translucency, block_reference, lot_number, manufacturing_notes, notes)
    values (
      v_lab, p_case, i, (r->>'restoration_type_id')::uuid, nullif(r->>'material_id', '')::uuid,
      nullif(btrim(r->>'material_brand'), ''), nullif(btrim(r->>'material_type'), ''),
      nullif(btrim(r->>'shade'), ''), nullif(btrim(r->>'thickness'), ''),
      nullif(btrim(r->>'translucency'), ''), nullif(btrim(r->>'block_reference'), ''),
      nullif(btrim(r->>'lot_number'), ''), nullif(btrim(r->>'manufacturing_notes'), ''),
      nullif(btrim(r->>'notes'), ''))
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  insert into public.case_teeth (lab_id, case_id, tooth_number, is_missing, is_implant, bridge_group, restoration_id, notes)
  select v_lab, p_case, (t->>'tooth_number')::smallint,
         coalesce((t->>'is_missing')::boolean, false),
         coalesce((t->>'is_implant')::boolean, false),
         nullif(t->>'bridge_group', '')::smallint,
         case when t ? 'restoration_index' and (t->>'restoration_index') is not null
              then v_ids[(t->>'restoration_index')::integer + 1] end,
         nullif(btrim(t->>'notes'), '')
  from jsonb_array_elements(p->'teeth') t;

  -- teeth that reference a non-existent restoration index
  if exists (
    select 1 from jsonb_array_elements(p->'teeth') t
    where (t->>'restoration_index') is not null
      and ((t->>'restoration_index')::integer < 0 or (t->>'restoration_index')::integer >= coalesce(array_length(v_ids, 1), 0))
  ) then
    raise exception 'invalid_restoration_index' using errcode = 'P0001';
  end if;

  -- a bridge must stay within one arch and contain at least two teeth
  select count(*) into v_bad from (
    select bridge_group
    from public.case_teeth where case_id = p_case and bridge_group is not null
    group by bridge_group
    having count(*) < 2 or count(distinct (tooth_number / 10) in (1, 2)) > 1
  ) x;
  if v_bad > 0 then
    raise exception 'invalid_bridge' using errcode = 'P0001';
  end if;

  insert into public.case_implants (
    lab_id, case_id, tooth_number, brand_id, brand_name, system_name, connection, platform,
    diameter_mm, length_mm, scanbody_manufacturer, scanbody_reference, tibase_type, screw_channel,
    angulation_degrees, library_reference, notes)
  select v_lab, p_case, (m->>'tooth_number')::smallint, nullif(m->>'brand_id', '')::uuid,
         nullif(btrim(m->>'brand_name'), ''), nullif(btrim(m->>'system_name'), ''),
         nullif(btrim(m->>'connection'), ''), nullif(btrim(m->>'platform'), ''),
         nullif(m->>'diameter_mm', '')::numeric, nullif(m->>'length_mm', '')::numeric,
         nullif(btrim(m->>'scanbody_manufacturer'), ''), nullif(btrim(m->>'scanbody_reference'), ''),
         nullif(btrim(m->>'tibase_type'), ''), nullif(m->>'screw_channel', ''),
         nullif(m->>'angulation_degrees', '')::numeric, nullif(btrim(m->>'library_reference'), ''),
         nullif(btrim(m->>'notes'), '')
  from jsonb_array_elements(coalesce(p->'implants', '[]'::jsonb)) m;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Create a complete case (patient, prescription, workflow) atomically.
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

create or replace function public.update_case_prescription(p_case_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  c record;
begin
  select * into c from public.cases where id = p_case_id for update;
  if c.id is null or c.lab_id <> me.lab_id or not public.can_view_case(p_case_id) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if not public.has_permission('cases.edit') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if c.status in ('delivered', 'cancelled') then
    raise exception 'case_closed' using errcode = 'P0001';
  end if;
  perform public._save_prescription(p_case_id, p);
  perform public._history(p_case_id, 'updated', me.id, null, p_data => jsonb_build_object('section', 'prescription'));
end;
$$;

-- Start (or resume) work on the current stage. An unassigned stage is claimed.
create or replace function public.start_stage(p_stage_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s public.case_workflow_stages := public._lock_stage(p_stage_id);
begin
  if s.status not in ('pending', 'waiting', 'needs_revision') then
    raise exception 'invalid_stage_status' using errcode = 'P0001';
  end if;
  if s.assigned_employee_id is null then
    perform public._assign(p_stage_id, me.id, me.id);
  end if;
  update public.case_workflow_stages
    set status = 'in_progress', started_at = coalesce(started_at, now()), active_since = now()
  where id = p_stage_id;
  perform public._history(s.case_id, 'stage_started', me.id, null, p_stage_id, p_status => 'in_progress',
    p_data => jsonb_build_object('stage_name', s.name));
  perform public._refresh_case_status(s.case_id);
end;
$$;

-- Put the current stage on hold (waiting) or back to in progress.
create or replace function public.set_stage_status(p_stage_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s public.case_workflow_stages := public._lock_stage(p_stage_id);
begin
  if p_status not in ('waiting', 'in_progress') then
    raise exception 'invalid_stage_status' using errcode = 'P0001';
  end if;
  if s.status in ('completed', 'rejected', 'skipped') then
    raise exception 'invalid_stage_status' using errcode = 'P0001';
  end if;
  if p_status = 'waiting' then
    perform public._pause_clock(p_stage_id);
    update public.case_workflow_stages set status = 'waiting' where id = p_stage_id;
  else
    if s.assigned_employee_id is null then
      perform public._assign(p_stage_id, me.id, me.id);
    end if;
    update public.case_workflow_stages
      set status = 'in_progress', started_at = coalesce(started_at, now()), active_since = coalesce(active_since, now())
    where id = p_stage_id;
  end if;
  perform public._history(s.case_id, 'stage_status', me.id, p_note, p_stage_id, p_status => p_status,
    p_data => jsonb_build_object('stage_name', s.name));
  perform public._refresh_case_status(s.case_id);
end;
$$;

-- Complete the current stage and hand the case to the next stage.
-- p_next_assignee optionally hands it to a specific colleague of the next
-- department (or anybody, for holders of workflow.assign).
create or replace function public.complete_and_transfer(
  p_stage_id uuid, p_notes text default null, p_next_assignee uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s public.case_workflow_stages := public._lock_stage(p_stage_id);
  v_next record;
  v_assignee record;
begin
  if s.kind not in ('reception', 'production') then
    raise exception 'use_dedicated_action' using errcode = 'P0001';
  end if;
  if s.status in ('completed', 'rejected', 'skipped') then
    raise exception 'invalid_stage_status' using errcode = 'P0001';
  end if;

  perform public._pause_clock(p_stage_id);
  update public.case_workflow_stages
    set status = 'completed', started_at = coalesce(started_at, now()), completed_at = now(),
        completed_by = me.id, assigned_employee_id = coalesce(assigned_employee_id, me.id),
        notes = case when nullif(btrim(coalesce(p_notes, '')), '') is null then notes
                     else concat_ws(E'\n', notes, btrim(p_notes)) end
  where id = p_stage_id;

  select * into v_next from public.case_workflow_stages
  where case_id = s.case_id and position > s.position and status <> 'skipped'
  order by position limit 1;
  if v_next.id is null then
    perform public._history(s.case_id, 'stage_status', me.id, p_notes, p_stage_id, p_status => 'completed');
    perform public._refresh_case_status(s.case_id);
    return null;
  end if;

  if p_next_assignee is not null then
    select * into v_assignee from public.employees
    where id = p_next_assignee and lab_id = me.lab_id and status = 'active';
    if v_assignee.id is null then
      raise exception 'invalid_assignee' using errcode = 'P0001';
    end if;
    if v_assignee.department_id is distinct from v_next.department_id
       and not public.has_permission('workflow.assign') then
      raise exception 'assignee_not_in_department' using errcode = '42501';
    end if;
    perform public._assign(v_next.id, p_next_assignee, me.id);
  end if;

  perform public._activate_stage(s.case_id, v_next.id, me.id, p_stage_id, p_notes);
  return v_next.id;
end;
$$;

-- Return the case from the current stage to an earlier stage (needs revision).
create or replace function public._return_to_stage(
  s public.case_workflow_stages, p_target uuid, p_reason text, p_actor uuid, p_status public.stage_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
begin
  select * into t from public.case_workflow_stages where id = p_target and case_id = s.case_id;
  if t.id is null or t.position >= s.position or t.kind not in ('reception', 'production') then
    raise exception 'invalid_return_stage' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  perform public._pause_clock(s.id);
  update public.case_workflow_stages
    set status = p_status,
        completed_at = case when p_status = 'rejected' then now() end,
        completed_by = case when p_status = 'rejected' then p_actor end
  where id = s.id;
  -- stages between the target and the current one must be redone
  update public.case_workflow_stages
    set status = 'pending', completed_at = null, completed_by = null, active_since = null
  where case_id = s.case_id and position > t.position and position < s.position;
  update public.case_workflow_stages
    set status = 'needs_revision', completed_at = null, completed_by = null, active_since = null,
        revision_count = revision_count + 1
  where id = t.id;
  perform public._activate_stage(s.case_id, t.id, p_actor, s.id, p_reason,
    case when p_status = 'rejected' then 'qc_rejected' else 'revision_requested' end);
end;
$$;

create or replace function public.return_case_to_stage(p_stage_id uuid, p_return_to_stage_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s public.case_workflow_stages := public._lock_stage(p_stage_id);
begin
  if s.kind = 'qc' then
    raise exception 'use_dedicated_action' using errcode = 'P0001';
  end if;
  perform public._return_to_stage(s, p_return_to_stage_id, p_reason, me.id, 'pending');
end;
$$;

-- Quality control decision on the current QC stage.
create or replace function public.qc_decision(
  p_stage_id uuid, p_result text, p_reason text default null,
  p_return_to_stage_id uuid default null, p_checklist jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s public.case_workflow_stages := public._lock_stage(p_stage_id);
  v_next uuid;
  v_target uuid := p_return_to_stage_id;
begin
  if s.kind <> 'qc' then
    raise exception 'not_a_qc_stage' using errcode = 'P0001';
  end if;
  if p_result not in ('passed', 'failed') then
    raise exception 'invalid_result' using errcode = 'P0001';
  end if;

  if p_result = 'failed' then
    if v_target is null then
      -- default: the last production stage before QC
      select id into v_target from public.case_workflow_stages
      where case_id = s.case_id and position < s.position and kind = 'production'
      order by position desc limit 1;
    end if;
    insert into public.quality_control (lab_id, case_id, stage_id, inspector_id, result, checklist, reason, return_to_stage_id)
    values (s.lab_id, s.case_id, s.id, me.id, 'failed', coalesce(p_checklist, '{}'::jsonb), p_reason, v_target);
    perform public._history(s.case_id, 'qc_failed', me.id, p_reason, s.id, s.id, v_target);
    perform public._return_to_stage(s, v_target, p_reason, me.id, 'rejected');
    return;
  end if;

  insert into public.quality_control (lab_id, case_id, stage_id, inspector_id, result, checklist, reason)
  values (s.lab_id, s.case_id, s.id, me.id, 'passed', coalesce(p_checklist, '{}'::jsonb), nullif(btrim(coalesce(p_reason, '')), ''));
  perform public._pause_clock(s.id);
  update public.case_workflow_stages
    set status = 'completed', started_at = coalesce(started_at, now()), completed_at = now(),
        completed_by = me.id, assigned_employee_id = coalesce(assigned_employee_id, me.id)
  where id = s.id;
  perform public._history(s.case_id, 'qc_passed', me.id, p_reason, s.id);

  select id into v_next from public.case_workflow_stages
  where case_id = s.case_id and position > s.position and status <> 'skipped'
  order by position limit 1;
  if v_next is not null then
    perform public._activate_stage(s.case_id, v_next, me.id, s.id, p_reason);
  else
    perform public._refresh_case_status(s.case_id);
  end if;
end;
$$;

-- Hand the finished case over to the client.
create or replace function public.record_delivery(
  p_case_id uuid, p_recipient text default null, p_method text default 'pickup',
  p_tracking text default null, p_notes text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  c record;
  s public.case_workflow_stages;
  r record;
begin
  select * into c from public.cases where id = p_case_id for update;
  if c.id is null or c.lab_id <> me.lab_id or not public.can_view_case(p_case_id) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if not (public.has_permission('delivery.manage') or public.has_permission('workflow.transfer_any')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into s from public.case_workflow_stages where id = c.current_stage_id;
  if s.kind not in ('ready', 'delivered') then
    raise exception 'case_not_ready' using errcode = 'P0001';
  end if;

  perform public._pause_clock(s.id);
  update public.case_workflow_stages
    set status = 'completed', started_at = coalesce(started_at, now()), completed_at = now(),
        completed_by = me.id, assigned_employee_id = coalesce(assigned_employee_id, me.id)
  where case_id = p_case_id and kind in ('ready', 'delivered') and status <> 'completed';

  update public.cases
    set status = 'delivered', delivered_at = now(), completed_at = coalesce(completed_at, now()),
        current_stage_id = coalesce(
          (select id from public.case_workflow_stages where case_id = p_case_id and kind = 'delivered'
           order by position desc limit 1), current_stage_id)
  where id = p_case_id;

  insert into public.deliveries (lab_id, case_id, delivered_by, recipient_name, method, tracking_reference, notes)
  values (c.lab_id, p_case_id, me.id, nullif(btrim(coalesce(p_recipient, '')), ''),
          coalesce(nullif(p_method, ''), 'pickup'), nullif(btrim(coalesce(p_tracking, '')), ''),
          nullif(btrim(coalesce(p_notes, '')), ''));
  perform public._history(p_case_id, 'delivered', me.id, p_notes, s.id,
    p_data => jsonb_build_object('recipient', p_recipient, 'method', p_method));

  for r in select distinct x from unnest(array[c.created_by, c.assigned_technician_id]) x where x is not null and x <> me.id loop
    perform public._notify(c.lab_id, r.x, p_case_id, 'case_delivered', 'Case delivered', c.case_number,
      jsonb_build_object('case_number', c.case_number));
  end loop;
end;
$$;

-- Assign / reassign the employee responsible for a stage. Employees may claim
-- an unassigned stage of their own department.
create or replace function public.assign_stage(p_stage_id uuid, p_employee_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  s record;
  e record;
begin
  select st.*, c.lab_id as c_lab, c.status as case_status, c.case_number
    into s
  from public.case_workflow_stages st join public.cases c on c.id = st.case_id
  where st.id = p_stage_id for update of st;
  if s.id is null or s.c_lab <> me.lab_id or not public.can_view_case(s.case_id) then
    raise exception 'stage_not_found' using errcode = 'P0002';
  end if;
  if s.status in ('completed', 'skipped') or s.case_status in ('delivered', 'cancelled') then
    raise exception 'invalid_stage_status' using errcode = 'P0001';
  end if;
  if p_employee_id is not null then
    select * into e from public.employees where id = p_employee_id and lab_id = me.lab_id and status = 'active';
    if e.id is null then
      raise exception 'invalid_assignee' using errcode = 'P0001';
    end if;
  end if;
  if not public.has_permission('workflow.assign') then
    -- self-claim only
    if p_employee_id is distinct from me.id or s.assigned_employee_id is not null
       or s.department_id is distinct from me.department_id then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
  end if;

  perform public._assign(p_stage_id, p_employee_id, me.id);
  if p_employee_id is not null and p_employee_id <> me.id then
    perform public._notify(me.lab_id, p_employee_id, s.case_id, 'case_assigned', 'A case was assigned to you',
      s.name, jsonb_build_object('case_number', s.case_number, 'stage_name', s.name, 'stage_id', s.id));
  end if;
end;
$$;

create or replace function public.add_case_note(p_case_id uuid, p_note text, p_stage_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
begin
  if not public.can_view_case(p_case_id) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'note_required' using errcode = 'P0001';
  end if;
  if p_stage_id is not null and not exists (
    select 1 from public.case_workflow_stages where id = p_stage_id and case_id = p_case_id) then
    raise exception 'stage_not_found' using errcode = 'P0002';
  end if;
  perform public._history(p_case_id, 'note', me.id, p_note, p_stage_id);
end;
$$;

create or replace function public.cancel_case(p_case_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  c record;
begin
  select * into c from public.cases where id = p_case_id for update;
  if c.id is null or c.lab_id <> me.lab_id then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if not public.has_permission('cases.cancel') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if c.status in ('delivered', 'cancelled') then
    raise exception 'case_closed' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  update public.case_workflow_stages set active_since = null where case_id = p_case_id;
  update public.cases set status = 'cancelled', cancelled_at = now() where id = p_case_id;
  perform public._history(p_case_id, 'cancelled', me.id, p_reason);
end;
$$;

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
create trigger attachments_history_ins after insert on public.attachments
  for each row execute function public._attachment_history();
create trigger attachments_history_del after delete on public.attachments
  for each row execute function public._attachment_history();

-- ---------------------------------------------------------------------------
-- Read models (SECURITY INVOKER: they run with the caller's RLS)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'all',          count(*) filter (where c.status <> 'cancelled'),
    'new',          count(*) filter (where c.status = 'new'),
    'in_progress',  count(*) filter (where c.status = 'in_progress'),
    'waiting',      count(*) filter (where c.status = 'waiting'),
    'in_production',count(*) filter (where c.status in ('new', 'in_progress', 'waiting', 'ready_for_qc')),
    'ready_for_qc', count(*) filter (where c.status = 'ready_for_qc'),
    'completed',    count(*) filter (where c.status = 'completed'),
    'delivered',    count(*) filter (where c.status = 'delivered'),
    'cancelled',    count(*) filter (where c.status = 'cancelled'),
    'delayed',      count(*) filter (where c.due_date < current_date and c.status not in ('delivered', 'cancelled')),
    'my_tasks', (
      select count(*) from public.cases c2
      join public.case_workflow_stages s on s.id = c2.current_stage_id
      where c2.status not in ('delivered', 'cancelled')
        and (s.assigned_employee_id = public.current_employee_id()
             or (s.assigned_employee_id is null and s.department_id = public.current_department_id()))
    )
  )
  from public.cases c;
$$;

-- Deadline scanner (used by pg_cron for all labs and on demand per lab).
create or replace function public._check_deadlines(p_lab uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c record;
  r record;
  v_count integer := 0;
  v_hours integer;
begin
  for c in
    select ca.*, l.settings, s.assigned_employee_id as s_emp, s.department_id as s_dep
    from public.cases ca
    join public.laboratories l on l.id = ca.lab_id
    left join public.case_workflow_stages s on s.id = ca.current_stage_id
    where (p_lab is null or ca.lab_id = p_lab)
      and l.status in ('active', 'trial')
      and ca.status not in ('delivered', 'cancelled', 'completed')
  loop
    v_hours := coalesce((c.settings->>'deadline_warning_hours')::integer, 24);
    for r in
      select e.id from public.employees e
      where e.lab_id = c.lab_id and e.status = 'active'
        and (e.id = c.s_emp or e.id = c.created_by
             or (c.s_emp is null and c.s_dep is not null and e.department_id = c.s_dep))
    loop
      if c.due_date < current_date then
        perform public._notify(c.lab_id, r.id, c.id, 'case_delayed', 'Case is delayed', c.case_number,
          jsonb_build_object('case_number', c.case_number, 'due_date', c.due_date),
          'delayed:' || c.id || ':' || current_date);
        v_count := v_count + 1;
      elsif (c.due_date::timestamptz) <= now() + make_interval(hours => v_hours) then
        perform public._notify(c.lab_id, r.id, c.id, 'deadline_approaching', 'Deadline approaching', c.case_number,
          jsonb_build_object('case_number', c.case_number, 'due_date', c.due_date),
          'deadline:' || c.id);
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;
  return v_count;
end;
$$;

create or replace function public.check_deadlines()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_lab uuid := public.current_lab_id();
begin
  if v_lab is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return public._check_deadlines(v_lab);
end;
$$;

create or replace function public.update_my_profile(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
begin
  update public.employees set
    phone = case when p ? 'phone' then nullif(btrim(p->>'phone'), '') else phone end,
    email = case when p ? 'email' then nullif(btrim(p->>'email'), '') else email end,
    avatar_path = case when p ? 'avatar_path' then nullif(p->>'avatar_path', '') else avatar_path end,
    preferred_language = case when p ? 'preferred_language' then p->>'preferred_language' else preferred_language end
  where id = me.id;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns void language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
  where recipient_id = public.current_employee_id() and read_at is null;
$$;

-- Replace the stages of a workflow template (existing cases keep their copy).
create or replace function public.save_workflow_template(p_template_id uuid, p_name text, p_stages jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  t record;
  v_n integer;
begin
  if not public.has_permission('workflow.configure') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into t from public.workflow_templates where id = p_template_id and lab_id = me.lab_id for update;
  if t.id is null then
    raise exception 'template_not_found' using errcode = 'P0002';
  end if;
  v_n := jsonb_array_length(coalesce(p_stages, '[]'::jsonb));
  if v_n < 2 then
    raise exception 'workflow_too_short' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(p_stages) x where x->>'kind' = 'production') = 0 then
    raise exception 'workflow_needs_production_stage' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(p_stages) x where x->>'kind' in ('reception', 'ready', 'delivered')
      group by x->>'kind' order by 1 desc limit 1) > 1 then
    raise exception 'duplicate_special_stage' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_stages) with ordinality x(v, i)
             where v->>'kind' = 'delivered' and i <> v_n) then
    raise exception 'delivered_must_be_last' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_stages) with ordinality x(v, i)
             where v->>'kind' = 'reception' and i <> 1) then
    raise exception 'reception_must_be_first' using errcode = 'P0001';
  end if;

  update public.workflow_templates set name = coalesce(nullif(btrim(p_name), ''), name) where id = t.id;
  delete from public.workflow_stages where template_id = t.id;
  insert into public.workflow_stages (lab_id, template_id, position, name, kind, department_id, default_assignee_id, expected_hours)
  select me.lab_id, t.id, i::integer, btrim(v->>'name'), (v->>'kind')::public.stage_kind,
         nullif(v->>'department_id', '')::uuid, nullif(v->>'default_assignee_id', '')::uuid,
         nullif(v->>'expected_hours', '')::numeric
  from jsonb_array_elements(p_stages) with ordinality x(v, i);
end;
$$;

create or replace function public.save_role_permissions(p_role_id uuid, p_permissions text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  me public.employees := public._me();
  r record;
begin
  if not public.has_permission('employees.manage') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into r from public.roles where id = p_role_id and lab_id = me.lab_id;
  if r.id is null then
    raise exception 'role_not_found' using errcode = 'P0002';
  end if;
  delete from public.role_permissions where role_id = r.id;
  insert into public.role_permissions (lab_id, role_id, permission_code)
  select me.lab_id, r.id, p.code from public.permissions p where p.code = any(p_permissions);
  if not exists (
    select 1 from public.employees e
    join public.role_permissions rp on rp.role_id = e.role_id and rp.permission_code = 'employees.manage'
    where e.lab_id = me.lab_id and e.status = 'active'
  ) then
    raise exception 'The laboratory must keep at least one active administrator' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on function public._me() from authenticated;
revoke execute on function public._notify(uuid, uuid, uuid, text, text, text, jsonb, text) from authenticated;
revoke execute on function public._notify_stage(uuid, text, text, text, uuid, jsonb) from authenticated;
revoke execute on function public._history(uuid, text, uuid, text, uuid, uuid, uuid, text, jsonb) from authenticated;
revoke execute on function public._refresh_case_status(uuid) from authenticated;
revoke execute on function public._lock_stage(uuid) from authenticated;
revoke execute on function public._pause_clock(uuid) from authenticated;
revoke execute on function public._assign(uuid, uuid, uuid) from authenticated;
revoke execute on function public._activate_stage(uuid, uuid, uuid, uuid, text, text) from authenticated;
revoke execute on function public._save_prescription(uuid, jsonb) from authenticated;
revoke execute on function public._return_to_stage(public.case_workflow_stages, uuid, text, uuid, public.stage_status) from authenticated;
revoke execute on function public._check_deadlines(uuid) from authenticated;
revoke execute on function public._attachment_history() from authenticated;

grant execute on function public.can_act_on_stage(uuid) to authenticated;
grant execute on function public.create_case(jsonb) to authenticated;
grant execute on function public.update_case_prescription(uuid, jsonb) to authenticated;
grant execute on function public.start_stage(uuid) to authenticated;
grant execute on function public.set_stage_status(uuid, text, text) to authenticated;
grant execute on function public.complete_and_transfer(uuid, text, uuid) to authenticated;
grant execute on function public.return_case_to_stage(uuid, uuid, text) to authenticated;
grant execute on function public.qc_decision(uuid, text, text, uuid, jsonb) to authenticated;
grant execute on function public.record_delivery(uuid, text, text, text, text) to authenticated;
grant execute on function public.assign_stage(uuid, uuid) to authenticated;
grant execute on function public.add_case_note(uuid, text, uuid) to authenticated;
grant execute on function public.cancel_case(uuid, text) to authenticated;
grant execute on function public.dashboard_stats() to authenticated;
grant execute on function public.check_deadlines() to authenticated;
grant execute on function public.update_my_profile(jsonb) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.save_workflow_template(uuid, text, jsonb) to authenticated;
grant execute on function public.save_role_permissions(uuid, text[]) to authenticated;
grant execute on function public.get_lab_login_info(text) to anon, authenticated;
