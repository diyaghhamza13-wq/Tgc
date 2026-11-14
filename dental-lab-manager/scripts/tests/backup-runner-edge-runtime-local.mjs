#!/usr/bin/env node
/**
 * LOCAL test: the runner function inside the REAL Supabase Edge Runtime (docker image
 * supabase/edge-runtime, started by automated-backup-local-test.sh on 127.0.0.1:54405)
 * as a user worker with the hosted limits (256 MB, 2 s CPU, 150 s wall clock, one worker
 * per request). Checks: the npm dependencies resolve from deno.lock in the runtime,
 * EdgeRuntime.waitUntil background work completes, a run with a 40 MB file completes in
 * several steps without hitting any limit, the weekly check runs, and the copy is exact.
 */
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const E = process.env;
const W = E.WORK_DIR;
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RDB = 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';
const API = 'http://127.0.0.1:54321';
const SIM = 'http://127.0.0.1:54400';
const EDGE = 'http://127.0.0.1:54405/';
const sql = (db, s) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', s]).toString().trim();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svcH = { apikey: E.SRK, Authorization: `Bearer ${E.SRK}` };
let failed = 0; let passed = 0;
const check = (n, ok, d) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 500) : ''}`); };
const trigger = () => sql(RDB, "select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger'");
const call = async (mode) => { const r = await fetch(EDGE, { method: 'POST', headers: { 'x-dlm-backup-trigger': trigger(), 'Content-Type': 'application/json', 'x-region': 'eu-west-2' }, body: JSON.stringify({ mode }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const run = () => JSON.parse(sql(RDB, "select row_to_json(r) from (select id, mode, status, steps, error, run_prefix, manifest from dlm_runner.runs where mode in ('backup','verify') order by started_at desc limit 1) r"));
const ageDecrypt = (buf) => { const r = spawnSync('age', ['-d', '-i', path.join(W, 'k.txt')], { input: buf, maxBuffer: 1 << 30 }); if (r.status) throw new Error('decrypt failed'); return r.stdout; };
const simRaw = async (key) => Buffer.from(await (await fetch(`${SIM}/__sim/raw?key=${encodeURIComponent(key)}`)).arrayBuffer());

/** start, then keep calling "continue" (as the 3-minute schedule would) until the run ends */
async function drive(mode, deadlineMs = 240000) {
  const first = await call(mode);
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    const r = run();
    if (r.status !== 'running') return { first, run: r };
    if (Date.now() - t0 > deadlineMs) return { first, run: r, timeout: true };
    await call('continue');   // 409 while the previous step still holds its lease
  }
}

console.log('edge. the runner function in the real Supabase Edge Runtime with the hosted limits');
sql(DB, "update dlm_backup.runner_tokens set revoked_at = null, expires_at = now() + interval '1 day' where label = 'local test A'");
// fresh runner bookkeeping: the e2e retention test moved the simulated clock 36 days ahead, so
// lifecycle removed the earlier copies; this run copies everything again inside the runtime.
sql(RDB, 'truncate dlm_runner.runs, dlm_runner.files cascade');
const lab = sql(DB, 'select id from public.laboratories limit 1');
const big = crypto.randomBytes(40 * 1048576);
const p = `${lab}/edge/${crypto.randomUUID()}.stl`;
const up = await fetch(`${API}/storage/v1/object/case-files/${p}`, { method: 'POST', headers: { ...svcH, 'Content-Type': 'model/stl' }, body: big });
if (!up.ok) throw new Error(`upload ${up.status}`);

const b = await drive('backup');
check('the runtime accepts the request and continues in the background (EdgeRuntime.waitUntil → 202)', b.first.status === 202, b.first);
check(`backup run completes inside the runtime (${b.run.steps} steps, none killed by a limit)`, b.run.status === 'succeeded' && b.run.steps >= 2 && !b.timeout, b.run);
const objs = new Map(JSON.parse(ageDecrypt(await simRaw(`${b.run.run_prefix}/objects.json.age`))).objects.map((o) => [o.id, o]));
const files = JSON.parse(ageDecrypt(await simRaw(`${b.run.run_prefix}/files.json.age`))).files;
const f = files.find((x) => objs.get(x.id)?.name === p);
const assembled = f ? Buffer.concat(await Promise.all(f.segments.map(async (s) => ageDecrypt(await simRaw(s.backup_key))))) : Buffer.alloc(0);
check('the 40 MB file is stored as 3 segments that reassemble byte-identically', f?.segments.length === 3 && sha(assembled) === sha(big), f?.segments.length);
const v = await drive('verify');
check(`weekly check completes inside the runtime (${v.run.steps} steps)`, v.run.mode === 'verify' && v.run.status === 'succeeded' && !v.timeout, v.run);
const stFirst = await call('selftest');
let st = null;
for (let i = 0; i < 40; i++) { await sleep(1000); st = JSON.parse(sql(RDB, "select row_to_json(r) from (select status, error, manifest->'selftest' as checks from dlm_runner.runs where mode = 'selftest' order by started_at desc limit 1) r") || 'null'); if (st && st.status !== 'running') break; }
check('activation self-test passes inside the runtime (all 11 checks)', stFirst.status === 202 && st?.status === 'succeeded' && Object.keys(st.checks ?? {}).length === 11, st);
const logs = execFileSync('docker', ['logs', 'dlm-edge-test'], { stdio: ['ignore', 'pipe', 'pipe'] });
const all = logs.toString();
fs.writeFileSync(path.join(W, 'edge.log'), all);
check('no worker hit a CPU, memory or wall-clock limit (runtime log)', !/(CPU time (soft |hard )?limit|memory limit|MemoryLimit|CpuTimeLimit|WallClockTime|early.?drop|worker_error)/i.test(all), all.match(/.*(limit|early|error).*/gi)?.slice(0, 5));
check('the runtime log holds no names, paths or row data', !all.includes(p) && !all.includes(lab));
await fetch(`${API}/storage/v1/object/case-files`, { method: 'DELETE', headers: { ...svcH, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [p] }) });
console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
