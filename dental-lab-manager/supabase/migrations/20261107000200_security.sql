-- =============================================================================
-- Dental Lab Manager — permissions catalog, identity helpers, RLS and grants
-- Authorization is enforced here in the database; the app's UI checks are only
-- a convenience layer on top of these rules.
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('cases.view_all',        'cases',     'View every case of the laboratory'),
  ('cases.create',          'cases',     'Create new cases and patients'),
  ('cases.edit',            'cases',     'Edit case information and prescriptions'),
  ('cases.cancel',          'cases',     'Cancel cases'),
  ('workflow.transfer_any', 'workflow',  'Complete / transfer any stage (supervisor override)'),
  ('workflow.assign',       'workflow',  'Assign or reassign employees to stages'),
  ('workflow.configure',    'workflow',  'Configure workflow templates'),
  ('qc.perform',            'quality',   'Perform quality control decisions'),
  ('delivery.manage',       'delivery',  'Record deliveries'),
  ('attachments.upload',    'files',     'Upload attachments to any visible case'),
  ('attachments.delete_any','files',     'Delete attachments uploaded by others'),
  ('doctors.manage',        'clients',   'Create and edit doctors / clients'),
  ('employees.manage',      'admin',     'Manage employees, credentials and roles'),
  ('lab.settings',          'admin',     'Edit laboratory profile and catalogs'),
  ('reports.view',          'reports',   'View laboratory-wide reports'),
  ('audit.view',            'admin',     'View the audit log');

-- ---------------------------------------------------------------------------
-- Identity helpers (SECURITY DEFINER so they can be used inside RLS policies
-- without recursive policy evaluation). All pin search_path.
-- ---------------------------------------------------------------------------
create or replace function public.current_employee_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id
  from public.employees e
  join public.laboratories l on l.id = e.lab_id
  where e.auth_user_id = auth.uid()
    and e.status = 'active'
    and l.status in ('active', 'trial')
  limit 1;
$$;

create or replace function public.current_lab_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select e.lab_id
  from public.employees e
  join public.laboratories l on l.id = e.lab_id
  where e.auth_user_id = auth.uid()
    and e.status = 'active'
    and l.status in ('active', 'trial')
  limit 1;
$$;

create or replace function public.current_department_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select e.department_id from public.employees e
  where e.id = public.current_employee_id();
$$;

create or replace function public.has_permission(p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.employees e
    join public.role_permissions rp on rp.role_id = e.role_id
    where e.id = public.current_employee_id()
      and rp.permission_code = p_code
  );
$$;

create or replace function public.my_permissions()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(rp.permission_code order by rp.permission_code), '{}')
  from public.employees e
  join public.role_permissions rp on rp.role_id = e.role_id
  where e.id = public.current_employee_id();
$$;

