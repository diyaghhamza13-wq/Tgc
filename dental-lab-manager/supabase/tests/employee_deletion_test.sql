-- =============================================================================
-- LOCAL-ONLY database tests for employee / laboratory deletion.
-- Runs entirely inside one transaction and ROLLS BACK at the end: it leaves no
-- data behind. Never run against production (it injects a failing trigger on
-- auth.users to test rollback).
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/employee_deletion_test.sql
-- =============================================================================
\set QUIET on
begin;

create temp table t_ctx (k text primary key, v uuid);

-- Fixture: a laboratory with an admin, a second admin and a technician, each
-- with an Auth account, plus one case with history, QC record and delivery.
do $$
declare
  r jsonb; v_lab uuid; v_admin uuid; v_admin2 uuid; v_tech uuid; v_doc uuid; v_case uuid; v_stage uuid;
  v_role_admin uuid; v_role_cad uuid; v_dep_cad uuid; v_type uuid; v_u uuid;
begin
  r := public.provision_laboratory('{"code":"ZZDELTEST","name":"Deletion test lab"}', '{"full_name":"Test Admin","code":"ADMIN01","pin":"13572468"}');
  v_lab := r->>'lab_id'; v_admin := r->>'employee_id';
  select id into v_role_admin from public.roles where lab_id = v_lab and code = 'ADMIN';
  select id into v_role_cad from public.roles where lab_id = v_lab and code = 'CAD';
  select id into v_dep_cad from public.departments where lab_id = v_lab and code = 'CAD';
  v_admin2 := public.create_employee_record(v_lab, jsonb_build_object('code','ADMIN02','full_name','Second Admin','role_id',v_role_admin,'pin','24681357'));
  v_tech := public.create_employee_record(v_lab, jsonb_build_object('code','TECH01','full_name','Tech Person','role_id',v_role_cad,'department_id',v_dep_cad,'phone','+000','email','tech@example.invalid','pin','11223344'));
  -- Auth accounts (with an identity and a session) linked to each employee
  foreach v_u in array array[v_admin, v_admin2, v_tech] loop
    insert into auth.users (id, instance_id, aud, role, email)
      values (v_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_u || '@employees.test.invalid');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider) values (gen_random_uuid(), v_u, v_u::text, '{}', 'email');
    insert into auth.sessions (id, user_id) values (gen_random_uuid(), v_u);
    update public.employees set auth_user_id = v_u where id = v_u;
  end loop;
  -- an UPDATE audited with personal data
  update public.employees set phone = '+111', specialty = 'CAD' where id = v_tech;
  -- a case, assigned to the technician (history keeps the name), worked on by them
  insert into public.doctors (lab_id, full_name) values (v_lab, 'Dr Test') returning id into v_doc;
  insert into public.patients (lab_id, full_name) values (v_lab, 'Patient Test');
  insert into public.cases (lab_id, case_number, patient_id, doctor_id, due_date, created_by)
    values (v_lab, 'DL-T1', (select id from public.patients where lab_id = v_lab), v_doc, current_date + 3, v_admin)
    returning id into v_case;
  insert into public.case_workflow_stages (lab_id, case_id, position, name, kind, department_id, status, started_at, completed_at, completed_by)
    values (v_lab, v_case, 1, 'CAD Design', 'production', v_dep_cad, 'completed', now(), now(), v_tech)
    returning id into v_stage;
  update public.cases set current_stage_id = v_stage where id = v_case;
  perform public._assign(v_stage, v_tech, v_admin);
  insert into public.case_history (lab_id, case_id, event_type, actor_id, notes) values (v_lab, v_case, 'note', v_tech, 'tech note');
  insert into public.quality_control (lab_id, case_id, stage_id, inspector_id, result) values (v_lab, v_case, v_stage, v_tech, 'passed');
  insert into public.deliveries (lab_id, case_id, delivered_by, recipient_name) values (v_lab, v_case, v_tech, 'Clinic');
  insert into public.notifications (lab_id, recipient_id, case_id, type, title) values (v_lab, v_tech, v_case, 'general', 'hello');
  -- simulate actions performed by the technician (audit actor)
  insert into public.audit_logs (lab_id, actor_employee_id, actor_user_id, table_name, record_id, action, new_data)
    values (v_lab, v_tech, v_tech, 'cases', v_case::text, 'UPDATE', '{}');
  insert into t_ctx values ('lab', v_lab), ('admin', v_admin), ('admin2', v_admin2), ('tech', v_tech), ('case', v_case), ('stage', v_stage);
