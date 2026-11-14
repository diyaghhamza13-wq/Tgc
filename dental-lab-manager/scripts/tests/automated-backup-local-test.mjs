#!/usr/bin/env node
/**
 * LOCAL-ONLY end-to-end + security test of the automated backup
 * (supabase/functions/dlm-backup + supabase/migrations-pending/*automated_backup*).
 * Started by scripts/tests/automated-backup-local-test.sh, which provides a fresh
 * local stack, the pending migration, the S3 simulator(s) and the function
 * (served by Deno with an environment/network allow-list).
 */
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAgainstManifest } from '../backup/restore-core.mjs';

const E = process.env;
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const API = 'http://127.0.0.1:54321';
const FN = 'http://127.0.0.1:54401/';
const SIM = 'http://127.0.0.1:54400';
const SIM2 = 'http://127.0.0.1:54402';
const W = E.WORK_DIR;
const SRK = E.SRK;
const ANON = E.ANON;
const MARKERS = ['Zineb Marker-Patient', 'Marker-LegacyName', 'FileMarker-STL', 'FileMarker-PLY', 'FileMarker-OBJ', 'FileMarker-3MF', 'FileMarker-DCM', 'FileMarker-LOGO', 'Demo Dental Lab'];
if (!/127\.0\.0\.1/.test(DB) || !W || !SRK) { console.error('local only; WORK_DIR, SRK required'); process.exit(2); }

let failed = 0; let passed = 0;
const check = (n, ok, d) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`); };
const sql = (q) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q]).toString().trim();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trigger = () => sql("select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger'");
const runFn = (secret, mode = 'backup') => fetch(FN, { method: 'POST', headers: { 'x-dlm-backup-trigger': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
const simState = async (base = SIM) => (await (await fetch(`${base}/__sim/state`)).json());
const simRaw = async (key) => Buffer.from(await (await fetch(`${SIM}/__sim/raw?key=${encodeURIComponent(key)}`)).arrayBuffer());
const ageDecrypt = (buf) => { const r = spawnSync('age', ['-d', '-i', path.join(W, 'k.txt')], { input: buf, maxBuffer: 1 << 30 }); if (r.status) throw new Error('decrypt failed'); return r.stdout; };
const svcH = { apikey: SRK, Authorization: `Bearer ${SRK}` };
const lastRun = () => JSON.parse(sql("select row_to_json(r) from (select mode, status, run_prefix, files_uploaded, files_total, error, manifest from dlm_backup.runs where mode in ('backup','verify') order by started_at desc limit 1) r") || 'null');

/** Independent SigV4 signer (third implementation) for direct-key tests. */
function signed(base, method, key, body, keyId, secret, extra = {}, query = '') {
  const u = new URL(`${base}/dlm-backups-test${key ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''}${query}`);
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); const date = amz.slice(0, 8);
  const payload = body ? sha(body) : sha('');
  const headers = { host: u.host, 'x-amz-content-sha256': extra['x-amz-content-sha256'] ?? payload, 'x-amz-date': amz, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'x-amz-content-sha256')) };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const q = [...u.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const canon = [method, u.pathname, q, names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n');
  const scope = `${date}/eu-test-1/s3/aws4_request`;
  const hm = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const kk = hm(hm(hm(hm('AWS4' + secret, date), 'eu-test-1'), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kk).update(['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n')).digest('hex');
  return fetch(u, { method, body, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` } });
}
const W_KEY = ['FNWRITE', 'fn-write-secret-local-test'];
const R_KEY = ['FNREAD', 'fn-read-secret-local-test'];
const A_KEY = ['ADMIN', 'admin-secret-local-test'];

