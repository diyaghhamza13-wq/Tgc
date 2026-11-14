-- =============================================================================
-- BACKUP RUNNER project (separate Supabase project, EU London) — NOT production.
-- Nothing here is applied anywhere yet (local tests only).
--
-- Bookkeeping for the automated backup. It holds NO personal data: object ids,
-- versions, sizes, SHA-256 hashes and off-site object keys only (never file names,
-- never row data).
--
-- Work is done in BOUNDED STEPS (hosted Edge Functions: 2 s CPU, 256 MB memory per
-- request): a daily "backup" call starts a run; a "continue" call every 3 minutes
-- resumes it (snapshot first, then stored files in 16 MB encrypted segments, at most
-- ~32 MB per step, then the file map and manifest). A lease prevents two steps from
-- working at once; a step that dies is resumed by the next one.
--
-- RPCs are callable ONLY by this project's service_role (the dlm-backup function in
-- this project). Production never sees this project's keys, and this project never
-- holds production's service key or database password.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema dlm_runner;
revoke all on schema dlm_runner from public;

create table dlm_runner.runs (
  id             uuid primary key default gen_random_uuid(),
  mode           text not null check (mode in ('backup', 'verify', 'health', 'selftest')),
  status         text not null check (status in ('running', 'succeeded', 'failed', 'alert')),
  phase          text check (phase is null or phase in ('snapshot', 'files', 'checks')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  lease_until    timestamptz,
  steps          integer not null default 0,
  run_prefix     text check (run_prefix is null or run_prefix ~ '^runs/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'),
  manifest       jsonb,                       -- counts, sizes, SHA-256, public keys only
  files_uploaded integer not null default 0,  -- segments uploaded by this run
  files_total    integer,
  bytes_uploaded bigint not null default 0,
  bad            integer not null default 0,  -- verify: damaged objects found
  failures       integer not null default 0,  -- failed steps (retried by the next step, up to 5)
  error          text check (error is null or char_length(error) <= 300)
);
create index runs_started_idx on dlm_runner.runs (started_at desc);

-- stored files listed in a run's snapshot (ids only)
create table dlm_runner.run_objects (
  run_id    uuid not null references dlm_runner.runs (id) on delete cascade,
  object_id uuid not null,
  version   timestamptz not null,
  size      bigint not null check (size >= 0),
  state     text not null default 'pending' check (state in ('pending', 'done', 'gone')),
  primary key (run_id, object_id)
);

-- the current encrypted copy of each stored file (one or more segments)
create table dlm_runner.files (
  object_id   uuid primary key,
  version     timestamptz not null,
  size        bigint not null check (size >= 0),
  segments    integer not null check (segments >= 1),
  complete    boolean not null default false,
  sha256      text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),   -- whole file, single-segment files
  uploaded_at timestamptz,
  run_id      uuid references dlm_runner.runs (id) on delete set null
);
create table dlm_runner.segments (
  object_id     uuid not null references dlm_runner.files (object_id) on delete cascade,
  seq           integer not null check (seq >= 0),
  backup_key    text not null unique check (backup_key ~ '^files/[0-9a-f-]{36}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.[0-9]{4}\.age$'),
  plain_sha256  text not null check (plain_sha256 ~ '^[0-9a-f]{64}$'),
  cipher_sha256 text not null check (cipher_sha256 ~ '^[0-9a-f]{64}$'),
  bytes         bigint not null check (bytes >= 0),
  version_id    text check (version_id is null or version_id ~ '^[A-Za-z0-9._+=-]{1,200}$'),
  uploaded_at   timestamptz not null default now(),
  verified_at   timestamptz,
  primary key (object_id, seq)
);
alter table dlm_runner.runs        enable row level security;
alter table dlm_runner.run_objects enable row level security;
alter table dlm_runner.files       enable row level security;
alter table dlm_runner.segments    enable row level security;
revoke all on dlm_runner.runs, dlm_runner.run_objects, dlm_runner.files, dlm_runner.segments
  from public, anon, authenticated, service_role;

