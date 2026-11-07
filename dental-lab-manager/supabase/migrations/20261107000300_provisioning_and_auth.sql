-- =============================================================================
-- Dental Lab Manager — laboratory provisioning & employee credential functions
-- These functions are executable by the service role only (called from Edge
-- Functions). The anon role may only call get_lab_login_info().
-- =============================================================================

-- Seed the default catalogs, departments, roles and workflow for a new lab.
create or replace function public.seed_lab_defaults(p_lab_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_template uuid;
  v_dep record;
begin
  insert into public.lab_counters (lab_id) values (p_lab_id) on conflict do nothing;

  insert into public.departments (lab_id, code, name, icon, sort_order) values
    (p_lab_id, 'ADMIN',     'Administration',  'shield',     0),
    (p_lab_id, 'RECEPTION', 'Reception',       'user-round', 1),
    (p_lab_id, 'CAD',       'CAD Design',      'monitor',    2),
    (p_lab_id, 'CAM',       'Milling / CAM',   'drill',      3),
    (p_lab_id, 'CERAMIC',   'Ceramics',        'tooth',      4),
    (p_lab_id, 'FINISHING', 'Finishing',       'hammer',     5),
    (p_lab_id, 'QC',        'Quality Control', 'shield-check', 6),
    (p_lab_id, 'DELIVERY',  'Delivery',        'truck',      7);

  insert into public.roles (lab_id, code, name, description, is_system) values
    (p_lab_id, 'ADMIN',     'Administrator',        'Full access to the laboratory', true),
    (p_lab_id, 'RECEPTION', 'Reception',            'Registers cases, doctors and deliveries', true),
    (p_lab_id, 'CAD',       'CAD Designer',         'Digital design', true),
    (p_lab_id, 'CAM',       'Milling / CAM Technician', 'Milling and printing', true),
    (p_lab_id, 'CERAMIST',  'Ceramist',             'Ceramic layering and staining', true),
    (p_lab_id, 'FINISHING', 'Finishing Technician', 'Finishing and polishing', true),
    (p_lab_id, 'QC',        'Quality Control',      'Final inspection', true),
    (p_lab_id, 'DELIVERY',  'Delivery',             'Hands cases over to clients', true);

  insert into public.role_permissions (lab_id, role_id, permission_code)
  select p_lab_id, r.id, p.code
  from public.roles r cross join public.permissions p
  where r.lab_id = p_lab_id and r.code = 'ADMIN';

  insert into public.role_permissions (lab_id, role_id, permission_code)
  select p_lab_id, r.id, x.perm
  from public.roles r
  join (values
    ('RECEPTION', 'cases.view_all'), ('RECEPTION', 'cases.create'), ('RECEPTION', 'cases.edit'),
    ('RECEPTION', 'doctors.manage'), ('RECEPTION', 'attachments.upload'),
    ('RECEPTION', 'delivery.manage'), ('RECEPTION', 'workflow.assign'),
    ('CAD', 'cases.view_all'), ('CAD', 'attachments.upload'),
    ('CAM', 'cases.view_all'), ('CAM', 'attachments.upload'),
    ('CERAMIST', 'cases.view_all'), ('CERAMIST', 'attachments.upload'),
    ('FINISHING', 'cases.view_all'), ('FINISHING', 'attachments.upload'),
    ('QC', 'cases.view_all'), ('QC', 'qc.perform'), ('QC', 'attachments.upload'),
    ('DELIVERY', 'cases.view_all'), ('DELIVERY', 'delivery.manage')
  ) as x(role_code, perm) on x.role_code = r.code
  where r.lab_id = p_lab_id;

  insert into public.restoration_types (lab_id, code, name, icon, is_implant_related, sort_order) values
    (p_lab_id, 'ANATOMIC_CROWN',    'Anatomic Crown',    'box',     false, 1),
    (p_lab_id, 'REDUCED_CROWN',     'Reduced Crown',     'box',     false, 2),
    (p_lab_id, 'FULL_CONTOUR_CROWN','Full Contour Crown','tooth',   false, 3),
    (p_lab_id, 'COPING',            'Coping',            'box',     false, 4),
    (p_lab_id, 'VENEER',            'Veneer',            'tooth',   false, 5),
    (p_lab_id, 'INLAY',             'Inlay',             'implant', false, 6),
    (p_lab_id, 'ONLAY',             'Onlay',             'tooth',   false, 7),
    (p_lab_id, 'BRIDGE',            'Bridge',            'box',     false, 8),
    (p_lab_id, 'TELESCOPIC_CROWN',  'Telescopic Crown',  'tooth',   false, 9),
    (p_lab_id, 'HYBRID',            'Hybrid',            'tooth',   true,  10),
    (p_lab_id, 'BAR_STRUCTURE',     'Bar Structure',     'implant', true,  11),
    (p_lab_id, 'PARTIAL_DENTURE',   'Partial Denture',   'denture', false, 12),
    (p_lab_id, 'CUSTOM_ABUTMENT',   'Custom Abutment',   'abutment',true,  13),
    (p_lab_id, 'SURGICAL_GUIDE',    'Surgical Guide',    'guide',   true,  14);

  insert into public.materials (lab_id, code, name, category, sort_order) values
    (p_lab_id, 'ZIRCONIA',  'Zirconia',  'ceramic',  1),
    (p_lab_id, 'EMAX',      'E.max',     'ceramic',  2),
    (p_lab_id, 'PMMA',      'PMMA',      'polymer',  3),
    (p_lab_id, 'WAX',       'Wax',       'wax',      4),
    (p_lab_id, 'COCR',      'CoCr',      'metal',    5),
    (p_lab_id, 'TITANIUM',  'Titanium',  'metal',    6),
    (p_lab_id, 'COMPOSITE', 'Composite', 'polymer',  7),
    (p_lab_id, 'RESIN',     'Resin',     'polymer',  8);

  insert into public.implant_brands (lab_id, name, sort_order) values
    (p_lab_id, 'Straumann', 1), (p_lab_id, 'MegaGen', 2), (p_lab_id, 'MIS', 3),
    (p_lab_id, 'BioHorizons', 4), (p_lab_id, 'ETK', 5), (p_lab_id, 'Sweden & Martina', 6),
    (p_lab_id, 'Biotech Dental', 7), (p_lab_id, 'Other / Custom', 99);

  insert into public.implant_systems (lab_id, brand_id, name, connection_types, platforms)
  select p_lab_id, b.id, x.sys, x.conn, x.plat
  from public.implant_brands b
  join (values
    ('Straumann', 'BLT (Bone Level Tapered)', array['CrossFit'], array['NC', 'RC']),
    ('Straumann', 'TLX', array['TorcFit'], array['NT', 'RT', 'WT']),
    ('Straumann', 'Tissue Level', array['synOcta'], array['NNC', 'RN', 'WN']),
    ('MegaGen', 'AnyRidge', array['Internal Hex'], array['Regular']),
    ('MegaGen', 'BlueDiamond', array['Internal Hex'], array['Regular']),
    ('MIS', 'C1', array['Conical'], array['NP', 'SP', 'WP']),
    ('MIS', 'V3', array['Conical'], array['NP', 'SP']),
    ('BioHorizons', 'Tapered Internal', array['Internal Hex'], array['3.0', '3.5', '4.5', '5.7']),
    ('ETK', 'Naturall+', array['Conical'], array['Regular']),
    ('Sweden & Martina', 'Premium', array['Internal Hex'], array['3.3', '3.8', '4.25', '5.0']),
    ('Biotech Dental', 'Kontact', array['Conical'], array['Regular'])
  ) as x(brand, sys, conn, plat) on x.brand = b.name
  where b.lab_id = p_lab_id;

  insert into public.workflow_templates (lab_id, name, is_default)
  values (p_lab_id, 'Standard production', true)
  returning id into v_template;

  insert into public.workflow_stages (lab_id, template_id, position, name, kind, department_id, expected_hours)
  select p_lab_id, v_template, x.pos, x.name, x.kind::public.stage_kind, d.id, x.hours
  from (values
    (1, 'Reception',          'reception',  'RECEPTION', 0.5),
    (2, 'CAD Design',         'production', 'CAD',       4),
    (3, 'Milling / CAM',      'production', 'CAM',       4),
    (4, 'Ceramics',           'production', 'CERAMIC',   8),
    (5, 'Finishing',          'production', 'FINISHING', 3),
    (6, 'Quality Control',    'qc',         'QC',        1),
    (7, 'Ready for Delivery', 'ready',      'DELIVERY',  null),
    (8, 'Delivered',          'delivered',  'DELIVERY',  null)
  ) as x(pos, name, kind, dep, hours)
  left join public.departments d on d.lab_id = p_lab_id and d.code = x.dep;
end;
$$;

-- Create a laboratory with its first administrator. Returns ids; the Edge
-- Function then creates and links the Supabase Auth user.
create or replace function public.provision_laboratory(p_lab jsonb, p_admin jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lab_id uuid;
  v_emp_id uuid;
  v_code text := upper(btrim(coalesce(p_lab->>'code', '')));
  v_admin_code text := upper(btrim(coalesce(p_admin->>'code', 'ADMIN01')));
  v_pin text := coalesce(p_admin->>'pin', '');
begin
  if v_code !~ '^[A-Z0-9]{3,12}$' then
    raise exception 'invalid_lab_code' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.laboratories where code = v_code) then
    raise exception 'lab_code_taken' using errcode = 'P0001';
  end if;
  if v_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin' using errcode = 'P0001';
  end if;

  insert into public.laboratories (code, name, phone, email, address, city, country, settings)
  values (
    v_code,
    btrim(p_lab->>'name'),
    nullif(btrim(p_lab->>'phone'), ''),
    nullif(btrim(p_lab->>'email'), ''),
    nullif(btrim(p_lab->>'address'), ''),
    nullif(btrim(p_lab->>'city'), ''),
    nullif(btrim(p_lab->>'country'), ''),
    jsonb_build_object('show_employee_list', true, 'auto_complete_reception', true,
                       'deadline_warning_hours', 24)
  )
  returning id into v_lab_id;

  perform public.seed_lab_defaults(v_lab_id);

  insert into public.employees (lab_id, code, full_name, department_id, role_id, specialty,
                                phone, email, preferred_language)
  select v_lab_id, v_admin_code, btrim(p_admin->>'full_name'),
         (select id from public.departments where lab_id = v_lab_id and code = 'ADMIN'),
         (select id from public.roles where lab_id = v_lab_id and code = 'ADMIN'),
         'Laboratory administrator',
         nullif(btrim(p_admin->>'phone'), ''), nullif(btrim(p_admin->>'email'), ''),
         coalesce(nullif(p_admin->>'preferred_language', ''), 'ar')
  returning id into v_emp_id;

  insert into public.employee_credentials (employee_id, pin_hash)
  values (v_emp_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));

  return jsonb_build_object('lab_id', v_lab_id, 'employee_id', v_emp_id);