// ---------------------------------------------------------------------------
console.log('0. fixture: production files (STL, PLY, OBJ, 3MF, DCM), a legacy photo, a lab logo, a legacy patient');
const lab = sql("select id from public.laboratories where code = 'LOCALBK'");
const kase = sql(`select id from public.cases where lab_id = '${lab}' order by case_number limit 1`);
const admin = sql(`select id from public.employees where lab_id = '${lab}' and code = 'ADMIN01'`);
sql(`insert into public.patients (lab_id, full_name) values ('${lab}', 'Zineb Marker-Patient')`);
const files = [
  ['stl', 'model/stl', Buffer.from('solid FileMarker-STL\nendsolid\n')],
  ['ply', 'application/octet-stream', Buffer.from('ply\nformat ascii 1.0\ncomment FileMarker-PLY\nend_header\n')],
  ['obj', 'model/obj', Buffer.from('# FileMarker-OBJ\nv 0 0 0\n')],
  ['3mf', 'model/3mf', Buffer.concat([Buffer.from('PK\u0003\u0004FileMarker-3MF'), crypto.randomBytes(2048)])],
  ['dcm', 'application/octet-stream', Buffer.concat([Buffer.from('3Shape FileMarker-DCM '), crypto.randomBytes(4096)])],
];
const originals = {};
for (const [ext, mime, body] of files) {
  const p = `${lab}/${kase}/${crypto.randomUUID()}.${ext}`;
  const r = await fetch(`${API}/storage/v1/object/case-files/${p}`, { method: 'POST', headers: { ...svcH, 'Content-Type': mime }, body });
  if (!r.ok) throw new Error(`fixture upload ${r.status}`);
  sql(`insert into public.attachments (lab_id, case_id, category, file_name, mime_type, size_bytes, storage_path, uploaded_by)
       values ('${lab}', '${kase}', 'scan', 'scan_upper.${ext}', '${mime}', ${body.length}, '${p}', '${admin}')`);
  originals[`case-files/${p}`] = sha(body);
}
const legacyPath = `${lab}/${kase}/${crypto.randomUUID()}-Marker-LegacyName_smile.jpg`;
const legacyBody = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('FileMarker-LEGACYJPG'), crypto.randomBytes(512)]);
await fetch(`${API}/storage/v1/object/case-files/${legacyPath}`, { method: 'POST', headers: { ...svcH, 'Content-Type': 'image/jpeg' }, body: legacyBody });
originals[`case-files/${legacyPath}`] = sha(legacyBody);
const logoPath = `${lab}/logo/${Date.now()}.png`;
const logoBody = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('FileMarker-LOGO'), crypto.randomBytes(256)]);
await fetch(`${API}/storage/v1/object/lab-assets/${logoPath}`, { method: 'POST', headers: { ...svcH, 'Content-Type': 'image/png' }, body: logoBody });
originals[`lab-assets/${logoPath}`] = sha(logoBody);
const storedCount = Number(sql('select count(*) from storage.objects'));
check(`fixture: ${storedCount} stored files (5 production formats, legacy photo, logo)`, storedCount === 7, storedCount);

