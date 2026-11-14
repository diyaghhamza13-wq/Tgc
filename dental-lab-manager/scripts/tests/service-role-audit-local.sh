#!/usr/bin/env bash
# LOCAL-ONLY evidence for docs/backup/SERVICE-ROLE-AUDIT.md. Never touches production.
# Resets the LOCAL database, applies the pending backup migration, seeds demo data and
# then measures:
#   A. what the service-role key can do (database, Storage, Auth admin);
#   B. which roles can execute the snapshot function, over the API and in SQL;
#   C. what installing pg_net grants;
#   D. a PROTOTYPE of the narrow alternative (token-gated read-only snapshot + Storage read
#      policy). The prototype SQL lives only in this script; it is not a migration.
#   E. timing of the token snapshot against the 3 s statement timeout of the anon role.
#   SUPABASE_CLI=/path/to/supabase WORK_DIR=/tmp/x bash scripts/tests/service-role-audit-local.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
CLI=${SUPABASE_CLI:?SUPABASE_CLI required}; W=${WORK_DIR:?WORK_DIR required}
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres; U=http://127.0.0.1:54321
rm -rf "$W" && mkdir -p "$W" && chmod 700 "$W"; trap 'rm -rf "$W"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✓ $1"; else fail=$((fail+1)); echo "  ✗ $1 — expected [$3] got [$2]"; fi; }
q() { psql -X "$DB" -At -c "$1"; }
code() { curl -s -o "$W/b" -w '%{http_code}' "$@"; }

echo "== fresh local database + pending backup migration + demo data"
timeout 600 "$CLI" db reset --local > "$W/reset.log" 2>&1 || { echo "reset failed"; exit 1; }
psql -X "$DB" -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations-pending/20261115090000_backup_read_access.sql >/dev/null || exit 1
ST=$("$CLI" status -o json 2>/dev/null)
ANON=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ANON_KEY"])' <<<"$ST")
SRK=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])' <<<"$ST")
for i in $(seq 1 60); do curl -s -o /dev/null "$U/rest/v1/" -H "apikey: $ANON" && break; sleep 1; done
SUPABASE_URL=$U SUPABASE_ANON_KEY=$ANON FUNCTIONS_URL=http://127.0.0.1:54399 LAB_CODE=AUDITSR PIN_FILE="$W/pin.txt" \
  node scripts/seed-demo.mjs > "$W/seed.log" 2>&1 || { echo "seed failed (needs the local functions router on 54399)"; exit 1; }
# one private file in the app bucket
LAB=$(q "select id from public.laboratories limit 1")
printf 'solid AuditMarker endsolid\n' > "$W/x.stl"
check "service key uploads a private test file" "$(code -X POST -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: model/stl' --data-binary @"$W/x.stl" "$U/storage/v1/object/case-files/$LAB/audit/x.stl")" 200
OBJ="case-files/$LAB/audit/x.stl"
SH=(-H "apikey: $SRK" -H "Authorization: Bearer $SRK")
AH=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON")

