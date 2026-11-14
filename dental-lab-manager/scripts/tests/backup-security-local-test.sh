#!/usr/bin/env bash
# LOCAL-ONLY regression tests for the backup security findings F1–F7 and the
# role permission review. Uses:
#   * a TEMPORARY PostgreSQL 16 server with real TLS (test CA, server cert for
#     127.0.0.2), started in a mktemp directory and deleted at the end;
#   * the local Supabase stack (127.0.0.1:54322) for the role review.
# Never connects to production. Run as root (the temporary server runs as the
# `postgres` system user).   Usage: bash scripts/tests/backup-security-local-test.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
BIN=/usr/lib/postgresql/16/bin
SUPA=postgresql://postgres:postgres@127.0.0.1:54322/postgres
PORT=55432
ok=0; bad=0
t()  { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi; }
out() { eval "$1" 2>&1; }   # captures stdout+stderr of a command

T=$(mktemp -d /tmp/dlm-tls-XXXXXX); chmod 755 "$T"
mkdir -p "$T/data" "$T/run"; chown postgres "$T/data" "$T/run"; chmod 700 "$T/data"
cleanup() {
  runuser -u postgres -- "$BIN/pg_ctl" -D "$T/data" -m immediate stop >/dev/null 2>&1
  psql -X "$SUPA" -q -c "do \$\$ begin if exists (select 1 from pg_roles where rolname='dlm_backup_reader') then
    execute 'alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader';
    execute 'revoke select on all tables in schema public from dlm_backup_reader';
    execute 'revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader';
    execute 'revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader';
    execute 'drop role dlm_backup_reader'; end if; end \$\$;" >/dev/null 2>&1
  rm -rf "$T"
}
trap cleanup EXIT

echo "0. temporary TLS PostgreSQL (test CA; server certificate for 127.0.0.2 only)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=dlm test CA" -keyout "$T/ca.key" -out "$T/ca.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=wrong CA" -keyout "$T/wrong.key" -out "$T/wrong-ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.2" -keyout "$T/server.key" -out "$T/server.csr" >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.2\n' > "$T/san.ext"
openssl x509 -req -in "$T/server.csr" -CA "$T/ca.crt" -CAkey "$T/ca.key" -CAcreateserial -days 1 -extfile "$T/san.ext" -out "$T/server.crt" >/dev/null 2>&1
chown postgres "$T/server.key" "$T/server.crt"; chmod 600 "$T/server.key"
ADMIN_PW=$(openssl rand -hex 16); echo "$ADMIN_PW" > "$T/pw"; chown postgres "$T/pw"
runuser -u postgres -- "$BIN/initdb" -D "$T/data" -U postgres --auth=scram-sha-256 --pwfile="$T/pw" >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
rm -f "$T/pw"
cat >> "$T/data/postgresql.conf" <<EOF
listen_addresses = '127.0.0.2,127.0.0.3'
port = $PORT
unix_socket_directories = '$T/run'
ssl = on
ssl_cert_file = '$T/server.crt'
ssl_key_file = '$T/server.key'
log_statement = 'all'
logging_collector = off
EOF
printf 'local all all scram-sha-256\nhostssl all all 127.0.0.0/8 scram-sha-256\n' > "$T/data/pg_hba.conf"
runuser -u postgres -- "$BIN/pg_ctl" -D "$T/data" -l "$T/run/server.log" -w start >/dev/null 2>&1 || { echo "server start failed"; cat "$T/run/server.log"; exit 1; }
TLS_ADMIN="postgresql://postgres@127.0.0.2:$PORT/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null || { echo "TLS fixture failed"; exit 1; }
create schema auth; create schema vault; create schema storage; create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key);
insert into supabase_migrations.schema_migrations values ('20990101000000');
create table storage.objects (bucket_id text, name text, metadata jsonb, created_at timestamptz default now());
create table public.laboratories (id int primary key, name text);
alter table public.laboratories enable row level security;
insert into public.laboratories values (1, 'Fixture Lab');
SQL
psql -X "$TLS_ADMIN" -q -v ON_ERROR_STOP=1 -f docs/backup/readonly-role-setup.sql >/dev/null 2>&1 <<<"" || PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -v ON_ERROR_STOP=1 -f docs/backup/readonly-role-setup.sql >/dev/null
echo "  (TLS fixture ready; read-only role created from docs/backup/readonly-role-setup.sql)"