-- A case is visible to: holders of cases.view_all, its creator, its assigned
-- technician, and any employee assigned to (or in the department of) one of
-- its workflow stages.
create or replace function public.can_view_case(p_case_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := public.current_employee_id();
  v_lab uuid;
  v_dep uuid;
begin
  if v_emp is null or p_case_id is null then
    return false;
  end if;
  select lab_id, department_id into v_lab, v_dep from public.employees where id = v_emp;
  if not exists (select 1 from public.cases c where c.id = p_case_id and c.lab_id = v_lab) then
    return false;
  end if;
  if public.has_permission('cases.view_all') then
    return true;
  end if;
  return exists (
    select 1 from public.cases c
    where c.id = p_case_id
      and (c.created_by = v_emp or c.assigned_technician_id = v_emp)
  ) or exists (
    select 1 from public.case_workflow_stages s
    where s.case_id = p_case_id
      and (s.assigned_employee_id = v_emp or (v_dep is not null and s.department_id = v_dep))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.laboratories          enable row level security;
alter table public.lab_counters          enable row level security;
alter table public.departments           enable row level security;
alter table public.permissions           enable row level security;
alter table public.roles                 enable row level security;
alter table public.role_permissions      enable row level security;
alter table public.employees             enable row level security;
alter table public.employee_credentials  enable row level security;
alter table public.doctors               enable row level security;
alter table public.patients              enable row level security;
alter table public.restoration_types     enable row level security;
alter table public.materials             enable row level security;
alter table public.implant_brands        enable row level security;
alter table public.implant_systems       enable row level security;
alter table public.workflow_templates    enable row level security;
alter table public.workflow_stages       enable row level security;
alter table public.cases                 enable row level security;
alter table public.case_restorations     enable row level security;
alter table public.case_teeth            enable row level security;
alter table public.case_implants         enable row level security;
alter table public.case_workflow_stages  enable row level security;
alter table public.case_assignments      enable row level security;
alter table public.case_history          enable row level security;
alter table public.attachments           enable row level security;
alter table public.notifications         enable row level security;
alter table public.quality_control       enable row level security;
alter table public.deliveries            enable row level security;
alter table public.audit_logs            enable row level security;

-- Start from zero privileges for client roles; grant precisely below.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Laboratories ---------------------------------------------------------------
create policy labs_select on public.laboratories for select to authenticated
  using (id = public.current_lab_id());
create policy labs_update on public.laboratories for update to authenticated
  using (id = public.current_lab_id() and public.has_permission('lab.settings'))
  with check (id = public.current_lab_id());
grant select on public.laboratories to authenticated;
-- status / plan / code are platform-controlled and not client-updatable
grant update (name, logo_path, phone, email, address, city, country, settings)
  on public.laboratories to authenticated;

-- Permissions catalog (global, read-only)
create policy permissions_select on public.permissions for select to authenticated using (true);
grant select on public.permissions to authenticated;

-- Generic "lab catalog" tables: everyone in the lab reads, a permission writes.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('departments',        'employees.manage'),
      ('roles',              'employees.manage'),
      ('role_permissions',   'employees.manage'),
      ('restoration_types',  'lab.settings'),
      ('materials',          'lab.settings'),
      ('implant_brands',     'lab.settings'),
      ('implant_systems',    'lab.settings'),
      ('workflow_templates', 'workflow.configure'),
      ('workflow_stages',    'workflow.configure'),
      ('doctors',            'doctors.manage')
    ) as x(tbl, perm)
  loop
    execute format(
      'create policy %1$s_select on public.%1$I for select to authenticated using (lab_id = public.current_lab_id())',
      t.tbl);
    execute format(
      'create policy %1$s_insert on public.%1$I for insert to authenticated with check (lab_id = public.current_lab_id() and public.has_permission(%2$L))',
      t.tbl, t.perm);
    execute format(
      'create policy %1$s_update on public.%1$I for update to authenticated using (lab_id = public.current_lab_id() and public.has_permission(%2$L)) with check (lab_id = public.current_lab_id())',
      t.tbl, t.perm);
    execute format(
      'create policy %1$s_delete on public.%1$I for delete to authenticated using (lab_id = public.current_lab_id() and public.has_permission(%2$L))',
      t.tbl, t.perm);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t.tbl);
  end loop;
end;
$$;

-- System roles cannot be deleted or renamed away from their code
create or replace function public.protect_system_roles()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.is_system then
    raise exception 'System roles cannot be deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.is_system and (new.code <> old.code or not new.is_system) then
    raise exception 'System role code cannot be changed' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger roles_protect before update or delete on public.roles
  for each row execute function public.protect_system_roles();

-- Employees ------------------------------------------------------------------
create policy employees_select on public.employees for select to authenticated
  using (lab_id = public.current_lab_id());
create policy employees_update on public.employees for update to authenticated
  using (lab_id = public.current_lab_id() and public.has_permission('employees.manage'))
  with check (lab_id = public.current_lab_id());
grant select on public.employees to authenticated;
-- auth_user_id / lab_id / code are only set by the provisioning edge function
grant update (full_name, avatar_path, department_id, role_id, specialty, phone, email, status, preferred_language)
  on public.employees to authenticated;

-- Never let a laboratory lose its last active administrator.
create or replace function public.guard_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_remaining integer;
begin
  if (old.status = 'active' and new.status <> 'active') or new.role_id <> old.role_id then
    select count(*) into v_remaining
    from public.employees e
    join public.role_permissions rp on rp.role_id = e.role_id and rp.permission_code = 'employees.manage'
    where e.lab_id = old.lab_id and e.status = 'active' and e.id <> old.id;
    if v_remaining = 0 and not (
      new.status = 'active' and exists (
        select 1 from public.role_permissions rp
        where rp.role_id = new.role_id and rp.permission_code = 'employees.manage')
    ) then
      raise exception 'The laboratory must keep at least one active administrator'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger employees_guard_last_admin before update on public.employees
  for each row execute function public.guard_last_admin();

