#!/usr/bin/env bash
# LOCAL-ONLY end-to-end + security test of the automated backup with a SEPARATE
# Backup Runner project. Never touches production or any external service.
#
# Two local Supabase stacks:
#   "production"  this repository's supabase/   API 54321, DB 54322 (+ pending migration)
#   "runner"      backup-runner/supabase/       API 54331, DB 54332 (own ES256 signing key,
#                                               so its keys differ from production's)
# plus: a recording proxy in front of production (54410), two S3 simulators
# (54400, 54402) and the runner function served by Deno with env/network allow-lists.
# Needs the local edge functions router on 127.0.0.1:54399 (seed-demo / employee login).
#   WORK_DIR=/tmp/... SUPABASE_CLI=/path/to/supabase DENO=/path/to/deno bash scripts/tests/automated-backup-local-test.sh
# KEEP_RUNNER=1 leaves the runner stack running afterwards; PERF_ONLY=1 runs only the performance check.
set -u
cd "$(dirname "$0")/../.." || exit 2
W=${WORK_DIR:?WORK_DIR required}; CLI=${SUPABASE_CLI:?SUPABASE_CLI required}; DENO=${DENO:?DENO required}
FNDIR=backup-runner/supabase/functions/dlm-backup
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
RDB=postgresql://postgres:postgres@127.0.0.1:54332/postgres
rm -rf "$W" && mkdir -p "$W" && chmod 700 "$W"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  docker rm -f dlm-edge-test >/dev/null 2>&1
  psql -X "$RDB" -q -c "select cron.unschedule(jobname) from cron.job where jobname like 'dlm-backup-%'" >/dev/null 2>&1
  if [ "${KEEP_RUNNER:-0}" != 1 ]; then (cd backup-runner && "$CLI" stop --no-backup >/dev/null 2>&1); rm -f backup-runner/supabase/signing_keys.json; fi
  rm -rf "$W"
}
trap cleanup EXIT

echo "== production (local): fresh database + pending migration + demo data"
timeout 600 "$CLI" db reset --local > "$W/reset.log" 2>&1 || { echo "reset failed"; tail -5 "$W/reset.log"; exit 1; }
# fail-closed pre-check: on a Storage version without the operation helper the migration must abort
printf 'begin;\nalter function storage.allow_only_operation(text) rename to allow_only_operation_hidden;\nset role postgres;\n\\ir ../../supabase/migrations-pending/20261115090000_backup_read_access.sql\nrollback;\n' > "$W/precheck.sql"
cp "$W/precheck.sql" scripts/tests/.precheck-tmp.sql
if psql -X "${DB/postgres:postgres@/supabase_admin:postgres@}" -q -v ON_ERROR_STOP=1 -f scripts/tests/.precheck-tmp.sql > "$W/precheck.log" 2>&1 || ! grep -q 'Migration aborted; nothing was changed' "$W/precheck.log"; then
  rm -f scripts/tests/.precheck-tmp.sql; echo "  ✗ migration pre-check did not abort on a Storage version without allow_only_operation"; cat "$W/precheck.log"; exit 1
fi
rm -f scripts/tests/.precheck-tmp.sql
[ "$(psql -X "$DB" -At -c "select count(*) from pg_roles where rolname = 'dlm_backup_reader'")" = 0 ] || { echo "  ✗ pre-check left changes behind"; exit 1; }
echo "  ✓ migration aborts cleanly (nothing changed) when Storage lacks storage.allow_only_operation()"
psql -X "$DB" -q -v ON_ERROR_STOP=1 -1 -f supabase/migrations-pending/20261115090000_backup_read_access.sql >/dev/null || exit 1
ST=$("$CLI" status -o json 2>/dev/null)
ANON=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ANON_KEY"])' <<<"$ST")
SRK=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])' <<<"$ST")
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:54321/rest/v1/ -H "apikey: $ANON" && break; sleep 1; done
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=$ANON FUNCTIONS_URL=http://127.0.0.1:54399 LAB_CODE=LOCALBK PIN_FILE="$W/pin.txt" \
  node scripts/seed-demo.mjs 2>&1 | grep -iv pin | tail -1

echo "== runner (local): separate stack, own signing key, fresh database"
if [ ! -s backup-runner/supabase/signing_keys.json ]; then
  echo '[]' > backup-runner/supabase/signing_keys.json
  (cd backup-runner && "$CLI" gen signing-key --algorithm ES256 --append >/dev/null 2>&1) || { echo "signing key failed"; exit 1; }