end;
$$;

create or replace function public.create_employee_record(p_lab_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_code text := upper(btrim(coalesce(p->>'code', '')));
  v_pin text := coalesce(p->>'pin', '');
begin
  if v_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.employees where lab_id = p_lab_id and code = v_code) then
    raise exception 'employee_code_taken' using errcode = 'P0001';
  end if;
  insert into public.employees (lab_id, code, full_name, department_id, role_id, specialty,
                                phone, email, preferred_language)
  values (p_lab_id, v_code, btrim(p->>'full_name'),
          nullif(p->>'department_id', '')::uuid, (p->>'role_id')::uuid,
          nullif(btrim(p->>'specialty'), ''), nullif(btrim(p->>'phone'), ''),
          nullif(btrim(p->>'email'), ''), coalesce(nullif(p->>'preferred_language', ''), 'ar'))
  returning id into v_id;
  insert into public.employee_credentials (employee_id, pin_hash)
  values (v_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));
  return v_id;
end;
$$;

create or replace function public.set_employee_pin(p_employee_id uuid, p_pin text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin' using errcode = 'P0001';
  end if;
  insert into public.employee_credentials (employee_id, pin_hash)
  values (p_employee_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  on conflict (employee_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end;
$$;

-- Verify a PIN with brute-force protection: 5 failures lock the account for
-- 15 minutes. Returns {ok, employee_id, auth_user_id} or {ok:false, error}.
create or replace function public.verify_employee_pin(p_lab_code text, p_employee_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp record;
  v_cred record;
begin
  select e.id, e.auth_user_id, e.status, l.status as lab_status
    into v_emp
  from public.employees e
  join public.laboratories l on l.id = e.lab_id
  where l.code = upper(btrim(p_lab_code)) and e.code = upper(btrim(p_employee_code));

  if v_emp.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  if v_emp.lab_status not in ('active', 'trial') then
    return jsonb_build_object('ok', false, 'error', 'lab_inactive');
  end if;
  if v_emp.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'account_inactive');
  end if;

  select * into v_cred from public.employee_credentials where employee_id = v_emp.id for update;
  if v_cred.employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  if v_cred.locked_until is not null and v_cred.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'account_locked', 'locked_until', v_cred.locked_until);
  end if;

  if v_cred.pin_hash = extensions.crypt(coalesce(p_pin, ''), v_cred.pin_hash) then
    update public.employee_credentials
      set failed_attempts = 0, locked_until = null where employee_id = v_emp.id;
    update public.employees set last_login_at = now() where id = v_emp.id;
    return jsonb_build_object('ok', true, 'employee_id', v_emp.id, 'auth_user_id', v_emp.auth_user_id);
  end if;

  update public.employee_credentials
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
  where employee_id = v_emp.id;
  return jsonb_build_object('ok', false, 'error',
    case when v_cred.failed_attempts + 1 >= 5 then 'account_locked' else 'invalid_credentials' end,
    'attempts_left', greatest(0, 5 - (v_cred.failed_attempts + 1)));
end;
$$;

create or replace function public.link_employee_auth_user(p_employee_id uuid, p_auth_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.employees set auth_user_id = p_auth_user_id where id = p_employee_id;
$$;

-- Public (anon) lookup used by the 2-step login. Exposes only display data.
create or replace function public.get_lab_login_info(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lab record;
begin
  select id, code, name, logo_path, status, settings into v_lab
  from public.laboratories where code = upper(btrim(p_code));
  if v_lab.id is null or v_lab.status not in ('active', 'trial') then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_lab.id,
    'code', v_lab.code,
    'name', v_lab.name,
    'logo_path', v_lab.logo_path,
    'employees', case when coalesce((v_lab.settings->>'show_employee_list')::boolean, true) then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', e.code, 'full_name', e.full_name, 'avatar_path', e.avatar_path,
        'department_code', d.code, 'department_name', d.name, 'role_name', r.name
      ) order by d.sort_order nulls last, e.code), '[]'::jsonb)
      from public.employees e
      left join public.departments d on d.id = e.department_id
      join public.roles r on r.id = e.role_id
      where e.lab_id = v_lab.id and e.status = 'active'
    ) else '[]'::jsonb end
  );
end;
$$;

revoke execute on function public.seed_lab_defaults(uuid) from public, anon, authenticated;
revoke execute on function public.provision_laboratory(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.create_employee_record(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.set_employee_pin(uuid, text) from public, anon, authenticated;
revoke execute on function public.verify_employee_pin(text, text, text) from public, anon, authenticated;
revoke execute on function public.link_employee_auth_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.provision_laboratory(jsonb, jsonb) to service_role;
grant execute on function public.create_employee_record(uuid, jsonb) to service_role;
grant execute on function public.set_employee_pin(uuid, text) to service_role;
grant execute on function public.verify_employee_pin(text, text, text) to service_role;
grant execute on function public.link_employee_auth_user(uuid, uuid) to service_role;
grant execute on function public.seed_lab_defaults(uuid) to service_role;

revoke execute on function public.get_lab_login_info(text) from public;
grant execute on function public.get_lab_login_info(text) to anon, authenticated;