echo "== A. service-role key: database role"
check "service_role has BYPASSRLS, is not superuser, cannot log in" "$(q "select rolbypassrls||','||rolsuper||','||rolcanlogin from pg_roles where rolname='service_role'")" "true,false,false"
check "service_role has ALL privileges (incl. TRUNCATE) on every public table" "$(q "select bool_and(has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")" t
check "service_role can SELECT vault.decrypted_secrets in SQL" "$(q "select has_table_privilege('service_role','vault.decrypted_secrets','SELECT')")" t
check "service_role can schedule cron jobs in SQL" "$(q "select has_function_privilege('service_role','cron.schedule(text,text,text)','EXECUTE')")" t
check "…but the API exposes only public + graphql_public (vault not reachable)" "$(code "${SH[@]}" -H 'Accept-Profile: vault' "$U/rest/v1/decrypted_secrets")" 406
check "…cron not reachable over the API" "$(code "${SH[@]}" -H 'Accept-Profile: cron' "$U/rest/v1/job")" 406
echo "== A. service-role key: API powers (local test data)"
check "reads PIN hashes (employee_credentials)" "$(code "${SH[@]}" "$U/rest/v1/employee_credentials?select=employee_id&limit=1")" 200
check "downloads any private file" "$(code "${SH[@]}" "$U/storage/v1/object/authenticated/$OBJ")" 200
check "makes the private bucket public" "$(code -X PUT "${SH[@]}" -H 'Content-Type: application/json' -d '{"public":true}' "$U/storage/v1/bucket/case-files")" 200
check "…anyone can then download without a key" "$(code "$U/storage/v1/object/public/$OBJ")" 200
code -X PUT "${SH[@]}" -H 'Content-Type: application/json' -d '{"public":false}' "$U/storage/v1/bucket/case-files" >/dev/null
check "lists all auth users (Auth admin API)" "$(code "${SH[@]}" "$U/auth/v1/admin/users?per_page=1")" 200
N=$(q "select count(*) from public.notifications")
check "bulk-deletes a whole table over REST" "$(code -X DELETE "${SH[@]}" "$U/rest/v1/notifications?id=not.is.null")" 204
check "…table now empty (was $N rows)" "$(q "select count(*) from public.notifications")" 0
check "erases the audit trail over REST" "$(code -X DELETE "${SH[@]}" "$U/rest/v1/audit_logs?id=not.is.null")" 204
check "deletes a stored file" "$(code -X DELETE "${SH[@]}" "$U/storage/v1/object/$OBJ")" 200

echo "== B. who can execute public.dlm_backup_snapshot()"
check "roles with EXECUTE (Phase 1b): owner, postgres, supabase_admin only — no longer service_role" "$(q "select string_agg(rolname,',' order by rolname) from pg_roles where has_function_privilege(oid,'public.dlm_backup_snapshot()','EXECUTE')")" "dlm_backup_reader,postgres,supabase_admin"
check "anon: GET refused" "$(code "${AH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot")" 401
check "anon: POST refused" "$(code -X POST "${AH[@]}" -H 'Content-Type: application/json' -d '{}' "$U/rest/v1/rpc/dlm_backup_snapshot")" 401
check "backup RPCs executable by anon/authenticated: only the two token-checked read functions (Phase 1b)" "$(q "select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'dlm_backup%' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))")" dlm_backup_runner_objects,dlm_backup_runner_snapshot
check "no anon/authenticated SECURITY DEFINER function in public uses dynamic SQL" "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.prosrc ~* '\\mexecute\\M' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))")" 0
check "service key: snapshot refused (Phase 1b)" "$(code "${SH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot")" 403

echo "== C. what installing pg_net grants (Supabase event trigger issue_pg_net_access)"
# Production no longer installs pg_net (Phase 1b); installed here, locally, only to show the grants.
psql -X "$DB" -q -c "create extension if not exists pg_net" >/dev/null
check "the grant comes from Supabase's event trigger" "$(q "select count(*) from pg_event_trigger where evtname='issue_pg_net_access'")" 1
check "anon can EXECUTE net.http_post" "$(q "select has_function_privilege('anon','net.http_post(text,jsonb,jsonb,jsonb,integer)','EXECUTE')")" t
check "anon can read and write the request queue (would see the trigger secret)" "$(q "select has_table_privilege('anon','net.http_request_queue','SELECT,INSERT,UPDATE,DELETE')")" t
check "anon can read and write stored responses" "$(q "select has_table_privilege('anon','net._http_response','SELECT,INSERT,UPDATE,DELETE')")" t
check "…but schema net is not reachable over the API" "$(code -X POST "${AH[@]}" -H 'Content-Profile: net' -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:1/"}' "$U/rest/v1/rpc/http_get")" 406
TRIP=$(openssl rand -hex 32); q "insert into dlm_backup.runner_tokens(token_hash,label,expires_at) values (encode(extensions.digest('dlmbk1_$TRIP','sha256'),'hex'),'tripwire',now()+interval '1 day')" >/dev/null
check "tripwire: while pg_net is installed the snapshot refuses to run (backup role could write to net)" "$(code "${AH[@]}" -H "x-dlm-backup-token: dlmbk1_$TRIP" "$U/rest/v1/rpc/dlm_backup_runner_snapshot"; grep -o backup_role_can_write "$W/b")" "400backup_role_can_write"
psql -X "$DB" -q -c "drop extension pg_net" -c "delete from dlm_backup.runner_tokens where label='tripwire'" >/dev/null

echo "== D. PROTOTYPE: token-gated read-only access without the service-role key"
TOK=$(openssl rand -hex 32)
psql -X "$DB" -q -v ON_ERROR_STOP=1 -v tok="$TOK" <<'EOF' || exit 1
create table dlm_backup.tokens(hash text primary key);
insert into dlm_backup.tokens values (encode(extensions.digest(:'tok','sha256'),'hex'));
-- The token travels in a request header (never in the URL, which may be logged).
create function dlm_backup.token_ok() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from dlm_backup.tokens t where t.hash = encode(extensions.digest(
    coalesce(current_setting('request.headers',true)::json->>'x-dlm-backup-token',''),'sha256'),'hex'))
$$;
revoke all on function dlm_backup.token_ok() from public;
grant usage on schema dlm_backup to anon; grant execute on function dlm_backup.token_ok() to anon;
create function public.dlm_backup_snapshot_t() returns json language plpgsql stable security definer set search_path='' as $$
begin
  if not dlm_backup.token_ok() then raise exception 'invalid_token' using errcode='28000'; end if;
  return public.dlm_backup_snapshot();
