-- =============================================================================
-- PENDING — NOT A MIGRATION YET. NOT APPLIED ANYWHERE IN PRODUCTION.
-- Kept in supabase/migrations-pending/ so that no `supabase db push` / reset
-- applies it. Local tests apply it explicitly. To deploy (separate approval):
-- move it into supabase/migrations/ and apply.
--
-- Automated, encrypted, off-site backup (docs/backup/AUTOMATED-BACKUP-DESIGN.md):
--   * role dlm_backup_reader: NOLOGIN (no password, cannot connect), read-only,
--     BYPASSRLS. It OWNS public.dlm_backup_snapshot(), a SECURITY DEFINER
--     function, so the snapshot runs with exactly this role's rights.
--   * schema dlm_backup (not exposed by the API): run log + file bookkeeping,
--     no personal data.
--   * RPCs callable ONLY by service_role (the backup Edge Function):
--       dlm_backup_begin(secret, mode)  trigger-secret check (Vault) + run start
--       dlm_backup_snapshot()           read-only snapshot (runs as the backup role)
--       dlm_backup_files_todo(days)     stored files not yet / not recently copied
--       dlm_backup_files_done(run, files)
--       dlm_backup_file_map()           every stored file -> its encrypted copy
--       dlm_backup_finish(run, status, payload)
--       dlm_backup_recent(limit)        for the weekly integrity check
--   * dlm_backup_health(): run by pg_cron only (missed-backup alert).
--   * pg_net extension + Vault trigger secret (generated here, never displayed).
-- The Edge Function never receives the postgres password: it does not use
-- SUPABASE_DB_URL; it only calls the RPCs above with the service-role key.
-- =============================================================================

create extension if not exists pg_net;

-- 1. The read-only backup role (cannot log in) -------------------------------
create role dlm_backup_reader
  nologin nosuperuser nocreatedb nocreaterole noreplication noinherit bypassrls;
grant usage  on schema public, supabase_migrations, storage to dlm_backup_reader;
grant select on all tables in schema public to dlm_backup_reader;
grant select on supabase_migrations.schema_migrations to dlm_backup_reader;
grant select on storage.objects to dlm_backup_reader;
alter default privileges for role postgres in schema public grant select on tables to dlm_backup_reader;

-- 2. Bookkeeping schema (not exposed by the REST API; no app access) ----------
create schema dlm_backup;
revoke all on schema dlm_backup from public;

create table dlm_backup.runs (
  id             uuid primary key default gen_random_uuid(),
  mode           text not null check (mode in ('backup', 'verify', 'health')),
  status         text not null check (status in ('running', 'succeeded', 'failed', 'alert')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  run_prefix     text check (run_prefix is null or run_prefix ~ '^runs/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'),
  manifest       jsonb,                       -- counts, sizes, SHA-256 only
  files_uploaded integer,
  files_total    integer,
  bytes_uploaded bigint,
  error          text check (error is null or char_length(error) <= 300)
);
create index runs_started_idx on dlm_backup.runs (started_at desc);

create table dlm_backup.files (
  object_id      uuid primary key,            -- storage.objects.id (no file name)
  object_version timestamptz not null,        -- storage.objects.updated_at at copy time
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),        -- plaintext
  cipher_sha256  text not null check (cipher_sha256 ~ '^[0-9a-f]{64}$'), -- ciphertext
  backup_key     text not null check (backup_key ~ '^files/[0-9a-f-]{36}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.age$'),
  version_id     text check (version_id is null or version_id ~ '^[A-Za-z0-9._+=-]{1,200}$'), -- provider object version (pinned)
  uploaded_at    timestamptz not null default now(),
  run_id         uuid references dlm_backup.runs (id) on delete set null
);
alter table dlm_backup.runs  enable row level security;
alter table dlm_backup.files enable row level security;
revoke all on dlm_backup.runs, dlm_backup.files from public, anon, authenticated, service_role;

-- 3. Snapshot: owned by the backup role, so it runs with its rights ----------
create or replace function public.dlm_backup_snapshot()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  v_bad   text;
  v_names text[];
  v_data  json[];
  v_t     text;
  v_rows  json;
