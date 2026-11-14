-- =============================================================================
-- BACKUP RUNNER project (separate Supabase project, EU London) — NOT production.
-- Nothing here is applied anywhere yet (local tests only).
--
-- Bookkeeping for the automated backup: run log + which stored file was copied
-- where. It holds NO personal data: object ids, timestamps, SHA-256 hashes and
-- off-site object keys only (never file names, never row data).
--
-- RPCs are callable ONLY by this project's service_role (the dlm-backup function
-- in this project). Production never sees this project's keys, and this project
-- never holds production's service key or database password.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema dlm_runner;
revoke all on schema dlm_runner from public;

create table dlm_runner.runs (
  id             uuid primary key default gen_random_uuid(),
  mode           text not null check (mode in ('backup', 'verify', 'health')),
  status         text not null check (status in ('running', 'succeeded', 'failed', 'alert')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  run_prefix     text check (run_prefix is null or run_prefix ~ '^runs/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'),
  manifest       jsonb,                       -- counts, sizes, SHA-256, public keys only
  files_uploaded integer,
  files_total    integer,
  bytes_uploaded bigint,
  error          text check (error is null or char_length(error) <= 300)
);
create index runs_started_idx on dlm_runner.runs (started_at desc);

create table dlm_runner.files (
  object_id      uuid primary key,            -- production storage.objects.id (no file name)
  object_version timestamptz not null,        -- its updated_at at copy time
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),        -- plaintext
  cipher_sha256  text not null check (cipher_sha256 ~ '^[0-9a-f]{64}$'), -- ciphertext
  backup_key     text not null check (backup_key ~ '^files/[0-9a-f-]{36}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.age$'),
  version_id     text check (version_id is null or version_id ~ '^[A-Za-z0-9._+=-]{1,200}$'),
  uploaded_at    timestamptz not null default now(),
  run_id         uuid references dlm_runner.runs (id) on delete set null
);
alter table dlm_runner.runs  enable row level security;
alter table dlm_runner.files enable row level security;
revoke all on dlm_runner.runs, dlm_runner.files from public, anon, authenticated, service_role;

-- objects given by the function: [{"id": uuid, "version": timestamptz}, ...] (no names)
create or replace function dlm_runner._objects(p json)
returns table (id uuid, version timestamptz) language sql immutable set search_path = '' as $$
  select (o->>'id')::uuid, (o->>'version')::timestamptz from pg_catalog.json_array_elements(coalesce(p, '[]'::json)) o
$$;
revoke all on function dlm_runner._objects(json) from public;

create or replace function public.dlm_runner_begin(p_secret text, p_mode text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from vault.decrypted_secrets s
                 where s.name = 'dlm_backup_trigger'
                   and extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(coalesce(p_secret, ''), 'sha256')) then
    raise exception 'invalid_trigger' using errcode = '28000';
  end if;
  if p_mode not in ('backup', 'verify') then
    raise exception 'invalid_mode';
  end if;
  update dlm_runner.runs set status = 'failed', finished_at = now(), error = 'timeout'
   where status = 'running' and started_at < now() - interval '20 minutes';
  if exists (select 1 from dlm_runner.runs where status = 'running') then
    raise exception 'backup_already_running';
  end if;
  insert into dlm_runner.runs (mode, status) values (p_mode, 'running') returning id into v_id;
  return v_id;
end;
$$;

-- which of the given objects need a copy: new, changed, or copied too long ago
create or replace function public.dlm_runner_files_todo(p_objects json, p_reupload_days integer default 28)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(o.id), '[]'::json)
  from dlm_runner._objects(p_objects) o
  where not exists (
    select 1 from dlm_runner.files f
    where f.object_id = o.id and f.object_version = o.version
      and f.uploaded_at > now() - make_interval(days => greatest(1, least(coalesce(p_reupload_days, 28), 30))));
$$;