end $$;
revoke all on function public.dlm_backup_snapshot_t() from public, anon, authenticated, service_role;
grant execute on function public.dlm_backup_snapshot_t() to anon;
create policy dlm_backup_token_read on storage.objects for select to anon using (dlm_backup.token_ok());
notify pgrst, 'reload schema';
EOF
sleep 2
code -X POST "${SH[@]}" -H 'Content-Type: model/stl' --data-binary @"$W/x.stl" "$U/storage/v1/object/case-files/$LAB/audit/y.stl" >/dev/null
OBJ="case-files/$LAB/audit/y.stl"
TH=(-H "x-dlm-backup-token: $TOK")
check "snapshot without token refused" "$(code "${AH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot_t")" 403
check "snapshot with a wrong token refused" "$(code "${AH[@]}" -H "x-dlm-backup-token: $(openssl rand -hex 32)" "$U/rest/v1/rpc/dlm_backup_snapshot_t")" 403
check "snapshot with the token allowed" "$(code "${AH[@]}" "${TH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot_t")" 200
check "file download without token refused" "$(code "${AH[@]}" "$U/storage/v1/object/authenticated/$OBJ")" 400
check "file download with token allowed" "$(code "${AH[@]}" "${TH[@]}" "$U/storage/v1/object/authenticated/$OBJ")" 200
check "token holder: upload refused" "$(code -X POST "${AH[@]}" "${TH[@]}" -H 'Content-Type: model/stl' --data-binary @"$W/x.stl" "$U/storage/v1/object/case-files/$LAB/audit/z.stl")" 400
check "token holder: overwrite refused" "$(code -X PUT "${AH[@]}" "${TH[@]}" -H 'Content-Type: model/stl' --data-binary @"$W/x.stl" "$U/storage/v1/object/$OBJ")" 400
check "token holder: delete file refused" "$(code -X DELETE "${AH[@]}" "${TH[@]}" "$U/storage/v1/object/$OBJ")" 400
check "…file still present" "$(q "select count(*) from storage.objects where bucket_id||'/'||name='$OBJ'")" 1
check "token holder: make bucket public refused" "$(code -X PUT "${AH[@]}" "${TH[@]}" -H 'Content-Type: application/json' -d '{"public":true}' "$U/storage/v1/bucket/case-files")" 400
check "token holder: read a table directly refused" "$(code "${AH[@]}" "${TH[@]}" "$U/rest/v1/patients?select=id&limit=1")" 401
check "token holder: bulk delete refused" "$(code -X DELETE "${AH[@]}" "${TH[@]}" "$U/rest/v1/cases?id=not.is.null")" 401
check "token holder: Auth admin refused" "$(code "${AH[@]}" "${TH[@]}" "$U/auth/v1/admin/users")" 403
check "token revoked (row deleted) → refused immediately" "$(q "delete from dlm_backup.tokens" >/dev/null; code "${AH[@]}" "${TH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot_t")" 403
check "…and file download refused" "$(code "${AH[@]}" "${TH[@]}" "$U/storage/v1/object/authenticated/$OBJ")" 400

echo "== E. anon statement timeout vs snapshot size"
check "anon role statement_timeout is 3s" "$(q "select array_to_string(setconfig,' ') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='anon'")" "statement_timeout=3s"
psql -X "$DB" -q -v tok="$TOK" -c "insert into dlm_backup.tokens values (encode(extensions.digest('$TOK','sha256'),'hex'))" \
  -c "alter table public.audit_logs disable trigger user" \
  -c "insert into public.audit_logs(lab_id,table_name,record_id,action,old_data,new_data) select '$LAB','cases',g::text,'UPDATE',jsonb_build_object('note',repeat('x',200),'n',g),jsonb_build_object('note',repeat('y',200),'n',g) from generate_series(1,40000) g" \
  -c "alter table public.audit_logs enable trigger user"
SZ=$(q "select pg_size_pretty(sum(pg_total_relation_size(c.oid))) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")
R=$(curl -s -o "$W/s.json" -w '%{http_code} %{time_total}' "${AH[@]}" "${TH[@]}" "$U/rest/v1/rpc/dlm_backup_snapshot_t")
echo "  app tables $SZ → snapshot $(stat -c%s "$W/s.json") bytes, HTTP ${R% *}, ${R#* }s"
check "snapshot of ~25 MB of app tables completes under the 3s anon limit" "$(awk -v t="${R#* }" -v c="${R% *}" 'BEGIN{print (c==200 && t<3)?"ok":"slow"}')" ok

echo "== cleanup (local)"
timeout 600 "$CLI" db reset --local > "$W/reset2.log" 2>&1 && echo "  local database reset"
echo; [ $fail -eq 0 ] && echo "ALL PASSED ($pass)" || echo "$fail FAILED ($pass passed)"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