fi
(cd backup-runner && timeout 900 "$CLI" start -x realtime,storage-api,imgproxy,studio,mailpit,postgres-meta,logflare,vector,supavisor,edge-runtime > "$W/runner-start.log" 2>&1) || { echo "runner start failed"; tail -5 "$W/runner-start.log"; exit 1; }
(cd backup-runner && timeout 600 "$CLI" db reset --local > "$W/runner-reset.log" 2>&1) || { echo "runner reset failed"; tail -5 "$W/runner-reset.log"; exit 1; }
RST=$(cd backup-runner && "$CLI" status -o json 2>/dev/null)
RSRK=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["SERVICE_ROLE_KEY"])' <<<"$RST")
RANON=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ANON_KEY"])' <<<"$RST")
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:54331/rest/v1/ -H "apikey: $RANON" && break; sleep 1; done
RGW=$(docker network inspect supabase_network_dlm-backup-runner -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)

echo "== backup token (generated outside production; production gets only the hash)"
node scripts/backup/runner-token.mjs "$W/token.txt" "local test A" > "$W/token-a.out" || exit 1
TOKEN=$(head -1 "$W/token.txt")
psql -X "$DB" -At -v ON_ERROR_STOP=1 -c "$(grep -o 'select dlm_backup.register_token.*' "$W/token-a.out")" > "$W/token-a.id" || exit 1

echo "== simulators, recording proxy, test key, runner function"
age-keygen -o "$W/k.txt" 2>/dev/null; chmod 600 "$W/k.txt"; PUB=$(age-keygen -y "$W/k.txt")
KEYS='"keys":{"FNWRITE":{"secret":"fn-write-secret-local-test","perms":["put"]},"FNREAD":{"secret":"fn-read-secret-local-test","perms":["get","head","retention"]},"RESTORE":{"secret":"restore-secret-local-test","perms":["get","head","list"]},"ADMIN":{"secret":"admin-secret-local-test","perms":["admin"]}}'
echo "{\"port\":54400,\"region\":\"eu-test-1\",\"bucket\":\"dlm-backups-test\",\"lockDays\":35,\"expireDays\":35,$KEYS}" > "$W/sim.json"
echo "{\"port\":54402,\"region\":\"eu-test-1\",\"bucket\":\"dlm-backups-test\",\"lockDays\":35,\"expireDays\":30,$KEYS}" > "$W/sim2.json"
node scripts/backup/sim/s3-simulator.mjs "$W/sim.json" > "$W/sim.log" 2>&1 & PIDS+=($!)
node scripts/backup/sim/s3-simulator.mjs "$W/sim2.json" > "$W/sim2.log" 2>&1 & PIDS+=($!)
node scripts/tests/prod-recording-proxy.mjs 54410 http://127.0.0.1:54321 "$W/prod-requests.jsonl" > "$W/proxy.log" 2>&1 & PIDS+=($!)
ALLOW_ENV=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SB_REGION,DLM_PROD_URL,DLM_PROD_ANON_KEY,DLM_PROD_BACKUP_TOKEN,DLM_BACKUP_AGE_RECIPIENTS,DLM_BACKUP_S3_ENDPOINT,DLM_BACKUP_S3_REGION,DLM_BACKUP_S3_BUCKET,DLM_BACKUP_S3_WRITE_KEY_ID,DLM_BACKUP_S3_WRITE_SECRET,DLM_BACKUP_S3_READ_KEY_ID,DLM_BACKUP_S3_READ_SECRET,DLM_TEST_PORT,DLM_TEST_TRIGGER,DLM_TEST_MODE
# The runner environment mirrors a hosted runner project: ITS OWN url, service key and
# database URL (injected by Supabase), production's PUBLIC anon key and the token.
# Network allow-list: runner API, the production proxy, the simulator. NOT production directly.
start_fn() { # $1 port, $2 token, $3 log
  env -i PATH="$PATH" HOME="$HOME" DENO_DIR="${DENO_DIR:-$HOME/.cache/deno}" DENO_CERT="${DENO_CERT:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" NO_PROXY="127.0.0.1,localhost,0.0.0.0" \
    SUPABASE_URL=http://127.0.0.1:54331 SUPABASE_SERVICE_ROLE_KEY="$RSRK" SUPABASE_DB_URL="$RDB" \
    DLM_PROD_URL=http://127.0.0.1:54410 DLM_PROD_ANON_KEY="$ANON" DLM_PROD_BACKUP_TOKEN="$2" \
    DLM_BACKUP_AGE_RECIPIENTS="$PUB" DLM_BACKUP_S3_ENDPOINT=http://127.0.0.1:54400 DLM_BACKUP_S3_REGION=eu-test-1 DLM_BACKUP_S3_BUCKET=dlm-backups-test \
    DLM_BACKUP_S3_WRITE_KEY_ID=FNWRITE DLM_BACKUP_S3_WRITE_SECRET=fn-write-secret-local-test \
    DLM_BACKUP_S3_READ_KEY_ID=FNREAD DLM_BACKUP_S3_READ_SECRET=fn-read-secret-local-test DLM_TEST_PORT="$1" \
    "$DENO" run --no-prompt --frozen --lock="$FNDIR/deno.lock" --config "$FNDIR/deno.json" \
      --allow-env="$ALLOW_ENV" --allow-net="127.0.0.1:54331,127.0.0.1:54410,127.0.0.1:54400,0.0.0.0:$1" \
      scripts/tests/dlm-backup-serve.ts > "$3" 2>&1 &
  PIDS+=($!)
}
start_fn 54401 "$TOKEN" "$W/fn.log"
for i in $(seq 1 120); do grep -q "test server on" "$W/fn.log" 2>/dev/null && break; sleep 1; done
grep -q "test server on" "$W/fn.log" || { echo "function did not start"; cat "$W/fn.log"; exit 1; }