-- Start or resume work. p_mode: 'backup' (daily start), 'continue' (every 3 min), 'verify' (weekly),
-- 'selftest' (activation acceptance test against the real bucket and production; one step).
-- Returns {"action": "idle"} or {"action": "work", "run": id, "mode": ..., "phase": ..., "run_prefix": ...}.
create or replace function public.dlm_runner_begin(p_secret text, p_mode text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  v_run dlm_runner.runs;
begin
  if not exists (select 1 from vault.decrypted_secrets s
                 where s.name = 'dlm_backup_trigger'
                   and extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(coalesce(p_secret, ''), 'sha256')) then
    raise exception 'invalid_trigger' using errcode = '28000';
  end if;
  if p_mode not in ('backup', 'continue', 'verify', 'selftest') then
    raise exception 'invalid_mode';
  end if;
  perform pg_advisory_xact_lock(hashtext('dlm_runner_begin'));
  -- a run that has not finished within 23 hours is abandoned
  update dlm_runner.runs set status = 'failed', finished_at = now(), lease_until = null, error = 'stalled'
   where status = 'running' and started_at < now() - interval '23 hours';
  select * into v_run from dlm_runner.runs where status = 'running' order by started_at limit 1;
  if found then
    if v_run.lease_until is not null and v_run.lease_until > now() then
      raise exception 'backup_already_running';
    end if;
    if p_mode in ('verify', 'selftest') and v_run.mode <> p_mode then
      raise exception 'backup_already_running';   -- the weekly check waits for the backup
    end if;
  elsif p_mode = 'continue' then
    return json_build_object('action', 'idle');
  else
    insert into dlm_runner.runs (mode, status, phase)
    values (p_mode, 'running', case when p_mode = 'backup' then 'snapshot' else 'checks' end)
    returning * into v_run;
  end if;
  update dlm_runner.runs set lease_until = now() + interval '170 seconds', steps = steps + 1
   where id = v_run.id;
  return json_build_object('action', 'work', 'run', v_run.id, 'mode', v_run.mode, 'phase', v_run.phase, 'run_prefix', v_run.run_prefix);
end;
$$;

-- end of a step: release the lease and add progress counters
create or replace function public.dlm_runner_release(p_run uuid, p_segments integer, p_bytes bigint)
returns void language sql volatile security definer set search_path = '' as $$
  update dlm_runner.runs
     set lease_until = null, files_uploaded = files_uploaded + greatest(coalesce(p_segments, 0), 0),
         bytes_uploaded = bytes_uploaded + greatest(coalesce(p_bytes, 0), 0)
   where id = p_run and status = 'running';
$$;

-- snapshot stored: remember the run prefix, its counts/keys and the object list (ids, versions, sizes)
create or replace function public.dlm_runner_snapshot_done(p_run uuid, p_prefix text, p_manifest json, p_objects json)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  update dlm_runner.runs set phase = 'files', run_prefix = p_prefix, manifest = p_manifest::jsonb,
         files_total = json_array_length(p_objects)
   where id = p_run and status = 'running' and mode = 'backup' and phase = 'snapshot';
  if not found then raise exception 'run_not_running'; end if;
  insert into dlm_runner.run_objects (run_id, object_id, version, size)
  select p_run, (o->>'id')::uuid, (o->>'version')::timestamptz, coalesce((o->>'size')::bigint, 0)
  from json_array_elements(p_objects) o;
end;
$$;

-- objects of this run still needing a copy (new, changed, incomplete, or copied >= p_reupload_days ago)
create or replace function public.dlm_runner_todo(p_run uuid, p_reupload_days integer default 28)
returns json language plpgsql volatile security definer set search_path = '' as $$
begin
  update dlm_runner.run_objects ro set state = 'done'
    from dlm_runner.files f
   where ro.run_id = p_run and ro.state = 'pending' and f.object_id = ro.object_id and f.version = ro.version
     and f.complete and f.uploaded_at > now() - make_interval(days => greatest(1, least(coalesce(p_reupload_days, 28), 30)));
  return (select coalesce(json_agg(json_build_object(
            'id', ro.object_id, 'version', ro.version, 'size', ro.size,
            'progress_version', case when f.complete then null else f.version end,
            'next_seq', case when f.complete is false
                             then (select coalesce(max(s.seq) + 1, 0) from dlm_runner.segments s where s.object_id = ro.object_id) else 0 end
          ) order by ro.size, ro.object_id), '[]'::json)
          from dlm_runner.run_objects ro left join dlm_runner.files f on f.object_id = ro.object_id
          where ro.run_id = p_run and ro.state = 'pending');
end;
$$;

-- one encrypted segment uploaded
create or replace function public.dlm_runner_segment_done(p_run uuid, p_object uuid, p_version timestamptz, p_size bigint, p_segments integer, p_seg json)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_seq integer := (p_seg->>'seq')::integer;
begin
  if not exists (select 1 from dlm_runner.runs where id = p_run and status = 'running' and mode = 'backup') then
    raise exception 'run_not_running';
  end if;
  if v_seq = 0 then   -- a new copy of this object starts: forget the previous one
    delete from dlm_runner.files where object_id = p_object;
    insert into dlm_runner.files (object_id, version, size, segments, run_id) values (p_object, p_version, p_size, p_segments, p_run);
  elsif not exists (select 1 from dlm_runner.files where object_id = p_object and version = p_version and not complete
                    and (select coalesce(max(seq) + 1, 0) from dlm_runner.segments where object_id = p_object) = v_seq) then
    raise exception 'segment_out_of_order';
  end if;
  insert into dlm_runner.segments (object_id, seq, backup_key, plain_sha256, cipher_sha256, bytes, version_id)
  values (p_object, v_seq, p_seg->>'backup_key', p_seg->>'plain_sha256', p_seg->>'cipher_sha256', (p_seg->>'bytes')::bigint, nullif(p_seg->>'version_id', ''));
  if v_seq = p_segments - 1 then
    update dlm_runner.files set complete = true, uploaded_at = now(), run_id = p_run,
           sha256 = case when p_segments = 1 then p_seg->>'plain_sha256' end
     where object_id = p_object;
    update dlm_runner.run_objects set state = 'done' where run_id = p_run and object_id = p_object;
  end if;
end;
$$;

-- an object listed in the snapshot no longer exists in production
create or replace function public.dlm_runner_object_gone(p_run uuid, p_object uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update dlm_runner.run_objects set state = 'gone' where run_id = p_run and object_id = p_object;
$$;

-- a step failed: retried by the next step, unless fatal or failed 5 times
create or replace function public.dlm_runner_step_failed(p_run uuid, p_error text, p_fatal boolean)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_status text;
begin
  update dlm_runner.runs
     set failures = failures + 1, lease_until = null,
         error = left(regexp_replace(coalesce(p_error, ''), '[^a-z0-9_ :./-]', '', 'g'), 300),
         status = case when p_fatal or failures + 1 >= 5 then 'failed' else status end,
         finished_at = case when p_fatal or failures + 1 >= 5 then now() else finished_at end
   where id = p_run and status = 'running'
   returning status into v_status;
  return v_status;
end;
$$;

-- for each object of the run: its encrypted copy (segments) — the content of files.json.age
create or replace function public.dlm_runner_file_map(p_run uuid)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('manifest', (select manifest from dlm_runner.runs where id = p_run), 'files', coalesce(json_agg(json_build_object(
           'id', ro.object_id, 'state', ro.state, 'copied_in_this_run', coalesce(f.run_id = p_run, false),
           'version', f.version, 'size', f.size, 'sha256', f.sha256,
           'segments', (select coalesce(json_agg(json_build_object('seq', s.seq, 'backup_key', s.backup_key, 'plain_sha256', s.plain_sha256,
                          'cipher_sha256', s.cipher_sha256, 'bytes', s.bytes, 'version_id', s.version_id) order by s.seq), '[]'::json)
                        from dlm_runner.segments s where s.object_id = ro.object_id and ro.state = 'done')
         ) order by ro.object_id), '[]'::json))
  from dlm_runner.run_objects ro
  left join dlm_runner.files f on f.object_id = ro.object_id and f.complete and ro.state = 'done'
  where ro.run_id = p_run;
$$;

create or replace function public.dlm_runner_finish(p_run uuid, p_status text, p_payload json)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid_status';
  end if;
  update dlm_runner.runs
     set status = p_status, finished_at = now(), lease_until = null, phase = null,
         manifest = coalesce((p_payload->'manifest')::jsonb, manifest),
         error = nullif(left(regexp_replace(coalesce(p_payload->>'error', ''), '[^a-z0-9_ :./-]', '', 'g'), 300), '')
   where id = p_run and status = 'running';
  if not found then
    raise exception 'run_not_running';
  end if;
end;
$$;

-- weekly check: the next objects to re-read. First the recent runs' own objects (once per check),
-- then every stored segment not yet checked by this verify run.
create or replace function public.dlm_runner_verify_todo(p_run uuid, p_limit integer default 200)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'bad', (select bad from dlm_runner.runs where id = p_run),
    'checked', (select coalesce(files_total, 0) from dlm_runner.runs where id = p_run),
    'runs', case when not exists (select 1 from dlm_runner.runs where id = p_run and coalesce(manifest, '{}'::jsonb) ? 'runs_checked') then
              (select coalesce(json_agg(m order by started_at desc), '[]'::json) from (
                 select r.started_at, json_build_array(r.manifest->'db', r.manifest->'objects', r.manifest->'filemap') m
                 from dlm_runner.runs r where r.mode = 'backup' and r.status = 'succeeded'
                 order by r.started_at desc limit 7) x)
            else '[]'::json end,
    'segments', (select coalesce(json_agg(json_build_object('object_id', s.object_id, 'key', s.backup_key, 'cipher_sha256', s.cipher_sha256,
                    'version_id', s.version_id, 'bytes', s.bytes) order by s.object_id, s.seq), '[]'::json)
                 from (select s.* from dlm_runner.segments s join dlm_runner.files f on f.object_id = s.object_id and f.complete
                       where s.verified_at is null or s.verified_at < (select started_at from dlm_runner.runs where id = p_run)
                       order by s.object_id, s.seq limit greatest(1, least(coalesce(p_limit, 200), 1000))) s));
$$;

-- weekly check results. Damaged stored-file copies are forgotten: the next backup copies them again.
create or replace function public.dlm_runner_verified(p_run uuid, p_runs_checked boolean, p_ok json, p_bad_keys json, p_bad_objects json)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from dlm_runner.runs where id = p_run and status = 'running' and mode = 'verify') then
    raise exception 'run_not_running';
  end if;
  update dlm_runner.segments set verified_at = now() where backup_key in (select json_array_elements_text(p_ok));
  delete from dlm_runner.files where object_id in (select (json_array_elements_text(p_bad_objects))::uuid);
  update dlm_runner.runs
     set bad = bad + json_array_length(p_bad_keys),
         files_total = coalesce(files_total, 0) + json_array_length(p_ok) + json_array_length(p_bad_keys),
         manifest = case when p_runs_checked then coalesce(manifest, '{}'::jsonb) || '{"runs_checked": true}'::jsonb else manifest end
   where id = p_run;
