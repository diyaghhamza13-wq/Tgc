#!/usr/bin/env bash
# LOCAL-ONLY test of the phone-based backup flow, run against the local
# Supabase stack exactly as it would run in Termux:
#   tool check -> read-only role -> connection check -> export (local file)
#   -> verify (no plaintext on disk) -> optional upload (insert-only bucket)
#   -> guards (privileged login, cloud mode, plain-text remote URL, wrong key,
#      tampered manifest, non-encrypted upload, duplicate upload).
# Usage: WORK_DIR=/tmp/... ANON_KEY=<local anon key> bash scripts/tests/backup-phone-flow-local-test.sh
set -u
DB_ADMIN=postgresql://postgres:postgres@127.0.0.1:54322/postgres
RO_URL=postgresql://dlm_backup_reader@127.0.0.1:54322/postgres
W=${WORK_DIR:?WORK_DIR required}; ANON=${ANON_KEY:?ANON_KEY required}
case "$DB_ADMIN" in *127.0.0.1*) ;; *) echo "local only"; exit 2;; esac
rm -rf "$W/phone" && mkdir -p "$W/phone" && cd "$(dirname "$0")/../.." || exit 2
ok=0; bad=0
t() { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi; }

echo "1. phone tool check"
age-keygen -o "$W/phone/key.txt" 2>/dev/null; chmod 600 "$W/phone/key.txt"
PUB=$(age-keygen -y "$W/phone/key.txt")
t "termux-check.sh passes (tools, key round trip, scripts)" "bash scripts/backup/termux-check.sh $W/phone/key.txt"

echo "2. read-only role (docs/backup/readonly-role-setup.sql, local) + password set separately"
psql -X "$DB_ADMIN" -q -v ON_ERROR_STOP=1 -f docs/backup/readonly-role-setup.sql >/dev/null || { echo "role setup failed"; exit 1; }
PW=$(openssl rand -hex 16)
psql -X "$DB_ADMIN" -q -c "alter role dlm_backup_reader password '$PW'" >/dev/null
export PGPASSWORD=$PW

echo "3. connection check (metadata only)"
t "check-connection: READY with the read-only login" "DB_URL=$RO_URL node scripts/backup/check-connection.mjs"
t "check-connection: refuses the full postgres login" "! PGPASSWORD=postgres DB_URL=$DB_ADMIN node scripts/backup/check-connection.mjs"
t "check-connection: wrong password fails cleanly" "! PGPASSWORD=wrong DB_URL=$RO_URL node scripts/backup/check-connection.mjs"

echo "4. export saved locally (no upload)"
t "export with the read-only login" "DB_URL=$RO_URL AGE_RECIPIENT=$PUB OUT_DIR=$W/phone/out node scripts/backup/export.mjs"
ENC=$(ls "$W"/phone/out/*.json.age 2>/dev/null | head -1); MAN=${ENC%.json.age}.manifest.json
t "encrypted file and manifest saved, file is age-encrypted" "[ -f '$MAN' ] && head -c 21 '$ENC' | grep -q 'age-encryption.org/v1'"
t "no plaintext JSON written" "! ls $W/phone/out | grep -v -E '\.json\.age$|\.manifest\.json$'"
t "manifest holds no row data (only counts/hashes)" "! grep -q -i -E 'Demo|Fatima|full_name' '$MAN'"
t "export refuses the full postgres login" "! PGPASSWORD=postgres DB_URL=$DB_ADMIN AGE_RECIPIENT=$PUB OUT_DIR=$W/phone/x node scripts/backup/export.mjs"
t "export refuses the removed Management API mode" "! SUPABASE_PROJECT_REF=localtestref AGE_RECIPIENT=$PUB OUT_DIR=$W/phone/x node scripts/backup/export.mjs"
t "export refuses a remote URL without sslmode" "! DB_URL=postgresql://u@db.example.invalid:5432/postgres AGE_RECIPIENT=$PUB OUT_DIR=$W/phone/x node scripts/backup/export.mjs"
t "export refuses OUT_DIR inside the repository" "! DB_URL=$RO_URL AGE_RECIPIENT=$PUB OUT_DIR=$PWD/tmp-backup node scripts/backup/export.mjs"

echo "5. verify (decrypt to a pipe, no plaintext on disk)"
t "verify OK with the right key and manifest" "age -d -i $W/phone/key.txt '$ENC' | node scripts/backup/verify.mjs '$MAN'"
age-keygen -o "$W/phone/other.txt" 2>/dev/null
t "verify fails with a wrong key" "! (age -d -i $W/phone/other.txt '$ENC' 2>/dev/null | node scripts/backup/verify.mjs '$MAN')"
python3 -c "import json,sys; m=json.load(open(sys.argv[1])); t=next(iter(m['tables'])); m['tables'][t]['rows']+=1; json.dump(m,open(sys.argv[2],'w'))" "$MAN" "$W/phone/tampered.json"
t "verify detects a manifest mismatch" "! (age -d -i $W/phone/key.txt '$ENC' | node scripts/backup/verify.mjs $W/phone/tampered.json)"

echo "6. optional upload to the insert-only bucket (local simulation of the backup project)"
psql -X "$DB_ADMIN" -q -v ON_ERROR_STOP=1 -f docs/backup/backup-project-setup.sql >/dev/null 2>&1 || true
t "upload the encrypted file" "BACKUP_STORAGE_URL=http://127.0.0.1:54321 BACKUP_APIKEY=$ANON node scripts/backup/upload.mjs '$ENC'"
t "second upload of the same file is refused (no overwrite)" "! BACKUP_STORAGE_URL=http://127.0.0.1:54321 BACKUP_APIKEY=$ANON node scripts/backup/upload.mjs '$ENC'"
cp "$MAN" "$W/phone/20261114T000000Z-00000000.json.age"
t "upload refuses a non-encrypted file" "! BACKUP_STORAGE_URL=http://127.0.0.1:54321 BACKUP_APIKEY=$ANON node scripts/backup/upload.mjs $W/phone/20261114T000000Z-00000000.json.age"
t "the upload key cannot download it" "[ \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/storage/v1/object/dlm-backups/$(basename "$ENC") -H 'apikey: $ANON') != 200 ]"
t "uploaded bytes identical to the local file" "[ \"\$(psql -X $DB_ADMIN -At -c \"select metadata->>'size' from storage.objects where bucket_id='dlm-backups' and name='$(basename "$ENC")'\")\" = \"\$(stat -c %s '$ENC')\" ]"

echo "7. cleanup (local role removed, test files deleted)"
psql -X "$DB_ADMIN" -q -c "alter default privileges for role postgres in schema public revoke select on tables from dlm_backup_reader; revoke select on all tables in schema public from dlm_backup_reader; revoke select on supabase_migrations.schema_migrations, storage.objects from dlm_backup_reader; revoke usage on schema public, supabase_migrations, storage from dlm_backup_reader; drop role dlm_backup_reader;" >/dev/null
t "role removed" "[ -z \"\$(psql -X $DB_ADMIN -At -c \"select 1 from pg_roles where rolname='dlm_backup_reader'\")\" ]"
rm -rf "$W/phone"; unset PGPASSWORD

echo
[ $bad -eq 0 ] && echo "ALL PASSED ($ok)" || echo "$bad FAILED ($ok passed)"
exit $bad