rc=0
if [ "${PERF_ONLY:-0}" != 1 ]; then
echo "== test"
WORK_DIR="$W" SRK="$SRK" ANON="$ANON" RSRK="$RSRK" RANON="$RANON" PUB="$PUB" TOKEN="$TOKEN" RUNNER_GW="$RGW" \
  PIN_FILE="$W/pin.txt" DENO="$DENO" ALLOW_ENV="$ALLOW_ENV" FNDIR="$FNDIR" \
  node scripts/tests/automated-backup-local-test.mjs
rc=$?
if [ $rc -eq 0 ]; then
  echo "== offline browser tool (headless Chromium, network blocked)"
  WORK_DIR="$W" node scripts/tests/backup-tool-browser-test.mjs || rc=1
fi
fi
if [ $rc -eq 0 ] && [ "${PERF_ONLY:-0}" != 1 ]; then
  echo "== the same function inside the real Supabase Edge Runtime, hosted limits enforced"
  EDGE_IMAGE=${EDGE_RUNTIME_IMAGE:-supabase/edge-runtime:v1.77.9}
  docker rm -f dlm-edge-test >/dev/null 2>&1
  docker run -d --name dlm-edge-test --network host \
    -e HTTPS_PROXY="${HTTPS_PROXY:-}" -e NO_PROXY="127.0.0.1,localhost" -e DENO_CERT=/ca.crt -e SSL_CERT_FILE=/ca.crt \
    -v "${DENO_CERT:-/etc/ssl/certs/ca-certificates.crt}:/ca.crt:ro" \
    -v "$(pwd)/$FNDIR:/fn:ro" -v "$(pwd)/scripts/tests/edge-runtime-main:/main:ro" \
    -e SUPABASE_URL=http://127.0.0.1:54331 -e SUPABASE_SERVICE_ROLE_KEY="$RSRK" -e SUPABASE_DB_URL="$RDB" \
    -e DLM_PROD_URL=http://127.0.0.1:54410 -e DLM_PROD_ANON_KEY="$ANON" -e DLM_PROD_BACKUP_TOKEN="$TOKEN" \
    -e DLM_BACKUP_AGE_RECIPIENTS="$PUB" -e DLM_BACKUP_S3_ENDPOINT=http://127.0.0.1:54400 -e DLM_BACKUP_S3_REGION=eu-test-1 -e DLM_BACKUP_S3_BUCKET=dlm-backups-test \
    -e DLM_BACKUP_S3_WRITE_KEY_ID=FNWRITE -e DLM_BACKUP_S3_WRITE_SECRET=fn-write-secret-local-test \
    -e DLM_BACKUP_S3_READ_KEY_ID=FNREAD -e DLM_BACKUP_S3_READ_SECRET=fn-read-secret-local-test \
    "$EDGE_IMAGE" start --main-service /main --port 54405 --policy per_request > "$W/edge-start.log" 2>&1 || { echo "edge runtime failed to start"; cat "$W/edge-start.log"; rc=1; }
  for i in $(seq 1 60); do curl -s -o /dev/null -X POST http://127.0.0.1:54405/ -d '{}' && break; sleep 1; done
  WORK_DIR="$W" SRK="$SRK" node scripts/tests/backup-runner-edge-runtime-local.mjs || rc=1
fi
if [ $rc -eq 0 ]; then
  echo "== performance against the hosted Edge Function limits (CPU, memory, wall clock)"
  WORK_DIR="$W" SRK="$SRK" TOKEN="$TOKEN" node scripts/tests/backup-runner-perf-local.mjs || rc=1
fi
exit $rc