begin
  -- who am I, and can I only read?
  if current_user <> 'dlm_backup_reader' then
    raise exception 'backup_role_mismatch';
  end if;
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'backup_requires_read_only_transaction';
  end if;
  if not (select r.rolbypassrls and not r.rolsuper and not r.rolcanlogin from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'backup_role_attributes_unexpected';
  end if;
  -- Schema "net" (pg_net) is excluded: when pg_net is installed, Supabase grants
  -- every role (PUBLIC) write access to its request queue. That grant is owned by
  -- supabase_admin and cannot be revoked by postgres; this role cannot log in and
  -- only runs this function's fixed code. See docs/backup/SECURITY-REVIEW.md.
  select string_agg(n.nspname || '.' || c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where pg_catalog.has_schema_privilege(n.oid, 'USAGE')
     and n.nspname not in ('pg_catalog', 'information_schema', 'net') and n.nspname !~ '^pg_(toast|temp)'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (pg_catalog.has_table_privilege(c.oid, 'INSERT') or pg_catalog.has_table_privilege(c.oid, 'UPDATE')
       or pg_catalog.has_table_privilege(c.oid, 'DELETE') or pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')
       or pg_catalog.has_table_privilege(c.oid, 'TRIGGER'));
  if v_bad is not null then raise exception 'backup_role_can_write'; end if;
  select string_agg(n.nspname || '.' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and p.proowner <> (select oid from pg_catalog.pg_roles where rolname = current_user)
     and pg_catalog.has_schema_privilege(n.oid, 'USAGE') and n.nspname not in ('pg_catalog', 'information_schema')
     and pg_catalog.has_function_privilege(p.oid, 'EXECUTE');
  if v_bad is not null then raise exception 'backup_role_can_execute_definer_functions'; end if;
  if pg_catalog.has_schema_privilege('auth', 'USAGE') or pg_catalog.has_schema_privilege('vault', 'USAGE') then
    raise exception 'backup_role_can_read_auth_or_vault';
  end if;

  -- data: every public table (a STABLE function reads one snapshot)
  for v_t in select tablename from pg_catalog.pg_tables where schemaname = 'public' order by tablename loop
    execute pg_catalog.format('select coalesce(pg_catalog.json_agg(x order by x::text), ''[]''::json) from public.%I x', v_t) into v_rows;
    v_names := v_names || v_t;
    v_data  := v_data || v_rows;
  end loop;

  return pg_catalog.json_build_object(
    'format', 'dlm-backup-v1',
    'exported_at', pg_catalog.now(),
    'server_version', pg_catalog.current_setting('server_version'),
    'migrations', (select pg_catalog.json_agg(version order by version) from supabase_migrations.schema_migrations),
    'tables_in_snapshot', pg_catalog.to_json(v_names),
    'storage_objects', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
        'id', o.id, 'bucket', o.bucket_id, 'name', o.name, 'size', o.metadata->>'size',
        'created_at', o.created_at, 'updated_at', o.updated_at) order by o.bucket_id, o.name), '[]'::json) from storage.objects o),
    'data', (select pg_catalog.json_object_agg(n, d order by i) from unnest(v_names, v_data) with ordinality u(n, d, i)),
    'schema', pg_catalog.json_build_object(
      'tables', pg_catalog.to_json(v_names),
      'columns', (select pg_catalog.json_object_agg(table_name, cols) from (
          select table_name, pg_catalog.json_agg(pg_catalog.json_build_object('name', column_name, 'nullable', is_nullable = 'YES', 'identity', is_identity = 'YES') order by ordinal_position) cols
          from information_schema.columns where table_schema = 'public' group by table_name) c),
      'fks', (select pg_catalog.json_agg(pg_catalog.json_build_object('child', c.conrelid::regclass::text, 'parent', c.confrelid::regclass::text,
          'columns', (select pg_catalog.json_agg(a.attname) from pg_catalog.pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey))))
        from pg_catalog.pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)));
end;
$$;
revoke execute on function public.dlm_backup_snapshot() from public, anon, authenticated;
grant execute on function public.dlm_backup_snapshot() to service_role;

-- Hand the snapshot function to the backup role. ALTER ... OWNER needs the new
-- owner to have CREATE on the schema and the current role to be able to
-- SET ROLE to it: both are granted for this statement only, then revoked.
grant create on schema public to dlm_backup_reader;
grant dlm_backup_reader to postgres with inherit false, set true;
alter function public.dlm_backup_snapshot() owner to dlm_backup_reader;
revoke dlm_backup_reader from postgres;
revoke create on schema public from dlm_backup_reader;

-- 4. Bookkeeping RPCs (owner postgres; service_role only) ---------------------
create or replace function public.dlm_backup_begin(p_secret text, p_mode text)
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
  update dlm_backup.runs set status = 'failed', finished_at = now(), error = 'timeout'
   where status = 'running' and started_at < now() - interval '20 minutes';
  if exists (select 1 from dlm_backup.runs where status = 'running') then
    raise exception 'backup_already_running';
  end if;
  insert into dlm_backup.runs (mode, status) values (p_mode, 'running') returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.dlm_backup_files_todo(p_reupload_days integer default 28)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('id', o.id, 'bucket', o.bucket_id, 'name', o.name,
           'version', coalesce(o.updated_at, o.created_at), 'size', (o.metadata->>'size')::bigint) order by o.created_at), '[]'::json)
  from storage.objects o
  where not exists (
    select 1 from dlm_backup.files f
    where f.object_id = o.id and f.object_version = coalesce(o.updated_at, o.created_at)
      and f.uploaded_at > now() - make_interval(days => greatest(1, least(coalesce(p_reupload_days, 28), 30))));