end;
$$;

-- daily health check, run by pg_cron (as postgres) only. Alerts (at most one of each kind per 20 h):
--   * no successful backup in 26 hours;
--   * the database snapshot is over 15 MB: the runner refuses snapshots over 20 MB (memory limit
--     of a hosted Edge Function step), so the snapshot must be split before it gets there.
create or replace function dlm_runner.health()
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_missed text := 'no successful backup in the last 26 hours';
  v_large  text := 'database snapshot over 15 MB: the runner limit is 20 MB';
begin
  if not exists (select 1 from dlm_runner.runs where mode = 'backup' and status = 'succeeded' and finished_at > now() - interval '26 hours')
     and not exists (select 1 from dlm_runner.runs where mode = 'health' and error = v_missed and started_at > now() - interval '20 hours') then
    insert into dlm_runner.runs (mode, status, finished_at, error) values ('health', 'alert', now(), v_missed);
  end if;
  if exists (select 1 from dlm_runner.runs where mode = 'backup' and status = 'succeeded' and finished_at > now() - interval '26 hours'
               and coalesce((manifest->'db'->>'plain_bytes')::bigint, 0) > 15 * 1048576)
     and not exists (select 1 from dlm_runner.runs where mode = 'health' and error = v_large and started_at > now() - interval '20 hours') then
    insert into dlm_runner.runs (mode, status, finished_at, error) values ('health', 'alert', now(), v_large);
  end if;
end;
$$;
revoke all on function dlm_runner.health() from public, anon, authenticated, service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.dlm_runner_begin(text, text)', 'public.dlm_runner_release(uuid, integer, bigint)',
    'public.dlm_runner_snapshot_done(uuid, text, json, json)', 'public.dlm_runner_todo(uuid, integer)',
    'public.dlm_runner_segment_done(uuid, uuid, timestamptz, bigint, integer, json)', 'public.dlm_runner_object_gone(uuid, uuid)',
    'public.dlm_runner_file_map(uuid)', 'public.dlm_runner_finish(uuid, text, json)', 'public.dlm_runner_step_failed(uuid, text, boolean)',
    'public.dlm_runner_verify_todo(uuid, integer)', 'public.dlm_runner_verified(uuid, boolean, json, json, json)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Trigger secret (pg_cron -> function, both in THIS project): generated here, never displayed.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'dlm_backup_trigger',
                           'Shared secret between pg_cron and the dlm-backup Edge Function (runner project)')
where not exists (select 1 from vault.secrets where name = 'dlm_backup_trigger');