// ---------------------------------------------------------------------------
console.log('1. trigger protection');
let r = await runFn('wrong-secret');
check('wrong trigger secret → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'POST', body: '{}' });
check('missing trigger header → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'GET' });
check('GET → 405', r.status === 405, r.status);
check('no run recorded and nothing uploaded by refused triggers', Number(sql('select count(*) from dlm_backup.runs')) === 0 && Object.keys((await simState()).objects).length === 0);

console.log('2. first backup');
r = await runFn(trigger());
const body1 = await r.json();
check('backup run accepted', r.ok && /^[0-9a-f-]{36}$/.test(body1.run ?? ''), body1);
let run = lastRun();
check('run succeeded', run?.status === 'succeeded', run);
const prefix1 = run.run_prefix;
const st = await simState();
const keys = Object.keys(st.objects);
const fileKeys = keys.filter((k) => k.startsWith('files/'));
check(`every stored file copied (${storedCount}) + snapshot + file map + manifest`, fileKeys.length === storedCount && keys.includes(`${prefix1}/db.json.age`) && keys.includes(`${prefix1}/files.json.age`) && keys.includes(`${prefix1}/manifest.json`), keys);
check('object keys contain no names (only stamps, ids and hashes)', keys.every((k) => /^(runs\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\/(db\.json\.age|files\.json\.age|manifest\.json)|files\/[0-9a-f-]{36}\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.age)$/.test(k)), keys);
let leak = [];
for (const k of keys) { const raw = (await simRaw(k)).toString('latin1'); for (const m of MARKERS.concat(['FileMarker-LEGACYJPG', 'smile'])) if (raw.includes(m)) leak.push(`${k}:${m}`); }
check('no plaintext marker (patient, lab, file names, file contents) in any stored object', leak.length === 0, leak);
check('every object except the manifest is age-encrypted', keys.filter((k) => !k.endsWith('manifest.json')).length === keys.length - 1 && (await Promise.all(keys.filter((k) => !k.endsWith('manifest.json')).map(async (k) => (await simRaw(k)).subarray(0, 21).toString() === 'age-encryption.org/v1'))).every(Boolean));
const manifest1 = JSON.parse(await simRaw(`${prefix1}/manifest.json`));
check('manifest: counts and hashes only', manifest1.format === 'dlm-backup-manifest-v1' && manifest1.storage_objects === storedCount && Object.keys(manifest1.tables).length === 29);
const snap = JSON.parse(ageDecrypt(await simRaw(`${prefix1}/db.json.age`)));
const vr = await verifyAgainstManifest(snap, manifest1, async (b) => sha(b));
check('snapshot decrypts with the private key and matches the manifest (29 tables)', vr.ok && vr.tables === 29, vr);
check('snapshot contains the legacy patient (complete backup, RLS bypassed)', JSON.stringify(snap.data.patients).includes('Zineb Marker-Patient'));
const fmap = JSON.parse(ageDecrypt(await simRaw(`${prefix1}/files.json.age`))).files;
let fileOk = 0;
for (const f of fmap) { const plain = ageDecrypt(await simRaw(f.backup_key)); if (sha(plain) === f.sha256 && originals[`${f.bucket}/${f.name}`] === f.sha256) fileOk++; }
check('every stored file decrypts to its exact original bytes (STL, PLY, OBJ, 3MF, DCM, photo, logo)', fileOk === storedCount, { fileOk, storedCount });
const fnLog = fs.readFileSync(path.join(W, 'fn.log'), 'utf8');
check('function log contains no names, file paths or row data', MARKERS.concat(['smile', lab, kase]).every((m) => !fnLog.includes(m)));

console.log('3. incremental copies, re-upload before expiry, changed files');
await runFn(trigger()); run = lastRun();
check('second run: snapshot only, no file re-uploaded', run.status === 'succeeded' && run.manifest.files_uploaded_this_run === 0, run.manifest?.files_uploaded_this_run);
sql(`update dlm_backup.files set uploaded_at = now() - interval '29 days' where object_id = (select id from storage.objects where name = '${logoPath}')`);
await runFn(trigger()); run = lastRun();
check('a file copied 29 days ago is copied again (stays inside the 35-day window)', run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
await fetch(`${API}/storage/v1/object/lab-assets/${logoPath}`, { method: 'PUT', headers: { ...svcH, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: Buffer.concat([logoBody, Buffer.from('v2')]) });
await runFn(trigger()); run = lastRun();
check('a changed file is copied again', run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
await fetch(`${API}/storage/v1/object/lab-assets/${logoPath}`, { method: 'PUT', headers: { ...svcH, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: logoBody });
await runFn(trigger());

console.log('4. a compromised backup function (its write-only key) cannot read, list, delete or overwrite');
const victim = `${prefix1}/db.json.age`;
const victimVersion = (await simState()).objects[victim][0];
for (const [label, req] of [
  ['GET an existing backup', () => signed(SIM, 'GET', victim, null, ...W_KEY)],
  ['HEAD an existing backup', () => signed(SIM, 'HEAD', victim, null, ...W_KEY)],
  ['LIST the bucket', () => signed(SIM, 'GET', '', null, ...W_KEY, {}, '?list-type=2')],
  ['DELETE a backup', () => signed(SIM, 'DELETE', victim, null, ...W_KEY)],
  ['DELETE a specific version', () => signed(SIM, 'DELETE', victim, null, ...W_KEY, {}, `?versionId=${victimVersion.versionId}`)],
  ['change lifecycle / lock configuration', () => signed(SIM, 'PUT', '', Buffer.from('<LifecycleConfiguration/>'), ...W_KEY, {}, '?lifecycle')],
]) { const x = await req(); check(`write-only key: ${label} → 403`, x.status === 403, x.status); }
let x = await signed(SIM, 'PUT', victim, Buffer.from('evil'), ...W_KEY, { 'if-none-match': '*' });
check('write-only key: overwrite with If-None-Match → 412', x.status === 412, x.status);
x = await signed(SIM, 'PUT', victim, Buffer.from('evil'), ...W_KEY);
const vers = (await simState()).objects[victim];
check('overwrite without If-None-Match only adds a new version; the original version is kept unchanged', x.status === 200 && vers.length === 2 && vers[0].sha256 === victimVersion.sha256, vers);
x = await signed(SIM, 'DELETE', victim, null, ...A_KEY, {}, `?versionId=${victimVersion.versionId}`);
check('even the ADMIN key cannot delete the locked original version (compliance lock)', x.status === 403, x.status);
x = await signed(SIM, 'PUT', 'runs/tamper.bin', Buffer.from('data'), ...W_KEY, { 'x-amz-content-sha256': sha('other') });
check('upload whose body does not match its signed hash → 400 (integrity enforced by the store)', x.status === 400, x.status);
x = await signed(SIM, 'GET', victim, null, ...R_KEY, {}, `?versionId=${victimVersion.versionId}`);
check('the original version is still readable and intact', x.status === 200 && sha(Buffer.from(await x.arrayBuffer())) === victimVersion.sha256);
x = await signed(SIM, 'DELETE', victim, null, ...R_KEY);
check('read key cannot delete either', x.status === 403, x.status);

console.log('5. weekly integrity check (read key: can read ciphertext, cannot decrypt)');
r = await runFn(trigger(), 'verify'); run = lastRun();
check('verify run succeeded over recent snapshots and all files (reads the pinned versions)', run.mode === 'verify' && run.status === 'succeeded' && run.files_total > storedCount, run);
check('…so the extra version written in step 4 cannot replace the pinned backup', manifest1.db.version_id && (await simState()).objects[victim].length === 2);
const someFile = fmap[0].backup_key;
await fetch(`${SIM}/__sim/corrupt`, { method: 'POST', body: JSON.stringify({ key: someFile }) });
r = await runFn(trigger(), 'verify'); run = lastRun();
check('a corrupted object is detected (verify run failed, no names in the error)', run.status === 'failed' && /^integrity_failed 1 of \d+$/.test(run.error ?? ''), run.error);
await runFn(trigger()); run = lastRun();
check('self-healing: the next backup copies the damaged file again', run.status === 'succeeded' && run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
r = await runFn(trigger(), 'verify'); run = lastRun();
check('verify after self-healing succeeds', run.status === 'succeeded', run.error);

console.log('6. health check (missed backups)');
sql("update dlm_backup.runs set finished_at = now() - interval '27 hours', started_at = now() - interval '27 hours' where mode = 'backup'");
sql('select public.dlm_backup_health()');
check('no success in 26 h → one alert row', Number(sql("select count(*) from dlm_backup.runs where mode = 'health' and status = 'alert'")) === 1);
sql('select public.dlm_backup_health()');
check('repeated health check → still one alert (no flood)', Number(sql("select count(*) from dlm_backup.runs where mode = 'health'")) === 1);

console.log('7. access rules of the backup RPCs and tables');
for (const fnName of ['dlm_backup_snapshot', 'dlm_backup_begin', 'dlm_backup_files_todo', 'dlm_backup_file_map', 'dlm_backup_recent', 'dlm_backup_health']) {
  const a = await fetch(`${API}/rest/v1/rpc/${fnName}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: '{}' });
  check(`anon cannot call ${fnName}`, a.status === 401 || a.status === 403 || a.status === 404, a.status);
}
const emp = await (await fetch('http://127.0.0.1:54399/employee-login', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ lab_code: 'LOCALBK', employee_code: 'ADMIN01', pin: fs.readFileSync(E.PIN_FILE, 'utf8').trim() }) })).json();
const userJwt = emp.session.access_token;
for (const fnName of ['dlm_backup_snapshot', 'dlm_backup_file_map', 'dlm_backup_recent']) {
  const a = await fetch(`${API}/rest/v1/rpc/${fnName}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' }, body: '{}' });
  check(`a logged-in lab administrator cannot call ${fnName}`, a.status === 401 || a.status === 403, a.status);
}
const t = await fetch(`${API}/rest/v1/runs`, { headers: { ...svcH, 'Accept-Profile': 'dlm_backup' } });
check('the dlm_backup schema is not exposed by the REST API (even with the service key)', t.status >= 400, t.status);
check('snapshot function runs as dlm_backup_reader (owner, SECURITY DEFINER), role cannot log in', sql("select pg_get_userbyid(proowner) || prosecdef::text from pg_proc where proname = 'dlm_backup_snapshot'") === 'dlm_backup_readertrue' && sql("select rolcanlogin::text from pg_roles where rolname = 'dlm_backup_reader'") === 'false');
check('nobody can SET ROLE to dlm_backup_reader after the migration (postgres: no SET)', sql("select pg_has_role('postgres', 'dlm_backup_reader', 'SET')::text") === 'false');
check('the backup role cannot read auth or vault', sql("select (has_schema_privilege('dlm_backup_reader', 'auth', 'USAGE') or has_schema_privilege('dlm_backup_reader', 'vault', 'USAGE'))::text") === 'false');

console.log('8. the function never receives the postgres password');
const src = fs.readFileSync('supabase/functions/dlm-backup/index.ts', 'utf8');
check('source code does not read SUPABASE_DB_URL', !/env\(["']SUPABASE_DB_URL/.test(src) && !/Deno\.env\.get\(["']SUPABASE_DB_URL/.test(src));
check('it ran under a Deno allow-list without SUPABASE_DB_URL (and still succeeded)', !(E.DENO_ALLOW_ENV ?? '').includes('SUPABASE_DB_URL') && passed > 0);
r = await fetch('http://127.0.0.1:54403/', { method: 'POST', headers: { 'x-dlm-backup-trigger': 'x' }, body: '{}' });
check('a function configured with a non-HTTPS remote storage endpoint refuses to run (not_configured)', r.status === 500 && (await r.json()).error === 'not_configured', r.status);

console.log('9. full restoration from the off-site copies');
await runFn(trigger()); run = lastRun();
const prefixR = run.run_prefix;
const before = JSON.parse(await (await fetch(`${API}/rest/v1/rpc/dlm_backup_snapshot`, { headers: svcH })).text());
const beforeSums = Object.fromEntries(before.tables_in_snapshot.map((tb) => [tb, sha(JSON.stringify(before.data[tb]))]));
const OUT = path.join(W, 'restore'); fs.rmSync(OUT, { recursive: true, force: true });
const renv = { ...process.env, S3_ENDPOINT: SIM, S3_REGION: 'eu-test-1', S3_BUCKET: 'dlm-backups-test', S3_READ_KEY_ID: R_KEY[0], S3_READ_SECRET: R_KEY[1], AGE_IDENTITY: path.join(W, 'k.txt'), OUT_DIR: OUT, SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SRK };
const fetchOut = execFileSync('node', ['scripts/backup/offsite-restore.mjs', 'fetch', prefixR, '--write-plain'], { env: renv }).toString();
check('offsite fetch: hashes, decryption and all tables verified', /^OK: 29 tables/.test(fetchOut), fetchOut);
// damage: database rows and stored files
sql(`delete from public.cases where lab_id = '${lab}'`); sql('delete from public.patients'); sql("update public.laboratories set name = 'DAMAGED'");
for (const k of Object.keys(originals)) { const [bucket, ...rest] = k.split('/'); await fetch(`${API}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { ...svcH, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [rest.join('/')] }) }); }
check('damage applied (rows and files gone)', Number(sql('select count(*) from storage.objects')) === 0 && Number(sql('select count(*) from public.patients')) === 0);
const restoreSql = execFileSync('node', ['scripts/backup/restore.mjs', path.join(OUT, 'backup.json'), path.join(OUT, 'manifest.json')]).toString();
// hand a real encrypted run to the browser-tool test (ciphertext + expected hashes only)
const TF = path.join(W, 'tool-fixture'); fs.mkdirSync(TF, { recursive: true });
for (const f of ['manifest.json', 'db.json.age', 'files.json.age']) fs.copyFileSync(path.join(OUT, f), path.join(TF, f));
fs.writeFileSync(path.join(TF, 'expected.json'), JSON.stringify({ restoreSqlSha256: sha(restoreSql), filemapSha256: sha(ageDecrypt(fs.readFileSync(path.join(OUT, 'files.json.age')))) }));
fs.writeFileSync(path.join(OUT, 'restore.sql'), restoreSql, { mode: 0o600 });
execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', path.join(OUT, 'restore.sql')], { stdio: ['ignore', 'ignore', 'pipe'] });
const filesOut = execFileSync('node', ['scripts/backup/offsite-restore.mjs', 'restore-files', prefixR], { env: renv }).toString();
check('restore-files: every stored file restored with both hashes verified', filesOut.startsWith(`OK: ${storedCount}/${storedCount}`), filesOut);
const after = JSON.parse(await (await fetch(`${API}/rest/v1/rpc/dlm_backup_snapshot`, { headers: svcH })).text());
const diff = before.tables_in_snapshot.filter((tb) => sha(JSON.stringify(after.data[tb])) !== beforeSums[tb]);
check('database: all 29 tables identical to before the damage', diff.length === 0, diff);
let restoredOk = 0;
for (const [k, s] of Object.entries(originals)) { const [bucket, ...rest] = k.split('/'); const d = await fetch(`${API}/storage/v1/object/${bucket}/${rest.join('/')}`, { headers: svcH }); if (d.ok && sha(Buffer.from(await d.arrayBuffer())) === s) restoredOk++; }
check('stored files: every file byte-identical at its original path', restoredOk === Object.keys(originals).length, restoredOk);
fs.rmSync(OUT, { recursive: true, force: true });
check('plaintext restore files deleted', !fs.existsSync(OUT));

console.log('10. scheduling with pg_cron + pg_net (schedule SQL from the repository)');
sql("select vault.create_secret('http://172.18.0.1:54401/', 'dlm_backup_function_url')");
execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', 'supabase/migrations-pending/20261114190100_automated_backup_schedule.sql'], { stdio: ['ignore', 'ignore', 'pipe'] });
check('three jobs scheduled (daily backup, weekly verify, daily health)', sql("select string_agg(jobname || '=' || schedule, ', ' order by jobname) from cron.job where jobname like 'dlm-backup-%'") === 'dlm-backup-daily=17 2 * * *, dlm-backup-health=47 3 * * *, dlm-backup-verify=27 4 * * 0');
const n0 = Number(sql("select count(*) from dlm_backup.runs where mode = 'backup' and status = 'succeeded'"));
sql("select cron.schedule('dlm-backup-test-every-minute', '* * * * *', $$select dlm_backup.invoke('backup')$$)");
let n1 = n0;
for (let i = 0; i < 26 && n1 === n0; i++) { await sleep(5000); n1 = Number(sql("select count(*) from dlm_backup.runs where mode = 'backup' and status = 'succeeded'")); }
sql("select cron.unschedule('dlm-backup-test-every-minute')");
check('a pg_cron job calling dlm_backup.invoke() triggered a successful backup through pg_net', n1 > n0, { n0, n1 });
sql("select cron.unschedule(jobname) from cron.job where jobname like 'dlm-backup-%'");

console.log('11. retention + object lock together (simulated clock)');
const keysNow = Object.keys((await simState()).objects).length;
await fetch(`${SIM}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 34 }) });
let lc = await (await fetch(`${SIM}/__sim/lifecycle`, { method: 'POST' })).json();
check('day 34: lifecycle deletes nothing (not yet 35 days old)', lc.deleted === 0 && Object.keys((await simState()).objects).length === keysNow, lc);
x = await signed(SIM, 'DELETE', victim, null, ...A_KEY, {}, `?versionId=${victimVersion.versionId}`);
check('day 34: admin still cannot delete a locked version', x.status === 403, x.status);
await fetch(`${SIM}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 2 }) });
lc = await (await fetch(`${SIM}/__sim/lifecycle`, { method: 'POST' })).json();
check('day 36: lifecycle removes every expired version (retention is automatic)', lc.deleted > 0 && Object.keys((await simState()).objects).length === 0, lc);
// misconfiguration: lifecycle shorter than the lock
const put2 = await signed(SIM2, 'PUT', 'runs/x/db.json.age', Buffer.from('ciphertext'), ...W_KEY);
check('second bucket (lifecycle 30 d < lock 35 d): upload ok', put2.status === 200, put2.status);
await fetch(`${SIM2}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 31 }) });
lc = await (await fetch(`${SIM2}/__sim/lifecycle`, { method: 'POST' })).json();
check('day 31: the lock wins — lifecycle cannot delete before the lock ends', lc.deleted === 0 && lc.blocked === 1, lc);
await fetch(`${SIM2}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 5 }) });
lc = await (await fetch(`${SIM2}/__sim/lifecycle`, { method: 'POST' })).json();
check('day 36: deleted once the lock has expired', lc.deleted === 1, lc);

console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
