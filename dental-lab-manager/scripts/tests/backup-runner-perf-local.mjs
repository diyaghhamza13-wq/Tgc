#!/usr/bin/env node
/**
 * LOCAL performance check of the runner function against Supabase's hosted Edge
 * Function limits (documented 2026-11: 2 s CPU time per request, 256 MB memory,
 * 150 s wall clock on the free plan). Runs after automated-backup-local-test.mjs in
 * the same environment (started by automated-backup-local-test.sh).
 *
 * Load: ~15 MB of application tables (production today: ~16 MB for the WHOLE
 * database including system catalogs) plus 4 × 8 MB files and one 100 MB file.
 * Every request (step) is measured: CPU time of the whole Deno process (all threads,
 * an upper bound), and peak V8 heap + external buffers sampled inside the process.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const E = process.env;
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RDB = 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';
const API = 'http://127.0.0.1:54321';
const sql = (db, s) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', s]).toString().trim();
const svcH = { apikey: E.SRK, Authorization: `Bearer ${E.SRK}` };
const CPU_LIMIT_MS = 2000; const MEM_LIMIT_MB = 256;
let failed = 0; let passed = 0;
const check = (n, ok, d) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`); };

const pid = execFileSync('bash', ['-c', "for p in $(pgrep -f dlm-backup-serve.ts); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q '^DLM_TEST_PORT=54401$' && echo $p; done; true"]).toString().trim().split('\n')[0];
const tck = Number(execFileSync('getconf', ['CLK_TCK']).toString());
const cpuMs = () => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return ((Number(f[11]) + Number(f[12])) * 1000) / tck; };
const memLines = () => fs.readFileSync(`${E.WORK_DIR}/fn.log`, 'utf8').match(/test-serve: memory .*/g) ?? [];
const trigger = () => sql(RDB, "select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger'");
const step = async (mode) => {
  const c0 = cpuMs(); const t0 = Date.now(); const m0 = memLines().length;
  const r = await fetch('http://127.0.0.1:54401/', { method: 'POST', headers: { 'x-dlm-backup-trigger': trigger(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  const body = await r.json().catch(() => ({}));
  const ml = memLines().slice(m0);
  const mem = ml.length ? Number(/peakHeapPlusExternalMB=(\d+)/.exec(ml[ml.length - 1])[1]) : 0;
  return { idle: !!body.idle, cpuMs: Math.round(cpuMs() - c0), wallMs: Date.now() - t0, memMb: mem };
};
const runAll = async () => {
  const steps = [await step('backup')];
  for (let i = 0; i < 80; i++) { const s = await step('continue'); if (s.idle) break; steps.push(s); }
  const st = JSON.parse(sql(RDB, "select row_to_json(r) from (select status, error, steps, manifest->'files_uploaded_this_run' as files from dlm_runner.runs where mode='backup' order by started_at desc limit 1) r"));
  return { ...st, n: steps.length, maxCpuMs: Math.max(...steps.map((s) => s.cpuMs)), maxMemMb: Math.max(...steps.map((s) => s.memMb)), maxWallMs: Math.max(...steps.map((s) => s.wallMs)) };
};

console.log('perf. production-sized data and large files against the hosted Edge Function limits (per step)');
// the e2e test revoked every token at its end: re-activate token A (local database only)
sql(DB, "update dlm_backup.runner_tokens set revoked_at = null, expires_at = now() + interval '1 day' where label = 'local test A'");
const lab = sql(DB, 'select id from public.laboratories limit 1');
const load = (n) => {
  sql(DB, 'alter table public.audit_logs disable trigger user');
  sql(DB, `insert into public.audit_logs(lab_id,table_name,record_id,action,old_data,new_data) select '${lab}','cases',g::text,'UPDATE',jsonb_build_object('note',repeat('x',200),'n',g),jsonb_build_object('note',repeat('y',200),'n',g) from generate_series(1,${n}) g`);
  sql(DB, 'alter table public.audit_logs enable trigger user');
};
load(22000);
const appMb = () => sql(DB, "select round(sum(pg_total_relation_size(c.oid))/1048576.0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'");
const upload = async (mb) => {
  const r = await fetch(`${API}/storage/v1/object/case-files/${lab}/perf/${crypto.randomUUID()}.stl`, { method: 'POST', headers: { ...svcH, 'Content-Type': 'model/stl' }, body: crypto.randomBytes(mb * 1048576) });
  if (!r.ok) throw new Error(`perf upload ${r.status}`);
};
for (let i = 0; i < 4; i++) await upload(8);
const a = await runAll();
check(`full run: ${appMb()} MB app tables + 4 × 8 MB new files → ${a.n} steps, succeeded`, a.status === 'succeeded', a);
check(`…every step ≤ ${CPU_LIMIT_MS} ms CPU (max ${a.maxCpuMs} ms)`, a.maxCpuMs <= CPU_LIMIT_MS, a.maxCpuMs);
check(`…every step ≤ ${MEM_LIMIT_MB} MB heap + buffers (max ${a.maxMemMb} MB)`, a.maxMemMb > 0 && a.maxMemMb <= MEM_LIMIT_MB, a.maxMemMb);
await upload(100);
const b = await runAll();
check(`a 100 MB file: ${b.n} steps, succeeded; max ${b.maxCpuMs} ms CPU and ${b.maxMemMb} MB per step`, b.status === 'succeeded' && b.maxCpuMs <= CPU_LIMIT_MS && b.maxMemMb <= MEM_LIMIT_MB, b);
const d = await runAll();
check(`daily run (snapshot only): 1 step, ${d.maxCpuMs} ms CPU, ${d.maxMemMb} MB`, d.status === 'succeeded' && d.n === 1 && d.maxCpuMs <= CPU_LIMIT_MS && d.maxMemMb <= MEM_LIMIT_MB, d);
check(`wall clock per step ≤ 150 s (max ${Math.max(a.maxWallMs, b.maxWallMs, d.maxWallMs)} ms)`, Math.max(a.maxWallMs, b.maxWallMs, d.maxWallMs) < 150000);
load(30000);
const g = await runAll();
check(`snapshot above the 20 MB guard (${appMb()} MB app tables): run fails cleanly (snapshot_too_large), memory bounded (${g.maxMemMb} MB)`, g.status === 'failed' && g.error === 'snapshot_too_large' && g.maxMemMb <= MEM_LIMIT_MB, g);
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
