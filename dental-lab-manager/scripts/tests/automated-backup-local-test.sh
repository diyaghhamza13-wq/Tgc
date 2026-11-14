#!/usr/bin/env bash
# LOCAL-ONLY end-to-end test of the automated backup. Never touches production.
# Needs: local Supabase stack (127.0.0.1:54321/54322), local edge functions router
# on 127.0.0.1:54399 (for seed-demo / employee login), deno, age, psql, node.
#   WORK_DIR=/tmp/... SUPABASE_CLI=/path/to/supabase DENO=/path/to/deno bash scripts/tests/automated-backup-local-test.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
W=${WORK_DIR:?WORK_DIR required}; CLI=${SUPABASE_CLI:?SUPABASE_CLI required}; DENO=${DENO:?DENO required}
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
rm -rf "$W" && mkdir -p "$W" && chmod 700 "$W"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -f supabase/functions/dlm-backup/deno.lock; rm -rf "$W"; }
trap cleanup EXIT

echo "== fresh local database + pending backup migration (local only)"
timeout 600 "$CLI" db reset --local > "$W/reset.log" 2>&1 || { echo "reset failed"; tail -5 "$W/reset.log"; exit 1; }
psql -X "$DB" -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations-pending/20261114190000_automated_backup.sql >/dev/null || exit 1
STATUS=$("$CLI" status -o json 2>/dev/null)
ANON=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ANON_KEY"])' <<<"$STATUS")
SRK=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])' <<<"$STATUS")
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:54321/rest/v1/ -H "apikey: $ANON" && break; sleep 1; done
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=$ANON FUNCTIONS_URL=http://127.0.0.1:54399 LAB_CODE=LOCALBK PIN_FILE="$W/pin.txt" \
  node scripts/seed-demo.mjs 2>&1 | grep -iv pin | tail -1

echo "== simulators, test key, function"
age-keygen -o "$W/k.txt" 2>/dev/null; chmod 600 "$W/k.txt"; PUB=$(age-keygen -y "$W/k.txt")
KEYS='"keys":{"FNWRITE":{"secret":"fn-write-secret-local-test","perms":["put"]},"FNREAD":{"secret":"fn-read-secret-local-test","perms":["get","head"]},"ADMIN":{"secret":"admin-secret-local-test","perms":["admin"]}}'
echo "{\"port\":54400,\"region\":\"eu-test-1\",\"bucket\":\"dlm-backups-test\",\"lockDays\":35,\"expireDays\":35,$KEYS}" > "$W/sim.json"
echo "{\"port\":54402,\"region\":\"eu-test-1\",\"bucket\":\"dlm-backups-test\",\"lockDays\":35,\"expireDays\":30,$KEYS}" > "$W/sim2.json"
node scripts/backup/sim/s3-simulator.mjs "$W/sim.json" > "$W/sim.log" 2>&1 & PIDS+=($!)
node scripts/backup/sim/s3-simulator.mjs "$W/sim2.json" > "$W/sim2.log" 2>&1 & PIDS+=($!)
ALLOW_ENV=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,DLM_BACKUP_AGE_RECIPIENTS,DLM_BACKUP_S3_ENDPOINT,DLM_BACKUP_S3_REGION,DLM_BACKUP_S3_BUCKET,DLM_BACKUP_S3_WRITE_KEY_ID,DLM_BACKUP_S3_WRITE_SECRET,DLM_BACKUP_S3_READ_KEY_ID,DLM_BACKUP_S3_READ_SECRET,DLM_TEST_PORT
start_fn() { # $1 port, $2 endpoint, $3 log
  env -i PATH="$PATH" HOME="$HOME" DENO_DIR="${DENO_DIR:-$HOME/.cache/deno}" DENO_CERT="${DENO_CERT:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" NO_PROXY="127.0.0.1,localhost,0.0.0.0" \
    SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY="$SRK" SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    DLM_BACKUP_AGE_RECIPIENTS="$PUB" DLM_BACKUP_S3_ENDPOINT="$2" DLM_BACKUP_S3_REGION=eu-test-1 DLM_BACKUP_S3_BUCKET=dlm-backups-test \
    DLM_BACKUP_S3_WRITE_KEY_ID=FNWRITE DLM_BACKUP_S3_WRITE_SECRET=fn-write-secret-local-test \
    DLM_BACKUP_S3_READ_KEY_ID=FNREAD DLM_BACKUP_S3_READ_SECRET=fn-read-secret-local-test DLM_TEST_PORT="$1" \
    "$DENO" run --no-prompt --no-lock --config supabase/functions/dlm-backup/deno.json \
      --allow-env="$ALLOW_ENV" --allow-net="127.0.0.1:54321,127.0.0.1:54400,0.0.0.0:$1" \
      scripts/tests/dlm-backup-serve.ts > "$3" 2>&1 &
  PIDS+=($!)
}
# SUPABASE_DB_URL IS present in the process environment (as on Supabase), but NOT in
# Deno's --allow-env list: the function could not read it even if it tried.
start_fn 54401 http://127.0.0.1:54400 "$W/fn.log"
start_fn 54403 http://storage.example.com "$W/fn-bad.log"
for i in $(seq 1 120); do grep -q "test server on" "$W/fn.log" 2>/dev/null && grep -q "test server on" "$W/fn-bad.log" 2>/dev/null && break; sleep 1; done
grep -q "test server on" "$W/fn.log" || { echo "function did not start"; cat "$W/fn.log"; exit 1; }

echo "== test"
WORK_DIR="$W" SRK="$SRK" ANON="$ANON" PIN_FILE="$W/pin.txt" DENO_ALLOW_ENV="$ALLOW_ENV" node scripts/tests/automated-backup-local-test.mjs
rc=$?
if [ $rc -eq 0 ]; then
  echo "== offline browser tool (headless Chromium, network blocked)"
  WORK_DIR="$W" node scripts/tests/backup-tool-browser-test.mjs || rc=1
fi
psql -X "$DB" -q -c "select cron.unschedule(jobname) from cron.job where jobname like 'dlm-backup-%'" >/dev/null 2>&1
exit $rc
