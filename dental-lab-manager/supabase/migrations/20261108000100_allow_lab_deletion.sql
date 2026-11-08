-- Allow a whole laboratory to be deleted (App Store / Play Store account
-- deletion requirement). System roles stay protected individually, but when
-- the laboratory itself is gone (ON DELETE CASCADE), its roles may go too.
create or replace function public.protect_system_roles()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.is_system
     and exists (select 1 from public.laboratories where id = old.lab_id) then
    raise exception 'System roles cannot be deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.is_system and (new.code <> old.code or not new.is_system) then
    raise exception 'System role code cannot be changed' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;


-- Atomically delete a laboratory and all of its data (service role only).
-- Order matters: cases reference catalogs and employees, employees reference
-- roles (ON DELETE RESTRICT), then the laboratory cascades everything else.
create or replace function public.delete_laboratory(p_lab_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.cases where lab_id = p_lab_id;
  delete from public.employees where lab_id = p_lab_id;
  delete from public.laboratories where id = p_lab_id;
  delete from public.audit_logs where lab_id = p_lab_id;
end;
$$;
revoke execute on function public.delete_laboratory(uuid) from public, anon, authenticated;
grant execute on function public.delete_laboratory(uuid) to service_role;