echo "F3. password set with psql \\password over TLS (no plain text sent)"
RO_PW=$(openssl rand -hex 20)
t "\\password succeeds through a terminal session" "NEW_ROLE_PASSWORD=$RO_PW PGPASSWORD=$ADMIN_PW python3 -I scripts/tests/psql-password-pty.py '$TLS_ADMIN' dlm_backup_reader"
t "stored as a SCRAM-SHA-256 verifier" "[ \"\$(PGPASSWORD=$ADMIN_PW psql -X '$TLS_ADMIN' -At -c \"select left(rolpassword,14) from pg_authid where rolname='dlm_backup_reader'\")\" = 'SCRAM-SHA-256\$' ]"
t "the plain password never reached the server log (log_statement=all)" "! grep -q '$RO_PW' '$T/run/server.log'"
t "only the verifier was logged" "grep -q 'SCRAM-SHA-256' '$T/run/server.log'"
DEMO=$(openssl rand -hex 12)
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "create role dlm_demo_plain login password '$DEMO'" >/dev/null
t "contrast: an SQL-editor style ALTER/CREATE ... PASSWORD 'plain' IS logged in plain text" "grep -q '$DEMO' '$T/run/server.log'"
export PGPASSWORD=$RO_PW
RO="postgresql://dlm_backup_reader@127.0.0.2:$PORT/postgres"
GOOD="$RO?sslmode=verify-full&sslrootcert=$T/ca.crt"

echo "F2. TLS with certificate and host-name verification"
t "READY over verify-full with the right CA" "DB_URL='$GOOD' node scripts/backup/check-connection.mjs"
t "the established session is really encrypted (TLS version reported)" "DB_URL='$GOOD' node scripts/backup/check-connection.mjs | grep -q 'TLSv1'"
t "remote sslmode=require is refused" "! DB_URL='$RO?sslmode=require' node scripts/backup/check-connection.mjs"
t "remote verify-full without sslrootcert is refused" "! DB_URL='$RO?sslmode=verify-full' node scripts/backup/check-connection.mjs"
t "remote URL without any sslmode is refused" "! DB_URL='$RO' node scripts/backup/check-connection.mjs"
t "sslrootcert that does not exist is refused" "! DB_URL='$RO?sslmode=verify-full&sslrootcert=$T/missing.crt' node scripts/backup/check-connection.mjs"
t "a certificate signed by another CA is rejected (no connection)" "out \"DB_URL='$RO?sslmode=verify-full&sslrootcert=$T/wrong-ca.crt' node scripts/backup/check-connection.mjs\" | grep -q -i 'certificate'"
t "a host name not in the certificate is rejected (127.0.0.3)" "out \"DB_URL='postgresql://dlm_backup_reader@127.0.0.3:$PORT/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt' node scripts/backup/check-connection.mjs\" | grep -q -i 'does not match\|certificate'"

echo "F1. URL and environment cannot redirect or weaken the connection"
t "?host= override is refused" "out \"DB_URL='postgresql://u@localhost:5432/postgres?host=db.example.invalid' node scripts/backup/check-connection.mjs\" | grep -q 'not allowed'"
t "?hostaddr= is refused" "out \"DB_URL='$GOOD&hostaddr=203.0.113.9' node scripts/backup/check-connection.mjs\" | grep -q 'not allowed'"
t "duplicate sslmode (require then disable) is refused" "out \"DB_URL='$RO?sslmode=verify-full&sslrootcert=$T/ca.crt&sslmode=disable' node scripts/backup/check-connection.mjs\" | grep -q 'more than once'"
t "multiple hosts are refused" "out \"DB_URL='postgresql://u@127.0.0.2:$PORT,db.example.invalid:5432/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt' node scripts/backup/check-connection.mjs\" | grep -q -i 'one host\|not a valid'"
t "PGHOSTADDR / PGSSLMODE / PGOPTIONS in the environment are ignored" "PGHOSTADDR=203.0.113.9 PGSSLMODE=disable PGOPTIONS='-c default_transaction_read_only=off' DB_URL='$GOOD' node scripts/backup/check-connection.mjs"
t "export refuses the same host override" "! DB_URL='postgresql://u@localhost:5432/postgres?host=db.example.invalid' AGE_RECIPIENT=\$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*') OUT_DIR=$T/o node scripts/backup/export.mjs"
t "export refuses duplicate sslmode" "! DB_URL='$RO?sslmode=verify-full&sslrootcert=$T/ca.crt&sslmode=disable' AGE_RECIPIENT=\$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*') OUT_DIR=$T/o node scripts/backup/export.mjs"
t "export: cloud (Management API) mode no longer exists" "! SUPABASE_PROJECT_REF=localtestref DB_URL='$GOOD' AGE_RECIPIENT=\$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*') OUT_DIR=$T/o node scripts/backup/export.mjs"
t "export: ALLOW_PRIVILEGED_LOGIN is refused for a non-local host" "! ALLOW_PRIVILEGED_LOGIN=1 PGPASSWORD=$ADMIN_PW DB_URL='postgresql://postgres@127.0.0.2:$PORT/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt' AGE_RECIPIENT=\$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*') OUT_DIR=$T/o node scripts/backup/export.mjs"