$$;

create or replace function public.dlm_backup_files_done(p_run uuid, p_files json)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not exists (select 1 from dlm_backup.runs where id = p_run and status = 'running') then
    raise exception 'run_not_running';
  end if;
  insert into dlm_backup.files (object_id, object_version, sha256, cipher_sha256, backup_key, version_id, uploaded_at, run_id)
  select (f->>'object_id')::uuid, (f->>'version')::timestamptz, f->>'sha256', f->>'cipher_sha256', f->>'backup_key', nullif(f->>'version_id', ''), now(), p_run
  from json_array_elements(p_files) f
  on conflict (object_id) do update
    set object_version = excluded.object_version, sha256 = excluded.sha256, cipher_sha256 = excluded.cipher_sha256,
        backup_key = excluded.backup_key, version_id = excluded.version_id, uploaded_at = excluded.uploaded_at, run_id = excluded.run_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.dlm_backup_file_map()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object(
           'id', o.id, 'bucket', o.bucket_id, 'name', o.name, 'size', (o.metadata->>'size')::bigint,
           'mimetype', o.metadata->>'mimetype', 'version', coalesce(o.updated_at, o.created_at),
           'sha256', f.sha256, 'cipher_sha256', f.cipher_sha256, 'backup_key', f.backup_key, 'version_id', f.version_id) order by o.bucket_id, o.name), '[]'::json)
  from storage.objects o
  left join dlm_backup.files f on f.object_id = o.id and f.object_version = coalesce(o.updated_at, o.created_at);
$$;

create or replace function public.dlm_backup_finish(p_run uuid, p_status text, p_payload json)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid_status';
  end if;
  update dlm_backup.runs
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

create or replace function public.dlm_backup_recent(p_limit integer default 7)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'runs', (select coalesce(json_agg(json_build_object('run_prefix', run_prefix, 'manifest', manifest) order by started_at desc), '[]'::json)
             from (select * from dlm_backup.runs where mode = 'backup' and status = 'succeeded'
                   order by started_at desc limit greatest(1, least(coalesce(p_limit, 7), 60))) r),
    'files', (select coalesce(json_agg(json_build_object('backup_key', backup_key, 'cipher_sha256', cipher_sha256, 'version_id', version_id)), '[]'::json)
              from dlm_backup.files));
$$;

-- verify mode: a damaged off-site copy is forgotten, so the next backup copies the file again
create or replace function public.dlm_backup_files_invalidate(p_run uuid, p_keys json)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not exists (select 1 from dlm_backup.runs where id = p_run and status = 'running' and mode = 'verify') then
    raise exception 'run_not_running';
  end if;
  delete from dlm_backup.files where backup_key in (select json_array_elements_text(p_keys));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- missed-backup alert, run by pg_cron (as postgres) only
create or replace function public.dlm_backup_health()
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from dlm_backup.runs where mode = 'backup' and status = 'succeeded' and finished_at > now() - interval '26 hours')
     and not exists (select 1 from dlm_backup.runs where mode = 'health' and started_at > now() - interval '20 hours') then
    insert into dlm_backup.runs (mode, status, finished_at, error)
    values ('health', 'alert', now(), 'no successful backup in the last 26 hours');
  end if;
end;
$$;

revoke execute on function public.dlm_backup_begin(text, text), public.dlm_backup_files_todo(integer),
  public.dlm_backup_files_done(uuid, json), public.dlm_backup_file_map(), public.dlm_backup_finish(uuid, text, json),
  public.dlm_backup_recent(integer), public.dlm_backup_health(), public.dlm_backup_files_invalidate(uuid, json) from public, anon, authenticated;
grant execute on function public.dlm_backup_begin(text, text), public.dlm_backup_files_todo(integer),
  public.dlm_backup_files_done(uuid, json), public.dlm_backup_file_map(), public.dlm_backup_finish(uuid, text, json),
  public.dlm_backup_recent(integer), public.dlm_backup_files_invalidate(uuid, json) to service_role;

-- 5. Trigger secret: generated here, stored in Vault, never displayed ---------
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'dlm_backup_trigger',
                           'Shared secret between pg_cron and the dlm-backup Edge Function')
where not exists (select 1 from vault.secrets where name = 'dlm_backup_trigger');