-- employee_credentials and lab_counters: RLS on, no policies, no grants ->
-- unreachable by anon/authenticated. Only SECURITY DEFINER functions and the
-- service role touch them.

-- Patients -------------------------------------------------------------------
create policy patients_select on public.patients for select to authenticated
  using (lab_id = public.current_lab_id());
create policy patients_insert on public.patients for insert to authenticated
  with check (lab_id = public.current_lab_id() and public.has_permission('cases.create'));
create policy patients_update on public.patients for update to authenticated
  using (lab_id = public.current_lab_id() and public.has_permission('cases.edit'))
  with check (lab_id = public.current_lab_id());
grant select, insert, update on public.patients to authenticated;

-- Cases: creation and workflow changes go through RPCs; plain edits allowed
-- on descriptive columns only.
create policy cases_select on public.cases for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(id));
create policy cases_update on public.cases for update to authenticated
  using (lab_id = public.current_lab_id() and public.has_permission('cases.edit') and public.can_view_case(id))
  with check (lab_id = public.current_lab_id());
grant select on public.cases to authenticated;
grant update (patient_id, doctor_id, assigned_technician_id, due_date, priority, shade, notes)
  on public.cases to authenticated;

-- Case child tables: read when the case is visible; writes through RPCs.
create policy case_restorations_select on public.case_restorations for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy case_teeth_select on public.case_teeth for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy case_implants_select on public.case_implants for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy cws_select on public.case_workflow_stages for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy case_assignments_select on public.case_assignments for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy case_history_select on public.case_history for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy quality_control_select on public.quality_control for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy deliveries_select on public.deliveries for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
grant select on public.case_restorations, public.case_teeth, public.case_implants,
  public.case_workflow_stages, public.case_assignments, public.case_history,
  public.quality_control, public.deliveries to authenticated;

-- Attachments ----------------------------------------------------------------
-- Upload allowed to holders of attachments.upload, or to employees working on
-- one of the case's stages.
create or replace function public.can_upload_to_case(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_view_case(p_case_id) and (
    public.has_permission('attachments.upload')
    or exists (
      select 1 from public.case_workflow_stages s
      where s.case_id = p_case_id
        and (s.assigned_employee_id = public.current_employee_id()
             or s.department_id = public.current_department_id())
    )
  );
$$;

create or replace function public.can_delete_attachment_path(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.attachments a
    where a.storage_path = p_path
      and a.lab_id = public.current_lab_id()
      and public.can_view_case(a.case_id)
      and (a.uploaded_by = public.current_employee_id() or public.has_permission('attachments.delete_any'))
  );
$$;

create policy attachments_select on public.attachments for select to authenticated
  using (lab_id = public.current_lab_id() and public.can_view_case(case_id));
create policy attachments_insert on public.attachments for insert to authenticated
  with check (
    lab_id = public.current_lab_id()
    and uploaded_by = public.current_employee_id()
    and public.can_upload_to_case(case_id)
  );
create policy attachments_delete on public.attachments for delete to authenticated
  using (public.can_delete_attachment_path(storage_path));
grant select, insert, delete on public.attachments to authenticated;

-- Notifications: own only; may only toggle read_at.
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = public.current_employee_id());
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = public.current_employee_id())
  with check (recipient_id = public.current_employee_id());
create policy notifications_delete on public.notifications for delete to authenticated
  using (recipient_id = public.current_employee_id());
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Audit log: read-only for holders of audit.view
create policy audit_select on public.audit_logs for select to authenticated
  using (lab_id = public.current_lab_id() and public.has_permission('audit.view'));
grant select on public.audit_logs to authenticated;

-- Helper functions callable by signed-in users
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_lab_id() to authenticated;
grant execute on function public.current_department_id() to authenticated;
grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.my_permissions() to authenticated;
grant execute on function public.can_view_case(uuid) to authenticated;
grant execute on function public.can_upload_to_case(uuid) to authenticated;
grant execute on function public.can_delete_attachment_path(text) to authenticated;
grant execute on function public.is_valid_fdi_tooth(integer) to authenticated;