end $$;

-- 1. Permissions: only the service role may call the deletion functions
do $$
begin
  assert not has_function_privilege('anon', 'public.delete_employee_account(uuid)', 'execute'), 'anon must not execute delete_employee_account';
  assert not has_function_privilege('authenticated', 'public.delete_employee_account(uuid)', 'execute'), 'authenticated must not execute delete_employee_account';
  assert has_function_privilege('service_role', 'public.delete_employee_account(uuid)', 'execute'), 'service_role must execute delete_employee_account';
  assert not has_function_privilege('authenticated', 'public.cleanup_report()', 'execute'), 'authenticated must not execute cleanup_report';
  assert not has_table_privilege('authenticated', 'public.pending_cleanups', 'select'), 'authenticated must not read pending_cleanups';
  raise notice 'PASS 1  permissions';
end $$;

-- 2. Auth deletion failure -> the whole deletion rolls back
create function pg_temp.fail_auth_delete() returns trigger language plpgsql as $$
begin raise exception 'simulated auth failure'; end $$;
create trigger t_fail_auth before delete on auth.users for each row execute function pg_temp.fail_auth_delete();
do $$
declare v_tech uuid := (select v from t_ctx where k = 'tech'); v_before text; v_after text; v_failed boolean := false;
begin
  select md5(string_agg(row(a.*)::text, '|' order by a.id)) into v_before from public.audit_logs a where record_id = v_tech::text or actor_user_id = v_tech;
  begin
    perform public.delete_employee_account(v_tech);
  exception when others then
    v_failed := sqlerrm like '%simulated auth failure%';
  end;
  assert v_failed, 'deletion must fail when Auth deletion fails';
  assert exists (select 1 from public.employees where id = v_tech), 'employee must still exist after failed deletion';
  assert exists (select 1 from auth.users where id = v_tech), 'auth user must still exist after failed deletion';
  assert exists (select 1 from public.employee_credentials where employee_id = v_tech), 'credentials must still exist';
  assert exists (select 1 from public.notifications where recipient_id = v_tech), 'notifications must still exist';
  assert (select data->>'employee_name' from public.case_history where data->>'employee_id' = v_tech::text) = 'Tech Person', 'history name must be unchanged';
  select md5(string_agg(row(a.*)::text, '|' order by a.id)) into v_after from public.audit_logs a where record_id = v_tech::text or actor_user_id = v_tech;
  assert v_before = v_after, 'audit log must be unchanged after failed deletion';
  raise notice 'PASS 2  auth failure rolls back everything';
end $$;
drop trigger t_fail_auth on auth.users;

-- 3. Last active administrator cannot delete their own account
do $$
declare v_admin uuid := (select v from t_ctx where k = 'admin'); v_admin2 uuid := (select v from t_ctx where k = 'admin2'); v_msg text;
begin
  update public.employees set status = 'inactive' where id = v_admin2;   -- leaves one active admin
  begin
    perform public.delete_employee_account(v_admin);
  exception when others then v_msg := sqlerrm;
  end;
  assert v_msg = 'last_admin', 'expected last_admin, got ' || coalesce(v_msg, 'success');
  assert exists (select 1 from public.employees where id = v_admin), 'last admin must still exist';
  update public.employees set status = 'active' where id = v_admin2;
  raise notice 'PASS 3  last administrator protected';
end $$;

-- 4. Successful deletion: account and personal traces removed, lab records kept
do $$
declare
  v_lab uuid := (select v from t_ctx where k = 'lab'); v_tech uuid := (select v from t_ctx where k = 'tech');
  v_case uuid := (select v from t_ctx where k = 'case'); v_stage uuid := (select v from t_ctx where k = 'stage');
  v_res jsonb; v_other_emps_before int; v_hist_before int;
