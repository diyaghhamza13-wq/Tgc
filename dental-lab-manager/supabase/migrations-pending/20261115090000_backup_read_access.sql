-- =============================================================================
-- PENDING — NOT A MIGRATION YET. NOT APPLIED ANYWHERE IN PRODUCTION.
-- Kept in supabase/migrations-pending/ so that no `supabase db push` / reset
-- applies it. Local tests apply it explicitly. To deploy (separate approval):
-- move it into supabase/migrations/ and apply.
--
-- PRODUCTION side of the automated backup (docs/backup/BACKUP-RUNNER.md).
-- The backup itself runs in a SEPARATE "Backup Runner" Supabase project. That
-- project holds NO production service key and NO production database password:
-- only production's public anon key and a revocable backup token. This
-- migration gives that token READ-ONLY access, and nothing else:
--
--   * role dlm_backup_reader: NOLOGIN (no password, cannot connect), read-only,
--     BYPASSRLS. It OWNS public.dlm_backup_snapshot() (SECURITY DEFINER), so the
--     snapshot runs with exactly this role's rights.
--   * schema dlm_backup (not exposed by the API): runner_tokens holds only the
--     SHA-256 HASH of each token, its label, expiry and revocation time.
--   * public.dlm_backup_runner_snapshot(): callable with the anon key, returns
--     the snapshot ONLY if the request carries a valid token in the header
--     x-dlm-backup-token. Read-only (STABLE: PostgREST runs it in a read-only
--     transaction; the snapshot checks it).
--   * public.dlm_backup_runner_objects(): same token check, read-only list of
--     stored objects (id, bucket, path, size, type, version) for the file steps.
--   * Storage policy dlm_backup_runner_download: with a valid token, the anon
--     role may DOWNLOAD objects (operation object.get_authenticated) — not list,
--     not inspect, not sign URLs, not upload, update, move, copy or delete.
--   * token lifecycle (postgres only, SQL editor): dlm_backup.register_token,
--     dlm_backup.revoke_token, dlm_backup.revoke_all_tokens, dlm_backup.token_status.
--
-- NOT in production any more: pg_net, cron jobs, run bookkeeping, any RPC that
-- writes. The runner never writes to production.
-- =============================================================================

-- 0. Pre-check (before any change). Requires Supabase Storage tenant migration 0058 ("operation-ergonomics", storage-api
-- v1.77+, September 2026), which created storage.allow_only_operation(). Without it,
-- stop here rather than create a weaker policy.
do $$
begin
  if to_regprocedure('storage.allow_only_operation(text)') is null or to_regprocedure('storage.operation()') is null then
    raise exception 'storage.allow_only_operation(text) is missing: this Storage version cannot restrict the backup policy to downloads. Migration aborted; nothing was changed.';
  end if;
end $$;

-- 1. The read-only backup role (cannot log in) -------------------------------
create role dlm_backup_reader
  nologin nosuperuser nocreatedb nocreaterole noreplication noinherit bypassrls;
grant usage  on schema public, supabase_migrations, storage to dlm_backup_reader;
grant select on all tables in schema public to dlm_backup_reader;
grant select on supabase_migrations.schema_migrations to dlm_backup_reader;
grant select on storage.objects to dlm_backup_reader;
alter default privileges for role postgres in schema public grant select on tables to dlm_backup_reader;

-- 2. Token store: hashes only ---------------------------------------------------
create schema dlm_backup;
revoke all on schema dlm_backup from public;

create table dlm_backup.runner_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the token
  label       text not null check (label ~ '^[A-Za-z0-9 _.:-]{1,60}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '400 days')
);
alter table dlm_backup.runner_tokens enable row level security;
revoke all on dlm_backup.runner_tokens from public, anon, authenticated, service_role;

-- Is this API request carrying a valid backup token? Fails CLOSED: missing or
-- malformed headers/claims, a non-anon role (e.g. a logged-in app user, or the
-- service key), a malformed, unknown, revoked or expired token all give false.
create or replace function dlm_backup.token_valid()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers json;
  v_role    text;
  v_token   text;
begin
  begin
    v_headers := nullif(pg_catalog.current_setting('request.headers', true), '')::json;
    v_role    := (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::json)->>'role';
  exception when others then
    return false;
  end;
  if v_role is distinct from 'anon' then
    return false;
  end if;
  v_token := v_headers->>'x-dlm-backup-token';
  if v_token is null or v_token !~ '^dlmbk1_[0-9a-f]{64}$' then
    return false;
  end if;
  return exists (
    select 1 from dlm_backup.runner_tokens t
     where t.token_hash = pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex')
       and t.revoked_at is null and t.expires_at > pg_catalog.now());