echo "F4. no password or connection string in any error"
L1=$(out "DB_URL='postgresql://dlm_backup_reader:SECRET-IN-URL-1@127.0.0.2:$PORT/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt' node scripts/backup/check-connection.mjs")
t "wrong password in URL: password not printed (check-connection)" "! grep -q 'SECRET-IN-URL-1' <<<\"\$L1\" && ! grep -q 'postgresql://' <<<\"\$L1\""
L2=$(out "PGPASSWORD=SECRET-ENV-2 DB_URL='$GOOD' node scripts/backup/check-connection.mjs")
t "wrong PGPASSWORD: value not printed" "! grep -q 'SECRET-ENV-2' <<<\"\$L2\""
L3=$(out "DB_URL='postgresql://dlm_backup_reader:SECRET-IN-URL-3@127.0.0.2:1/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt' AGE_RECIPIENT=\$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*') OUT_DIR=$T/o node scripts/backup/export.mjs")
t "unreachable server: export prints neither password nor URL" "! grep -q 'SECRET-IN-URL-3' <<<\"\$L3\" && ! grep -q 'postgresql://' <<<\"\$L3\""
L4=$(out "DB_URL='postgresql://u:SECRET-IN-URL-4@db.example.invalid/postgres?sslmode=require' node scripts/backup/check-connection.mjs")
t "invalid URL: validation error does not echo the URL" "! grep -q 'SECRET-IN-URL-4' <<<\"\$L4\""
age-keygen -o "$T/k.txt" 2>/dev/null; PUB=$(age-keygen -y "$T/k.txt")
DB_URL="$GOOD" AGE_RECIPIENT=$PUB OUT_DIR=$T/up node scripts/backup/export.mjs >/dev/null 2>&1
ENC=$(ls "$T"/up/*.json.age 2>/dev/null | head -1)
L5=$(out "BACKUP_STORAGE_URL=https://upload.example.invalid BACKUP_APIKEY=SECRET-KEY-5 node scripts/backup/upload.mjs '$ENC'")
t "upload failure does not print the upload key" "! grep -q 'SECRET-KEY-5' <<<\"\$L5\""

echo "F5. completeness: RLS bypass and read-only privileges verified before export"
t "export over verify-full TLS succeeds with the read-only login" "[ -f '$ENC' ]"
t "manifest records the login and the TLS version" "grep -q '\"login\": \"dlm_backup_reader\"' '${ENC%.json.age}.manifest.json' && grep -q 'TLSv1' '${ENC%.json.age}.manifest.json'"
t "the backup decrypts and verifies" "age -d -i $T/k.txt '$ENC' | node scripts/backup/verify.mjs '${ENC%.json.age}.manifest.json'"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
create role dlm_nobypass login password '$RO_PW' nosuperuser nobypassrls;
grant usage on schema public, supabase_migrations, storage to dlm_nobypass;
grant select on all tables in schema public to dlm_nobypass;
grant select on supabase_migrations.schema_migrations, storage.objects to dlm_nobypass;
alter role dlm_nobypass set default_transaction_read_only = on;
SQL
NB="postgresql://dlm_nobypass@127.0.0.2:$PORT/postgres?sslmode=verify-full&sslrootcert=$T/ca.crt"
t "a login WITHOUT RLS bypass is reported as incomplete" "out \"DB_URL='$NB' node scripts/backup/check-connection.mjs\" | grep -q '✗ bypasses row-level security'"
t "export refuses it and writes no file" "! DB_URL='$NB' AGE_RECIPIENT=$PUB OUT_DIR=$T/nb node scripts/backup/export.mjs && [ ! -d $T/nb ]"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "grant insert on public.laboratories to dlm_backup_reader" >/dev/null
t "an extra write privilege is detected and export refuses" "! DB_URL='$GOOD' AGE_RECIPIENT=$PUB OUT_DIR=$T/w node scripts/backup/export.mjs"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "revoke insert on public.laboratories from dlm_backup_reader; grant trigger on public.laboratories to dlm_backup_reader" >/dev/null
t "a TRIGGER privilege is detected" "! DB_URL='$GOOD' node scripts/backup/check-connection.mjs"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "revoke trigger on public.laboratories from dlm_backup_reader; create function public.dlm_evil() returns void language sql security definer as 'select 1'; grant execute on function public.dlm_evil() to dlm_backup_reader" >/dev/null
t "an executable SECURITY DEFINER function is detected" "out \"DB_URL='$GOOD' node scripts/backup/check-connection.mjs\" | grep -q '✗ cannot execute any SECURITY DEFINER'"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "drop function public.dlm_evil(); grant usage on schema vault to dlm_backup_reader" >/dev/null
t "access to the vault schema is detected" "! DB_URL='$GOOD' node scripts/backup/check-connection.mjs"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "revoke usage on schema vault from dlm_backup_reader; grant pg_read_all_stats to dlm_backup_reader" >/dev/null
t "membership in another role is detected" "out \"DB_URL='$GOOD' node scripts/backup/check-connection.mjs\" | grep -q '✗ not a member'"
PGPASSWORD=$ADMIN_PW psql -X "$TLS_ADMIN" -q -c "revoke pg_read_all_stats from dlm_backup_reader" >/dev/null
t "after reverting: READY again" "DB_URL='$GOOD' node scripts/backup/check-connection.mjs"

echo "F6. psql -X and HTTPS-only uploads"
mkdir -p "$T/home"; printf "\\\\echo PSQLRC-WAS-READ\n\\\\pset format html\n" > "$T/home/.psqlrc"; printf "\\\\echo PSQLRC-ENV-WAS-READ\n" > "$T/evil.psqlrc"
L6=$(out "HOME=$T/home PSQLRC=$T/evil.psqlrc DB_URL='$GOOD' node scripts/backup/check-connection.mjs")
t "~/.psqlrc and PSQLRC are ignored (READY, nothing from psqlrc)" "grep -q READY <<<\"\$L6\" && ! grep -q 'PSQLRC' <<<\"\$L6\""
t "every psql call in the backup scripts uses -X" "! grep -n \"execFileSync('psql'\" scripts/backup/*.mjs | grep -v -- \"'-X'\""
t "upload refuses http:// for a remote host" "out \"BACKUP_STORAGE_URL=http://upload.example.invalid BACKUP_APIKEY=k node scripts/backup/upload.mjs '$ENC'\" | grep -q 'https'"
t "upload refuses credentials or paths in the URL" "! BACKUP_STORAGE_URL=https://user:pw@upload.example.invalid BACKUP_APIKEY=k node scripts/backup/upload.mjs '$ENC' && ! BACKUP_STORAGE_URL=https://upload.example.invalid/x BACKUP_APIKEY=k node scripts/backup/upload.mjs '$ENC'"

echo "Schema hygiene (local Supabase stack with ALL migrations, incl. Phase 1)"
t "no SECURITY DEFINER function in public is executable by everyone" "[ \"\$(psql -X '$SUPA' -At -c \"select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))\")\" = 0 ]"
t "Phase 1 internal helpers are not executable by app users" "[ \"\$(psql -X '$SUPA' -At -c \"select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('_attachments_production_only','_production_file_name','_safe_file_label','_redacted_path','redact_legacy_file_names','redact_legacy_attachment','restore_legacy_file_records')\")\" = f ]"

echo "F7. explicit role attributes (local Supabase stack, created from the SQL file)"
psql -X "$SUPA" -q -v ON_ERROR_STOP=1 -f docs/backup/readonly-role-setup.sql >/dev/null
t "rolsuper/createdb/createrole/replication/inherit = false, bypassrls = true, limit 2" "[ \"\$(psql -X '$SUPA' -At -c \"select rolsuper::text||rolcreatedb||rolcreaterole||rolreplication||rolinherit||rolbypassrls||rolconnlimit from pg_roles where rolname='dlm_backup_reader'\")\" = 'falsefalsefalsefalsefalsetrue2' ]"
t "the SQL file declares the attributes explicitly" "grep -q 'nosuperuser nocreatedb nocreaterole noreplication' docs/backup/readonly-role-setup.sql"
t "the SQL file contains no password" "! grep -i -E \"password '[^<]\" docs/backup/readonly-role-setup.sql"
LOCAL_PW=$(openssl rand -hex 16); psql -X "$SUPA" -q -c "alter role dlm_backup_reader password '$LOCAL_PW'" >/dev/null
L7=$(PGPASSWORD=$LOCAL_PW DB_URL=postgresql://dlm_backup_reader@127.0.0.1:54322/postgres node scripts/backup/check-connection.mjs 2>&1)
t "role review on the full app schema: READY (all checks, every accessible schema)" "grep -q READY <<<\"\$L7\""
t "accessible schemas are exactly public, storage, supabase_migrations" "grep -q 'accessible schemas: public, storage, supabase_migrations$' <<<\"\$L7\""

unset PGPASSWORD
echo
[ $bad -eq 0 ] && echo "ALL PASSED ($ok)" || echo "$bad FAILED ($ok passed)"
exit $bad