begin
  select count(*) into v_other_emps_before from public.employees where lab_id = v_lab and id <> v_tech;
  select count(*) into v_hist_before from public.case_history where case_id = v_case;
  v_res := public.delete_employee_account(v_tech);
  assert (v_res->>'auth_user_deleted')::boolean, 'auth_user_deleted flag';
  assert v_res->>'avatar_prefix' = v_lab || '/avatars/' || v_tech, 'avatar prefix';
  -- removed
  assert not exists (select 1 from public.employees where id = v_tech), 'employee row removed';
  assert not exists (select 1 from auth.users where id = v_tech), 'auth user removed';
  assert not exists (select 1 from auth.identities where user_id = v_tech), 'auth identities removed';
  assert not exists (select 1 from auth.sessions where user_id = v_tech), 'auth sessions removed';
  assert not exists (select 1 from public.employee_credentials where employee_id = v_tech), 'credentials removed';
  assert not exists (select 1 from public.notifications where recipient_id = v_tech), 'notifications removed';
  -- anonymized
  assert not exists (select 1 from public.audit_logs where table_name = 'employees' and record_id = v_tech::text
                     and (coalesce(old_data, '{}') ?| array['full_name','code','phone','email','avatar_path','specialty','auth_user_id','last_login_at']
                       or coalesce(new_data, '{}') ?| array['full_name','code','phone','email','avatar_path','specialty','auth_user_id','last_login_at'])),
         'audit rows must not contain personal fields';
  assert (select count(*) from public.audit_logs where table_name = 'employees' and record_id = v_tech::text) >= 3, 'insert/update/delete audit rows kept';
  assert not exists (select 1 from public.audit_logs where table_name = 'employees' and record_id = v_tech::text
                     and coalesce((coalesce(new_data, old_data)->>'anonymized')::boolean, false) = false), 'all rows flagged anonymized';
  assert not exists (select 1 from public.audit_logs where actor_user_id = v_tech), 'actor_user_id cleared';
  assert exists (select 1 from public.audit_logs where actor_employee_id = v_tech and table_name = 'cases'), 'pseudonymous actor id kept on work audit rows';
  assert (select data->>'employee_name' from public.case_history where data->>'employee_id' = v_tech::text) = 'Deleted Employee', 'history name replaced';
  -- preserved
  assert exists (select 1 from public.cases where id = v_case and created_by is not null), 'case preserved';
  assert (select count(*) from public.case_history where case_id = v_case) = v_hist_before, 'history rows preserved';
  assert exists (select 1 from public.case_history where case_id = v_case and event_type = 'note' and actor_id is null and notes = 'tech note'), 'note kept, author cleared';
  assert exists (select 1 from public.case_workflow_stages where id = v_stage and status = 'completed' and completed_by is null and assigned_employee_id is null), 'stage kept, links cleared';
  assert exists (select 1 from public.quality_control where case_id = v_case and inspector_id is null and result = 'passed'), 'QC record kept';
  assert exists (select 1 from public.deliveries where case_id = v_case and delivered_by is null), 'delivery kept';
  assert (select count(*) from public.employees where lab_id = v_lab) = v_other_emps_before, 'other employees untouched';
  assert exists (select 1 from auth.users where id = (select v from t_ctx where k = 'admin')), 'other auth users untouched';
  raise notice 'PASS 4  account deleted, traces anonymized, laboratory records preserved';
end $$;

-- 5. Unknown employee
do $$
declare v_msg text;
begin
  begin perform public.delete_employee_account(gen_random_uuid()); exception when others then v_msg := sqlerrm; end;
  assert v_msg = 'employee_not_found', 'expected employee_not_found';
  raise notice 'PASS 5  unknown employee rejected';
end $$;

-- 6. Laboratory deletion removes its Auth accounts in the same transaction
do $$
declare v_lab uuid := (select v from t_ctx where k = 'lab'); v_auth uuid[];
begin
  select array_agg(auth_user_id) into v_auth from public.employees where lab_id = v_lab;
  perform public.delete_laboratory(v_lab);
  assert not exists (select 1 from public.laboratories where id = v_lab), 'lab removed';
  assert not exists (select 1 from auth.users where id = any (v_auth)), 'lab auth users removed';
  assert not exists (select 1 from public.audit_logs where lab_id = v_lab), 'lab audit log removed';
  raise notice 'PASS 6  laboratory deletion removes its auth accounts';
end $$;

-- 7. cleanup_report runs and reports no orphans created by these tests
do $$
declare r jsonb := public.cleanup_report();
begin
  assert jsonb_typeof(r->'orphaned_auth_users') = 'array' and jsonb_typeof(r->'pending_cleanups') = 'array', 'report shape';
  assert not exists (select 1 from jsonb_array_elements(r->'orphaned_auth_users') x
                     where (x->>'id')::uuid in (select v from t_ctx)), 'no orphans from these tests';
  raise notice 'PASS 7  cleanup_report';
end $$;

rollback;
\echo 'All deletion tests passed (transaction rolled back, no data left behind).'