end;
$$;
revoke all on function dlm_backup.token_valid() from public, authenticated, service_role;
grant usage on schema dlm_backup to anon;          -- to evaluate the function only; no table access
grant execute on function dlm_backup.token_valid() to anon;

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
  -- No schema is exempt. Production does not install pg_net (the backup runner
  -- is a separate project); if pg_net were ever installed, Supabase would grant
  -- every role write access to its queue and this check would stop the backup:
  -- a deliberate tripwire. See docs/backup/SECURITY-REVIEW.md.
  select string_agg(n.nspname || '.' || c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where pg_catalog.has_schema_privilege(n.oid, 'USAGE')
     and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
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
        'id', o.id, 'bucket', o.bucket_id, 'name', o.name, 'size', o.metadata->>'size', 'mimetype', o.metadata->>'mimetype',
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
-- Not callable by any API role (not even service_role): only through the
-- token-checked wrapper public.dlm_backup_runner_snapshot() below.
revoke execute on function public.dlm_backup_snapshot() from public, anon, authenticated, service_role;

-- Hand the snapshot function to the backup role. ALTER ... OWNER needs the new
-- owner to have CREATE on the schema and the current role to be able to
-- SET ROLE to it: both are granted for this statement only, then revoked.
grant create on schema public to dlm_backup_reader;
grant dlm_backup_reader to postgres with inherit false, set true;
alter function public.dlm_backup_snapshot() owner to dlm_backup_reader;
-- the new owner lets postgres (owner of the token-checked wrapper below) call it
set role dlm_backup_reader;
grant execute on function public.dlm_backup_snapshot() to postgres;
set role postgres;   -- back to postgres explicitly (whatever role the session started as)
revoke dlm_backup_reader from postgres;
revoke create on schema public from dlm_backup_reader;

-- 4. The runner's only database entry point: token-checked, read-only ---------
create or replace function public.dlm_backup_runner_snapshot()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not dlm_backup.token_valid() then
    raise exception 'invalid_token' using errcode = '28000';   -- same answer for every reason
  end if;
  return public.dlm_backup_snapshot();
end;
$$;
revoke all on function public.dlm_backup_runner_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.dlm_backup_runner_snapshot() to anon;

-- Current list of stored objects (ids, paths, sizes, versions), token-checked and
-- read-only: lets the runner's later steps download files without keeping their names.
create or replace function public.dlm_backup_runner_objects()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not dlm_backup.token_valid() then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  return (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
            'id', o.id, 'bucket', o.bucket_id, 'name', o.name, 'size', o.metadata->>'size',
            'mimetype', o.metadata->>'mimetype', 'version', coalesce(o.updated_at, o.created_at)) order by o.id), '[]'::json)
          from storage.objects o);
end;
$$;
revoke all on function public.dlm_backup_runner_objects() from public, anon, authenticated, service_role;
grant execute on function public.dlm_backup_runner_objects() to anon;

-- 5. Storage: download-only with a valid token ---------------------------------
-- Restricted to the download operation: a broader SELECT policy would also let
-- a token holder create SIGNED URLs (tested locally: valid for up to a year, and
-- still usable after the token is revoked), list and inspect objects.
-- storage.allow_only_operation() returns false when the Storage service does not
-- report the operation, so this fails CLOSED on other Storage versions.
create policy dlm_backup_runner_download on storage.objects
  for select to anon
  using (storage.allow_only_operation('object.get_authenticated') and dlm_backup.token_valid());

-- 6. Token lifecycle — run by you in the SQL editor (postgres only) ------------
-- The token itself is generated OUTSIDE production (offline page or
-- scripts/backup/runner-token.mjs); production only ever receives its hash.
create or replace function dlm_backup.register_token(p_token_hash text, p_label text, p_valid_days integer default 365)
returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_token_hash is null or lower(p_token_hash) !~ '^[0-9a-f]{64}$' then
    raise exception 'token_hash must be 64 hex characters (SHA-256 of the token, not the token itself)';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 400 then
    raise exception 'p_valid_days must be between 1 and 400';
  end if;
  if (select count(*) from dlm_backup.runner_tokens where revoked_at is null and expires_at > now()) >= 2 then
    raise exception 'two tokens are already active: revoke one first (rotation keeps at most two)';
  end if;
  insert into dlm_backup.runner_tokens (token_hash, label, expires_at)
  values (lower(p_token_hash), p_label, now() + make_interval(days => p_valid_days))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function dlm_backup.revoke_token(p_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
begin
  update dlm_backup.runner_tokens set revoked_at = now() where id = p_id and revoked_at is null;
  if not found then
    raise exception 'no active token with this id';
  end if;
end;
$$;

create or replace function dlm_backup.revoke_all_tokens()
returns integer language plpgsql volatile set search_path = '' as $$
declare
  v_n integer;
begin
  update dlm_backup.runner_tokens set revoked_at = now() where revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace view dlm_backup.token_status as
  select id, label, left(token_hash, 12) as hash_prefix, created_at, expires_at, revoked_at,
         (revoked_at is null and expires_at > now()) as active
    from dlm_backup.runner_tokens;

revoke all on function dlm_backup.register_token(text, text, integer), dlm_backup.revoke_token(uuid),
  dlm_backup.revoke_all_tokens() from public, anon, authenticated, service_role;
revoke all on dlm_backup.token_status from public, anon, authenticated, service_role;