create or replace function public.dlm_runner_files_done(p_run uuid, p_files json)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not exists (select 1 from dlm_runner.runs where id = p_run and status = 'running' and mode = 'backup') then
    raise exception 'run_not_running';
  end if;
  insert into dlm_runner.files (object_id, object_version, sha256, cipher_sha256, backup_key, version_id, uploaded_at, run_id)
  select (f->>'object_id')::uuid, (f->>'version')::timestamptz, f->>'sha256', f->>'cipher_sha256', f->>'backup_key', nullif(f->>'version_id', ''), now(), p_run
  from json_array_elements(p_files) f
  on conflict (object_id) do update
    set object_version = excluded.object_version, sha256 = excluded.sha256, cipher_sha256 = excluded.cipher_sha256,
        backup_key = excluded.backup_key, version_id = excluded.version_id, uploaded_at = excluded.uploaded_at, run_id = excluded.run_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- for each given object: its current encrypted copy (null fields if none)
create or replace function public.dlm_runner_file_map(p_objects json)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object(
           'id', o.id, 'version', o.version, 'sha256', f.sha256, 'cipher_sha256', f.cipher_sha256,
           'backup_key', f.backup_key, 'version_id', f.version_id)), '[]'::json)
  from dlm_runner._objects(p_objects) o
  left join dlm_runner.files f on f.object_id = o.id and f.object_version = o.version;
$$;

create or replace function public.dlm_runner_finish(p_run uuid, p_status text, p_payload json)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid_status';
  end if;
  update dlm_runner.runs
     set status = p_status, finished_at = now(),
         run_prefix = p_payload->>'run_prefix',
         manifest = (p_payload->'manifest')::jsonb,
         files_uploaded = (p_payload->>'files_uploaded')::integer,
         files_total = (p_payload->>'files_total')::integer,
         bytes_uploaded = (p_payload->>'bytes_uploaded')::bigint,
         error = left(regexp_replace(coalesce(p_payload->>'error', ''), '[^a-z0-9_ :./-]', '', 'g'), 300)
   where id = p_run and status = 'running';
  if not found then
    raise exception 'run_not_running';
  end if;
end;
$$;

create or replace function public.dlm_runner_recent(p_limit integer default 7)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'runs', (select coalesce(json_agg(json_build_object('run_prefix', run_prefix, 'manifest', manifest) order by started_at desc), '[]'::json)
             from (select * from dlm_runner.runs where mode = 'backup' and status = 'succeeded'
                   order by started_at desc limit greatest(1, least(coalesce(p_limit, 7), 60))) r),
    'files', (select coalesce(json_agg(json_build_object('backup_key', backup_key, 'cipher_sha256', cipher_sha256, 'version_id', version_id)), '[]'::json)
              from dlm_runner.files));
$$;

-- verify mode: a damaged off-site copy is forgotten, so the next backup copies the file again
create or replace function public.dlm_runner_files_invalidate(p_run uuid, p_keys json)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not exists (select 1 from dlm_runner.runs where id = p_run and status = 'running' and mode = 'verify') then
    raise exception 'run_not_running';
  end if;
  delete from dlm_runner.files where backup_key in (select json_array_elements_text(p_keys));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- missed-backup alert, run by pg_cron (as postgres) only
create or replace function dlm_runner.health()
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from dlm_runner.runs where mode = 'backup' and status = 'succeeded' and finished_at > now() - interval '26 hours')
     and not exists (select 1 from dlm_runner.runs where mode = 'health' and started_at > now() - interval '20 hours') then
    insert into dlm_runner.runs (mode, status, finished_at, error)
    values ('health', 'alert', now(), 'no successful backup in the last 26 hours');
  end if;
end;
$$;
revoke all on function dlm_runner.health() from public, anon, authenticated, service_role;

revoke execute on function public.dlm_runner_begin(text, text), public.dlm_runner_files_todo(json, integer),
  public.dlm_runner_files_done(uuid, json), public.dlm_runner_file_map(json), public.dlm_runner_finish(uuid, text, json),
  public.dlm_runner_recent(integer), public.dlm_runner_files_invalidate(uuid, json) from public, anon, authenticated;
grant execute on function public.dlm_runner_begin(text, text), public.dlm_runner_files_todo(json, integer),
  public.dlm_runner_files_done(uuid, json), public.dlm_runner_file_map(json), public.dlm_runner_finish(uuid, text, json),
  public.dlm_runner_recent(integer), public.dlm_runner_files_invalidate(uuid, json) to service_role;

-- Trigger secret (pg_cron -> function, both in THIS project): generated here, never displayed.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'dlm_backup_trigger',
                           'Shared secret between pg_cron and the dlm-backup Edge Function (runner project)')
where not exists (select 1 from vault.secrets where name = 'dlm_backup_trigger');
