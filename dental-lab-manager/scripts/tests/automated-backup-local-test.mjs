#!/usr/bin/env node
/**
 * LOCAL-ONLY end-to-end + security test of the automated backup with a SEPARATE
 * Backup Runner project (backup-runner/) reading production through the
 * token-gated, read-only access (supabase/migrations-pending/20261115090000_*).
 * Started by scripts/tests/automated-backup-local-test.sh.
 */
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAgainstManifest } from '../backup/restore-core.mjs';

const E = process.env;
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RDB = 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';
const API = 'http://127.0.0.1:54321';
const RAPI = 'http://127.0.0.1:54331';
const FN = 'http://127.0.0.1:54401/';
const SIM = 'http://127.0.0.1:54400';
const SIM2 = 'http://127.0.0.1:54402';
const W = E.WORK_DIR;
const { SRK, ANON, RSRK, RANON, PUB, TOKEN } = E;
const MARKERS = ['Zineb Marker-Patient', 'Marker-LegacyName', 'FileMarker-STL', 'FileMarker-PLY', 'FileMarker-OBJ', 'FileMarker-3MF', 'FileMarker-DCM', 'FileMarker-LOGO', 'FileMarker-OTHERLAB', 'Demo Dental Lab'];
if (!W || !SRK || !RSRK || !TOKEN) { console.error('local only; started by automated-backup-local-test.sh'); process.exit(2); }

let failed = 0; let passed = 0;
const check = (n, ok, d) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`); };
const q = (db) => (s) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', s]).toString().trim();
const sql = q(DB);      // production (local)
const rsql = q(RDB);    // runner (local)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fp = (v) => sha(String(v)).slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trigger = () => rsql("select decrypted_secret from vault.decrypted_secrets where name = 'dlm_backup_trigger'");
const runFn = (secret, mode = 'backup', url = FN) => fetch(url, { method: 'POST', headers: { 'x-dlm-backup-trigger': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
const simState = async (base = SIM) => (await (await fetch(`${base}/__sim/state`)).json());
const simRaw = async (key) => Buffer.from(await (await fetch(`${SIM}/__sim/raw?key=${encodeURIComponent(key)}`)).arrayBuffer());
const ageDecrypt = (buf) => { const r = spawnSync('age', ['-d', '-i', path.join(W, 'k.txt')], { input: buf, maxBuffer: 1 << 30 }); if (r.status) throw new Error('decrypt failed'); return r.stdout; };
const ageEncrypt = (buf) => execFileSync('age', ['-r', PUB], { input: buf, maxBuffer: 1 << 30 });
const svcH = { apikey: SRK, Authorization: `Bearer ${SRK}` };
const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const tokH = (t) => ({ ...anonH, 'x-dlm-backup-token': t });
const lastRun = () => JSON.parse(rsql("select row_to_json(r) from (select mode, status, run_prefix, files_uploaded, files_total, error, manifest from dlm_runner.runs where mode in ('backup','verify') order by started_at desc limit 1) r") || 'null');
const proxyLog = () => (fs.existsSync(path.join(W, 'prod-requests.jsonl')) ? fs.readFileSync(path.join(W, 'prod-requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SNAP = `${API}/rest/v1/rpc/dlm_backup_runner_snapshot`;
const dlUrl = (bucket, name) => `${API}/storage/v1/object/authenticated/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}`;
const snapshotVia = async (h) => { const r = await fetch(SNAP, { headers: h }); return { status: r.status, body: await r.text() }; };
const statsHold = (...toks) => { const all = execFileSync('psql', ['-X', '-At', '-d', DB, '-c', 'select query from pg_stat_statements'], { maxBuffer: 1 << 28 }).toString(); return toks.some((t) => all.includes(t)); };
const dump = (container, args = []) => execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--data-only', ...args, 'postgres'], { maxBuffer: 1 << 28 }).toString();

/** Independent SigV4 signer (third implementation) for direct-key tests. */
function signed(base, method, key, body, keyId, secret, extra = {}, query = '') {
  const u = new URL(`${base}/dlm-backups-test${key ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''}${query}`);
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); const date = amz.slice(0, 8);
  const payload = body ? sha(body) : sha('');
  const headers = { host: u.host, 'x-amz-content-sha256': extra['x-amz-content-sha256'] ?? payload, 'x-amz-date': amz, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'x-amz-content-sha256')) };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const qs = [...u.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const canon = [method, u.pathname, qs, names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n');
  const scope = `${date}/eu-test-1/s3/aws4_request`;
  const hm = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const kk = hm(hm(hm(hm('AWS4' + secret, date), 'eu-test-1'), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kk).update(['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n')).digest('hex');
  return fetch(u, { method, body, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` } });
}
const W_KEY = ['FNWRITE', 'fn-write-secret-local-test'];
const R_KEY = ['FNREAD', 'fn-read-secret-local-test'];
const RESTORE_KEY = ['RESTORE', 'restore-secret-local-test'];
const A_KEY = ['ADMIN', 'admin-secret-local-test'];

/** Runner function environment (as a hosted runner project would have it). */
const fnEnv = (over = {}) => ({
  PATH: E.PATH, HOME: E.HOME, DENO_DIR: E.DENO_DIR ?? `${E.HOME}/.cache/deno`, DENO_CERT: E.DENO_CERT ?? '', HTTPS_PROXY: E.HTTPS_PROXY ?? '', NO_PROXY: '127.0.0.1,localhost,0.0.0.0',
  SUPABASE_URL: RAPI, SUPABASE_SERVICE_ROLE_KEY: RSRK, SUPABASE_DB_URL: RDB,
  DLM_PROD_URL: 'http://127.0.0.1:54410', DLM_PROD_ANON_KEY: ANON, DLM_PROD_BACKUP_TOKEN: TOKEN,
  DLM_BACKUP_AGE_RECIPIENTS: PUB, DLM_BACKUP_S3_ENDPOINT: SIM, DLM_BACKUP_S3_REGION: 'eu-test-1', DLM_BACKUP_S3_BUCKET: 'dlm-backups-test',
  DLM_BACKUP_S3_WRITE_KEY_ID: W_KEY[0], DLM_BACKUP_S3_WRITE_SECRET: W_KEY[1], DLM_BACKUP_S3_READ_KEY_ID: R_KEY[0], DLM_BACKUP_S3_READ_SECRET: R_KEY[1],
  ...over,
});
const denoArgs = (script, port) => ['run', '--no-prompt', '--frozen', `--lock=${E.FNDIR}/deno.lock`, '--config', `${E.FNDIR}/deno.json`,
  `--allow-env=${E.ALLOW_ENV}`, `--allow-net=127.0.0.1:54331,127.0.0.1:54410,127.0.0.1:54400${port ? `,0.0.0.0:${port}` : ''}`, script];
async function startFn(port, token, log) {
  const out = fs.openSync(log, 'w');
  const p = spawn(E.DENO, denoArgs('scripts/tests/dlm-backup-serve.ts', port), { env: fnEnv({ DLM_PROD_BACKUP_TOKEN: token, DLM_TEST_PORT: String(port) }), stdio: ['ignore', out, out] });
  for (let i = 0; i < 60 && !fs.readFileSync(log, 'utf8').includes('test server on'); i++) await sleep(500);
  return p;
}
const once = (over) => {
  const r = spawnSync(E.DENO, denoArgs('scripts/tests/dlm-backup-once.ts'), { env: fnEnv(over) });
  try { return JSON.parse(r.stdout.toString().trim().split('\n').pop()); } catch { return { status: -1, out: r.stdout.toString() + r.stderr.toString() }; }
};

// ---------------------------------------------------------------------------
console.log('0. fixture: production files (STL, PLY, OBJ, 3MF, DCM), legacy photo, lab logo, another lab\'s file, a legacy patient');
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
const up = async (bucket, p, mime, body) => { const r = await fetch(`${API}/storage/v1/object/${bucket}/${p}`, { method: 'POST', headers: { ...svcH, 'Content-Type': mime }, body }); if (!r.ok) throw new Error(`fixture upload ${r.status}`); originals[`${bucket}/${p}`] = sha(body); };
let firstPath = null;
for (const [ext, mime, body] of files) {
  const p = `${lab}/${kase}/${crypto.randomUUID()}.${ext}`;
  await up('case-files', p, mime, body);
  firstPath ??= p;
  sql(`insert into public.attachments (lab_id, case_id, category, file_name, mime_type, size_bytes, storage_path, uploaded_by)
       values ('${lab}', '${kase}', 'scan', 'scan_upper.${ext}', '${mime}', ${body.length}, '${p}', '${admin}')`);
}
const legacyPath = `${lab}/${kase}/${crypto.randomUUID()}-Marker-LegacyName_smile.jpg`;
await up('case-files', legacyPath, 'image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('FileMarker-LEGACYJPG'), crypto.randomBytes(512)]));
const logoPath = `${lab}/logo/${Date.now()}.png`;
const logoBody = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('FileMarker-LOGO'), crypto.randomBytes(256)]);
await up('lab-assets', logoPath, 'image/png', logoBody);
const otherLabPath = `${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}.stl`;   // belongs to no lab of the test user
await up('case-files', otherLabPath, 'model/stl', Buffer.from('solid FileMarker-OTHERLAB\nendsolid\n'));
const storedCount = Number(sql('select count(*) from storage.objects'));
check(`fixture: ${storedCount} stored files (5 production formats, legacy photo, logo, another lab's file)`, storedCount === 8, storedCount);
const emp = await (await fetch('http://127.0.0.1:54399/employee-login', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ lab_code: 'LOCALBK', employee_code: 'ADMIN01', pin: fs.readFileSync(E.PIN_FILE, 'utf8').trim() }) })).json();
const userJwt = emp.session.access_token;
const userH = { apikey: ANON, Authorization: `Bearer ${userJwt}` };

// ---------------------------------------------------------------------------
console.log('1. production: only token-gated, read-only access exists');
check('production has no pg_net extension', sql("select count(*) from pg_extension where extname = 'pg_net'") === '0');
check('production has no backup cron job', sql("select count(*) from cron.job where jobname like 'dlm-backup%'") === '0');
check('backup functions in production: only the snapshot and its token-checked wrapper', sql("select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'dlm_backup%'") === 'dlm_backup_runner_snapshot,dlm_backup_snapshot');
check('the only backup function anon may call is the wrapper, and it is read-only (STABLE)', sql("select string_agg(proname || ':' || provolatile::text, ',') from pg_proc where proname like 'dlm_backup%' and has_function_privilege('anon', oid, 'EXECUTE')") === 'dlm_backup_runner_snapshot:s');
check('service_role can execute neither snapshot function', sql("select (has_function_privilege('service_role', 'public.dlm_backup_snapshot()', 'EXECUTE') or has_function_privilege('service_role', 'public.dlm_backup_runner_snapshot()', 'EXECUTE'))::text") === 'false');
check('production stores only the SHA-256 of the token, never the token', sql(`select count(*) from dlm_backup.runner_tokens where token_hash = '${sha(TOKEN)}'`) === '1' && sql(`select count(*) from dlm_backup.runner_tokens where token_hash = '${TOKEN}' or label like '%dlmbk1%'`) === '0');
check('the token table is not readable by anon, authenticated or service_role', sql("select (has_table_privilege('anon','dlm_backup.runner_tokens','SELECT') or has_table_privilege('authenticated','dlm_backup.runner_tokens','SELECT') or has_table_privilege('service_role','dlm_backup.runner_tokens','SELECT'))::text") === 'false');
let x = await fetch(`${API}/rest/v1/runner_tokens`, { headers: { ...svcH, 'Accept-Profile': 'dlm_backup' } });
check('schema dlm_backup is not exposed by the API (even with the service key)', x.status === 406, x.status);
const wrongTok = `dlmbk1_${crypto.randomBytes(32).toString('hex')}`;
for (const [label, h, want] of [
  ['anon without token', anonH, false], ['anon with a wrong token', tokH(wrongTok), false],
  ['anon with a malformed token', tokH(TOKEN.slice(0, -1)), false], ['anon with the token in upper case', tokH(TOKEN.toUpperCase()), false],
  ['anon with the token HASH (as stored in production)', tokH(sha(TOKEN)), false],
  ['logged-in app user without token', userH, false], ['logged-in app user WITH the valid token', { ...userH, 'x-dlm-backup-token': TOKEN }, false],
  ['production service key', svcH, false], ['production service key WITH the valid token', { ...svcH, 'x-dlm-backup-token': TOKEN }, false],
  ['anon with the valid token', tokH(TOKEN), true],
]) {
  const s = await snapshotVia(h);
  check(`snapshot — ${label}: ${want ? 'allowed' : 'refused'}`, want ? s.status === 200 && JSON.parse(s.body).format === 'dlm-backup-v1' : s.status === 401 || s.status === 403, s.status);
}
x = await fetch(`${API}/rest/v1/rpc/dlm_backup_snapshot`, { headers: tokH(TOKEN) });
check('the inner snapshot function cannot be called directly, even with the token', x.status === 401 || x.status === 403, x.status);
for (const [label, p, h, want] of [
  ['anon without token', firstPath, anonH, false], ['anon with a wrong token', firstPath, tokH(wrongTok), false],
  ['logged-in app user, another lab\'s file, WITH the token', otherLabPath, { ...userH, 'x-dlm-backup-token': TOKEN }, false],
  ['production service key path is unaffected (sanity: allowed)', firstPath, svcH, true],
  ['anon with the valid token', firstPath, tokH(TOKEN), true],
  ['anon with the valid token, another lab\'s file', otherLabPath, tokH(TOKEN), true],
]) {
  const r = await fetch(dlUrl('case-files', p), { headers: h });
  check(`file download — ${label}: ${want ? 'allowed' : 'refused'}`, want ? r.ok : !r.ok, r.status);
}
const T = tokH(TOKEN);
const J = { ...T, 'Content-Type': 'application/json' };
const B = { ...T, 'Content-Type': 'model/stl' };
const objCount = () => Number(sql('select count(*) from storage.objects'));
const n0 = objCount();
for (const [label, req] of [
  ['upload a new file', () => fetch(`${API}/storage/v1/object/case-files/${lab}/evil.stl`, { method: 'POST', headers: B, body: 'x' })],
  ['overwrite a file (PUT)', () => fetch(`${API}/storage/v1/object/case-files/${firstPath}`, { method: 'PUT', headers: B, body: 'x' })],
  ['overwrite a file (upsert)', () => fetch(`${API}/storage/v1/object/case-files/${firstPath}`, { method: 'POST', headers: { ...B, 'x-upsert': 'true' }, body: 'x' })],
  ['delete a file', () => fetch(`${API}/storage/v1/object/case-files/${firstPath}`, { method: 'DELETE', headers: T })],
  ['move a file', () => fetch(`${API}/storage/v1/object/move`, { method: 'POST', headers: J, body: JSON.stringify({ bucketId: 'case-files', sourceKey: firstPath, destinationKey: `${lab}/moved.stl` }) })],
  ['copy a file', () => fetch(`${API}/storage/v1/object/copy`, { method: 'POST', headers: J, body: JSON.stringify({ bucketId: 'case-files', sourceKey: firstPath, destinationKey: `${lab}/copied.stl` }) })],
  ['create a signed download URL (would outlive revocation)', () => fetch(`${API}/storage/v1/object/sign/case-files/${firstPath}`, { method: 'POST', headers: J, body: JSON.stringify({ expiresIn: 31536000 }) })],
  ['create a signed upload URL', () => fetch(`${API}/storage/v1/object/upload/sign/case-files/${lab}/evil2.stl`, { method: 'POST', headers: T })],
  ['read object details (info)', () => fetch(`${API}/storage/v1/object/info/authenticated/case-files/${firstPath}`, { headers: T })],
  ['make the bucket public', () => fetch(`${API}/storage/v1/bucket/case-files`, { method: 'PUT', headers: J, body: JSON.stringify({ public: true }) })],
  ['create a bucket', () => fetch(`${API}/storage/v1/bucket`, { method: 'POST', headers: J, body: JSON.stringify({ name: 'evil', public: true }) })],
  ['delete the bucket', () => fetch(`${API}/storage/v1/bucket/case-files`, { method: 'DELETE', headers: T })],
  ['read a table directly (patients)', () => fetch(`${API}/rest/v1/patients?select=full_name`, { headers: T })],
  ['insert into a table', () => fetch(`${API}/rest/v1/cases`, { method: 'POST', headers: J, body: '{}' })],
  ['update a table', () => fetch(`${API}/rest/v1/laboratories?id=not.is.null`, { method: 'PATCH', headers: J, body: JSON.stringify({ name: 'x' }) })],
  ['bulk-delete a table', () => fetch(`${API}/rest/v1/cases?id=not.is.null`, { method: 'DELETE', headers: T })],
  ['use the Auth admin API', () => fetch(`${API}/auth/v1/admin/users`, { headers: T })],
]) {
  const r = await req(); const t = await r.text();
  check(`token holder cannot ${label}`, !r.ok || (r.status === 200 && t === '[]'), { status: r.status, body: t.slice(0, 120) });
}
x = await fetch(`${API}/storage/v1/object/sign/case-files`, { method: 'POST', headers: J, body: JSON.stringify({ expiresIn: 60, paths: [firstPath] }) });
const signed2 = await x.text();
check('token holder cannot create signed URLs in bulk either (no signedURL returned)', !signed2.includes('"signedURL":"/'), signed2.slice(0, 160));
x = await fetch(`${API}/storage/v1/object/list/case-files`, { method: 'POST', headers: J, body: JSON.stringify({ prefix: lab }) });
check('token holder cannot list files (empty result)', (await x.text()) === '[]');
check('…nothing changed: same files, bucket still private, tables intact', objCount() === n0 && sql("select public::text from storage.buckets where id = 'case-files'") === 'false' && sql('select count(*) from public.cases') !== '0' && sql("select count(*) from public.laboratories where name = 'x'") === '0');

// ---------------------------------------------------------------------------
console.log('2. the runner endpoint and RPCs: callers without the trigger secret get nothing');
let r = await runFn('wrong-secret');
check('wrong trigger secret → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'POST', body: '{}' });
check('missing trigger header → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'POST', headers: { ...anonH, 'Content-Type': 'application/json' }, body: '{}' });
check('production anon key as credential → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'POST', headers: { ...userH, 'Content-Type': 'application/json' }, body: '{}' });
check('logged-in app user JWT as credential → 401', r.status === 401, r.status);
r = await fetch(FN, { method: 'GET' });
check('GET → 405', r.status === 405, r.status);
for (const [label, h] of [['runner anon key', { apikey: RANON, Authorization: `Bearer ${RANON}` }], ['production anon key', anonH], ['production app user JWT', userH], ['production service key', svcH]]) {
  const a = await fetch(`${RAPI}/rest/v1/rpc/dlm_runner_recent`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
  check(`runner RPCs refuse the ${label}`, a.status === 401 || a.status === 403 || a.status === 404, a.status);
}
check('nothing recorded, nothing uploaded, and production received no request', rsql('select count(*) from dlm_runner.runs') === '0' && Object.keys((await simState()).objects).length === 0 && proxyLog().length === 0);

// ---------------------------------------------------------------------------
console.log('3. first backup');
r = await runFn(trigger());
const body1 = await r.json();
check('backup run accepted', r.ok && /^[0-9a-f-]{36}$/.test(body1.run ?? ''), body1);
let run = lastRun();
check('run succeeded', run?.status === 'succeeded', run);
const prefix1 = run.run_prefix;
const keys = Object.keys((await simState()).objects);
check(`every stored file copied (${storedCount}, all buckets) + snapshot + file map + manifest`, keys.filter((k) => k.startsWith('files/')).length === storedCount && [`${prefix1}/db.json.age`, `${prefix1}/files.json.age`, `${prefix1}/manifest.json`].every((k) => keys.includes(k)), keys);
check('object keys contain no names (only stamps, ids and hashes)', keys.every((k) => /^(runs\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\/(db\.json\.age|files\.json\.age|manifest\.json)|files\/[0-9a-f-]{36}\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.age)$/.test(k)), keys);
const leak = [];
for (const k of keys) { const raw = (await simRaw(k)).toString('latin1'); for (const m of MARKERS.concat(['FileMarker-LEGACYJPG', 'smile'])) if (raw.includes(m)) leak.push(`${k}:${m}`); }
check('no plaintext marker (patient, lab, file names, file contents) in any stored object', leak.length === 0, leak);
check('every object except the manifest is age-encrypted', (await Promise.all(keys.filter((k) => !k.endsWith('manifest.json')).map(async (k) => (await simRaw(k)).subarray(0, 21).toString() === 'age-encryption.org/v1'))).every(Boolean));
const manifest1 = JSON.parse(await simRaw(`${prefix1}/manifest.json`));
check('manifest: counts, hashes and the public key used (no names)', manifest1.format === 'dlm-backup-manifest-v1' && manifest1.storage_objects === storedCount && Object.keys(manifest1.tables).length === 29 && JSON.stringify(manifest1.recipients) === JSON.stringify([PUB]));
const snap = JSON.parse(ageDecrypt(await simRaw(`${prefix1}/db.json.age`)));
const vr = await verifyAgainstManifest(snap, manifest1, async (b) => sha(b));
check('snapshot decrypts with the private key and matches the manifest (29 tables)', vr.ok && vr.tables === 29, vr);
check('snapshot contains the legacy patient (complete backup, RLS bypassed)', JSON.stringify(snap.data.patients).includes('Zineb Marker-Patient'));
const fmap = JSON.parse(ageDecrypt(await simRaw(`${prefix1}/files.json.age`))).files;
let fileOk = 0;
for (const f of fmap) { const plain = ageDecrypt(await simRaw(f.backup_key)); if (sha(plain) === f.sha256 && originals[`${f.bucket}/${f.name}`] === f.sha256) fileOk++; }
check('every stored file decrypts to its exact original bytes (STL, PLY, OBJ, 3MF, DCM, photo, logo, other lab)', fileOk === storedCount, { fileOk, storedCount });
const plog = proxyLog();
check(`production received only GET requests (${plog.length}) with no body`, plog.length > 0 && plog.every((p) => p.method === 'GET' && p.bodyBytes === 0), [...new Set(plog.map((p) => p.method))]);
check('…only the token-checked snapshot and file downloads', plog.every((p) => p.kind === 'rpc:dlm_backup_runner_snapshot' || p.kind === 'storage:download'), [...new Set(plog.map((p) => p.kind))]);
check('…every request carried exactly production\'s PUBLIC anon key and the backup token', plog.every((p) => p.apikey === fp(ANON) && p.authorization === fp(ANON) && p.token === fp(TOKEN)));
check('…never the runner\'s own service key, never production\'s service key', plog.every((p) => ![fp(RSRK), fp(SRK)].includes(p.apikey) && ![fp(RSRK), fp(SRK)].includes(p.authorization)));
const runnerDump = dump('supabase_db_dlm-backup-runner', ['-n', 'dlm_runner']);
check('runner database holds no names, paths or row data (ids, hashes, keys only)', MARKERS.concat(['smile', 'scan_upper', firstPath, logoPath]).every((m) => !runnerDump.includes(m)));
const fnLog = fs.readFileSync(path.join(W, 'fn.log'), 'utf8');
check('function log contains no names, file paths or row data', MARKERS.concat(['smile', lab, kase]).every((m) => !fnLog.includes(m)));

console.log('4. incremental copies, re-upload before expiry, changed files');
await runFn(trigger()); run = lastRun();
check('second run: snapshot only, no file re-uploaded', run.status === 'succeeded' && run.manifest.files_uploaded_this_run === 0, run.manifest?.files_uploaded_this_run);
const logoId = sql(`select id from storage.objects where name = '${logoPath}'`);
rsql(`update dlm_runner.files set uploaded_at = now() - interval '29 days' where object_id = '${logoId}'`);
await runFn(trigger()); run = lastRun();
check('a file copied 29 days ago is copied again (stays inside the 35-day window)', run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
await fetch(`${API}/storage/v1/object/lab-assets/${logoPath}`, { method: 'PUT', headers: { ...svcH, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: Buffer.concat([logoBody, Buffer.from('v2')]) });
await runFn(trigger()); run = lastRun();
check('a changed file is copied again', run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
await fetch(`${API}/storage/v1/object/lab-assets/${logoPath}`, { method: 'PUT', headers: { ...svcH, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: logoBody });
await runFn(trigger());

console.log('5. a compromised runner (its write-only key) cannot read, list, delete or overwrite existing backups');
const victim = `${prefix1}/db.json.age`;
const victimVersion = (await simState()).objects[victim][0];
for (const [label, req] of [
  ['GET an existing backup', () => signed(SIM, 'GET', victim, null, ...W_KEY)],
  ['HEAD an existing backup', () => signed(SIM, 'HEAD', victim, null, ...W_KEY)],
  ['LIST the bucket', () => signed(SIM, 'GET', '', null, ...W_KEY, {}, '?list-type=2')],
  ['LIST object versions', () => signed(SIM, 'GET', '', null, ...W_KEY, {}, '?versions=')],
  ['DELETE a backup', () => signed(SIM, 'DELETE', victim, null, ...W_KEY)],
  ['DELETE a specific version', () => signed(SIM, 'DELETE', victim, null, ...W_KEY, {}, `?versionId=${victimVersion.versionId}`)],
  ['change lifecycle / lock configuration', () => signed(SIM, 'PUT', '', Buffer.from('<LifecycleConfiguration/>'), ...W_KEY, {}, '?lifecycle')],
]) { x = await req(); check(`write-only key: ${label} → 403`, x.status === 403, x.status); }
x = await signed(SIM, 'PUT', victim, Buffer.from('evil'), ...W_KEY, { 'if-none-match': '*' });
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
check('the runner read key cannot delete either', x.status === 403, x.status);
x = await signed(SIM, 'GET', '', null, ...R_KEY, {}, '?versions=');
check('the runner read key cannot list (only the separate restore key can)', x.status === 403, x.status);

console.log('6. weekly integrity check (read key: can read ciphertext, cannot decrypt)');
await runFn(trigger(), 'verify'); run = lastRun();
check('verify run succeeded over recent snapshots and all files (reads the pinned versions)', run.mode === 'verify' && run.status === 'succeeded' && run.files_total > storedCount, run);
const someFile = fmap[0].backup_key;
await fetch(`${SIM}/__sim/corrupt`, { method: 'POST', body: JSON.stringify({ key: someFile }) });
await runFn(trigger(), 'verify'); run = lastRun();
check('a corrupted object is detected (verify run failed, no names in the error)', run.status === 'failed' && /^integrity_failed 1 of \d+$/.test(run.error ?? ''), run.error);
await runFn(trigger()); run = lastRun();
check('self-healing: the next backup copies the damaged file again', run.status === 'succeeded' && run.manifest.files_uploaded_this_run === 1, run.manifest?.files_uploaded_this_run);
await runFn(trigger(), 'verify'); run = lastRun();
check('verify after self-healing succeeds', run.status === 'succeeded', run.error);

console.log('7. health check (missed backups), in the runner project');
rsql("update dlm_runner.runs set finished_at = now() - interval '27 hours', started_at = now() - interval '27 hours' where mode = 'backup'");
rsql('select dlm_runner.health()');
check('no success in 26 h → one alert row', rsql("select count(*) from dlm_runner.runs where mode = 'health' and status = 'alert'") === '1');
rsql('select dlm_runner.health()');
check('repeated health check → still one alert (no flood)', rsql("select count(*) from dlm_runner.runs where mode = 'health'") === '1');

console.log('8. the runner refuses unsafe configurations BEFORE contacting anything');
const runsBefore = rsql('select count(*) from dlm_runner.runs');
const proxyBefore = proxyLog().length;
for (const [label, over, reason] of [
  ['running outside London (SB_REGION=us-east-1)', { SB_REGION: 'us-east-1' }, 'wrong_region'],
  ['region unknown with a remote production URL', { DLM_PROD_URL: 'https://prod.example.com' }, 'wrong_region'],
  ['deployed inside the production project (same origin)', { SUPABASE_URL: 'http://127.0.0.1:54410' }, 'runner_is_production'],
  ["given production's SERVICE-ROLE key instead of the anon key", { SB_REGION: 'eu-west-2', DLM_PROD_ANON_KEY: SRK }, 'prod_key_not_anon'],
  ['given a secret (sb_secret_…) key', { SB_REGION: 'eu-west-2', DLM_PROD_ANON_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }, 'prod_key_not_anon'],
  ['given a malformed token', { DLM_PROD_BACKUP_TOKEN: 'secret' }, 'bad_token_format'],
  ['given a non-HTTPS remote storage endpoint', { DLM_BACKUP_S3_ENDPOINT: 'http://storage.example.com' }, 'bad_storage'],
  ['given a non-HTTPS remote production URL', { SB_REGION: 'eu-west-2', DLM_PROD_URL: 'http://prod.example.com' }, 'bad_url'],
]) {
  const o = once(over);
  check(`refuses when ${label} (${reason})`, o.status === 500 && o.body?.reason === reason, o);
}
const o = once({ SB_REGION: 'eu-west-2', DLM_TEST_TRIGGER: 'wrong' });
check('accepts London (SB_REGION=eu-west-2) — then the trigger check applies (401)', o.status === 401, o);
check('…the refused configurations recorded nothing and sent nothing to production', rsql('select count(*) from dlm_runner.runs') === runsBefore && proxyLog().length === proxyBefore);

console.log('9. key and data separation between the projects');
x = await fetch(`${API}/rest/v1/patients?select=id`, { headers: { apikey: RSRK, Authorization: `Bearer ${RSRK}` } });
check("the runner's own service key is rejected by production (REST)", x.status === 401, x.status);
x = await fetch(dlUrl('case-files', firstPath), { headers: { apikey: RSRK, Authorization: `Bearer ${RSRK}` } });
check('…and by production Storage', !x.ok, x.status);
x = await fetch(SNAP, { headers: { apikey: RSRK, Authorization: `Bearer ${RSRK}`, 'x-dlm-backup-token': TOKEN } });
check('…even together with the valid token', x.status === 401 || x.status === 403, x.status);
const fnPid = execFileSync('bash', ['-c', "for p in $(pgrep -f dlm-backup-serve.ts); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q '^DLM_TEST_PORT=54401$' && echo $p; done; true"]).toString().trim().split('\n')[0];
const fnEnvVals = fs.readFileSync(`/proc/${fnPid}/environ`).toString().split('\0');
check('the runner process environment holds no production service key and no production database URL', fnEnvVals.length > 5 && !fnEnvVals.some((v) => v.includes(SRK) || v.includes('@127.0.0.1:54322')), fnEnvVals.map((v) => v.split('=')[0]));
const prodDump = dump('supabase_db_dental-lab-manager');
check('production database holds no runner credential (runner keys, trigger secret, storage keys) and not the token', [RSRK, RANON, trigger(), W_KEY[1], R_KEY[1], TOKEN].every((v) => !prodDump.includes(v)));
const runnerAll = dump('supabase_db_dlm-backup-runner');
check('runner database holds no production credential (service key, anon key, token)', [SRK, ANON, TOKEN].every((v) => !runnerAll.includes(v)));
check('the token never appears in production query statistics', !statsHold(TOKEN));

console.log('10. tampering by a compromised runner, then full restoration');
await runFn(trigger()); run = lastRun();
const prefixR = run.run_prefix;
const before = JSON.parse((await snapshotVia(tokH(TOKEN))).body);
const beforeSums = Object.fromEntries(before.tables_in_snapshot.map((tb) => [tb, sha(JSON.stringify(before.data[tb]))]));
// the attacker (write key + public key) adds a FAKE snapshot and a FAKE manifest matching it under the real run's keys
const fake = { ...before, data: { ...before.data, patients: [] } };
const fakeCipher = ageEncrypt(Buffer.from(JSON.stringify(fake)));
x = await signed(SIM, 'PUT', `${prefixR}/db.json.age`, fakeCipher, ...W_KEY);
const fakeVid = x.headers.get('x-amz-version-id');
const realMan = JSON.parse(await simRaw(`${prefixR}/manifest.json`));
const fakeMan = { ...realMan, tables: { ...realMan.tables, patients: { rows: 0, sha256: sha('[]') } }, db: { ...realMan.db, cipher_sha256: sha(fakeCipher), bytes: fakeCipher.length, version_id: fakeVid } };
x = await signed(SIM, 'PUT', `${prefixR}/manifest.json`, Buffer.from(JSON.stringify(fakeMan)), ...W_KEY);
check('the attacker could add fake versions of the snapshot and the manifest (but not replace them)', x.status === 200 && (await simState()).objects[`${prefixR}/manifest.json`].length === 2);
const OUT = path.join(W, 'restore'); fs.rmSync(OUT, { recursive: true, force: true });
const renv = (k) => ({ ...process.env, S3_ENDPOINT: SIM, S3_REGION: 'eu-test-1', S3_BUCKET: 'dlm-backups-test', S3_READ_KEY_ID: k[0], S3_READ_SECRET: k[1], AGE_IDENTITY: path.join(W, 'k.txt'), OUT_DIR: OUT, SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SRK });
let rr = spawnSync('node', ['scripts/backup/offsite-restore.mjs', 'fetch', prefixR], { env: renv(R_KEY) });
check('restore with a key that cannot list versions refuses (tampering cannot be ruled out)', rr.status !== 0 && /cannot list object versions/.test(rr.stderr.toString()), rr.stderr.toString().slice(0, 200));
rr = spawnSync('node', ['scripts/backup/offsite-restore.mjs', 'fetch', prefixR, '--write-plain'], { env: renv(RESTORE_KEY) });
const fetchOut = rr.stdout.toString(); const fetchErr = rr.stderr.toString();
check('offsite fetch with the restore key uses the FIRST versions: hashes, decryption and all tables verified', rr.status === 0 && /^OK: 29 tables/.test(fetchOut), fetchOut + fetchErr);
check('…and reports the extra (fake) versions as possible tampering', /manifest was written 2 times/.test(fetchErr) && /snapshot was written 2 times/.test(fetchErr), fetchErr);
const restoredJson = JSON.parse(fs.readFileSync(path.join(OUT, 'backup.json'), 'utf8'));
check('…the restored snapshot is the genuine one (legacy patient present), not the fake', JSON.stringify(restoredJson.data.patients).includes('Zineb Marker-Patient'));
check('…restore confirms the run is encrypted to your key only', !/NOT encrypted to your key|other key/.test(fetchErr));
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
rr = spawnSync('node', ['scripts/backup/offsite-restore.mjs', 'restore-files', prefixR], { env: renv(RESTORE_KEY) });
check('restore-files: every stored file restored with both hashes verified', rr.stdout.toString().startsWith(`OK: ${storedCount}/${storedCount}`), rr.stdout.toString() + rr.stderr.toString());
const after = JSON.parse((await snapshotVia(tokH(TOKEN))).body);
const diff = before.tables_in_snapshot.filter((tb) => sha(JSON.stringify(after.data[tb])) !== beforeSums[tb]);
check('database: all 29 tables identical to before the damage', diff.length === 0, diff);
let restoredOk = 0;
for (const [k, s] of Object.entries(originals)) { const [bucket, ...rest] = k.split('/'); const d = await fetch(`${API}/storage/v1/object/${bucket}/${rest.join('/')}`, { headers: svcH }); if (d.ok && sha(Buffer.from(await d.arrayBuffer())) === s) restoredOk++; }
check('stored files: every file byte-identical at its original path', restoredOk === Object.keys(originals).length, restoredOk);
fs.rmSync(OUT, { recursive: true, force: true });
check('plaintext restore files deleted', !fs.existsSync(OUT));

console.log('11. scheduling in the RUNNER project (pg_cron + pg_net), pinned to London');
rsql(`select vault.create_secret('http://${E.RUNNER_GW}:54401/', 'dlm_backup_function_url')`);
execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', RDB, '-f', 'backup-runner/supabase/schedule.sql'], { stdio: ['ignore', 'ignore', 'pipe'] });
check('three jobs scheduled in the runner (daily backup, weekly verify, daily health)', rsql("select string_agg(jobname || '=' || schedule, ', ' order by jobname) from cron.job where jobname like 'dlm-backup-%'") === 'dlm-backup-daily=17 2 * * *, dlm-backup-health=47 3 * * *, dlm-backup-verify=27 4 * * 0');
const c0 = Number(rsql("select count(*) from dlm_runner.runs where mode = 'backup' and status = 'succeeded'"));
rsql("select cron.schedule('dlm-backup-test-every-minute', '* * * * *', $$select dlm_runner.invoke('backup')$$)");
let c1 = c0;
for (let i = 0; i < 26 && c1 === c0; i++) { await sleep(5000); c1 = Number(rsql("select count(*) from dlm_runner.runs where mode = 'backup' and status = 'succeeded'")); }
rsql("select cron.unschedule('dlm-backup-test-every-minute')");
check('a runner pg_cron job triggered a successful backup through pg_net', c1 > c0, { c0, c1 });
check('…the scheduled call carried x-region: eu-west-2', /test-serve: request x-region=eu-west-2/.test(fs.readFileSync(path.join(W, 'fn.log'), 'utf8')));
rsql("select cron.unschedule(jobname) from cron.job where jobname like 'dlm-backup-%'");
check('production still has no pg_net and no backup job', sql("select count(*) from pg_extension where extname = 'pg_net'") === '0' && sql("select count(*) from cron.job where jobname like 'dlm-backup%'") === '0');

console.log('12. token rotation, revocation and expiry');
const idA = fs.readFileSync(path.join(W, 'token-a.id'), 'utf8').trim();
const tb = execFileSync('node', ['scripts/backup/runner-token.mjs', path.join(W, 'token-b.txt'), 'local test B']).toString();
const TOKEN_B = fs.readFileSync(path.join(W, 'token-b.txt'), 'utf8').trim();
const idB = sql(tb.match(/select dlm_backup\.register_token.*/)[0]);
check('rotation: a second token can be registered while the first is active', /^[0-9a-f-]{36}$/.test(idB) && sql('select count(*) from dlm_backup.token_status where active') === '2');
let threw = spawnSync('psql', ['-X', '-At', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-c', `select dlm_backup.register_token('${sha('third')}', 'third')`]);
check('…a third active token is refused (at most two during rotation)', threw.status !== 0 && /two tokens are already active/.test(threw.stderr.toString()));
threw = spawnSync('psql', ['-X', '-At', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-c', `select dlm_backup.register_token('${TOKEN_B}', 'plain')`]);
check('…registering a plaintext token instead of its hash is refused', threw.status !== 0 && /64 hex/.test(threw.stderr.toString()));
check('…token_status shows a hash prefix only', sql("select string_agg(length(hash_prefix)::text, ',') from dlm_backup.token_status") === '12,12');
check('both tokens work during the overlap', (await snapshotVia(tokH(TOKEN))).status === 200 && (await snapshotVia(tokH(TOKEN_B))).status === 200);
const fn2 = await startFn(54404, TOKEN_B, path.join(W, 'fn2.log'));
sql(`select dlm_backup.revoke_token('${idA}')`);
let s = await snapshotVia(tokH(TOKEN));
check('revoked token A: snapshot refused immediately', s.status === 403, s.status);
x = await fetch(dlUrl('case-files', firstPath), { headers: tokH(TOKEN) });
check('revoked token A: file download refused immediately', !x.ok, x.status);
const objBefore = Object.keys((await simState()).objects).length;
await runFn(trigger()); run = lastRun();
check('a runner still holding the revoked token gets nothing (run failed: production_access_denied, nothing uploaded)', run.status === 'failed' && run.error === 'production_access_denied' && Object.keys((await simState()).objects).length === objBefore, run);
await runFn(trigger(), 'backup', 'http://127.0.0.1:54404/'); run = lastRun();
check('the runner with the new token B backs up successfully', run.status === 'succeeded', run);
sql(`update dlm_backup.runner_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = '${idB}'`);
s = await snapshotVia(tokH(TOKEN_B));
check('expired token B: snapshot refused', s.status === 403, s.status);
x = await fetch(dlUrl('case-files', firstPath), { headers: tokH(TOKEN_B) });
check('expired token B: file download refused', !x.ok, x.status);
await runFn(trigger(), 'backup', 'http://127.0.0.1:54404/'); run = lastRun();
check('…and its runner run fails without uploading', run.status === 'failed' && run.error === 'production_access_denied', run);
const tc = execFileSync('node', ['scripts/backup/runner-token.mjs', path.join(W, 'token-c.txt'), 'local test C']).toString();
const TOKEN_C = fs.readFileSync(path.join(W, 'token-c.txt'), 'utf8').trim();
sql(tc.match(/select dlm_backup\.register_token.*/)[0]);
check('emergency stop: revoke_all_tokens() cuts off every token at once (C, and expired B)', sql('select dlm_backup.revoke_all_tokens()') === '2' && (await snapshotVia(tokH(TOKEN_C))).status === 403 && sql('select count(*) from dlm_backup.token_status where active') === '0');
check('no token ever appears in production query statistics (after rotation)', !statsHold(TOKEN, TOKEN_B, TOKEN_C));
fn2.kill();

console.log('13. retention + object lock together (simulated clock)');
const keysNow = Object.keys((await simState()).objects).length;
await fetch(`${SIM}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 34 }) });
let lc = await (await fetch(`${SIM}/__sim/lifecycle`, { method: 'POST' })).json();
check('day 34: lifecycle deletes nothing (not yet 35 days old)', lc.deleted === 0 && Object.keys((await simState()).objects).length === keysNow, lc);
x = await signed(SIM, 'DELETE', victim, null, ...A_KEY, {}, `?versionId=${victimVersion.versionId}`);
check('day 34: admin still cannot delete a locked version', x.status === 403, x.status);
await fetch(`${SIM}/__sim/clock`, { method: 'POST', body: JSON.stringify({ advanceDays: 2 }) });
lc = await (await fetch(`${SIM}/__sim/lifecycle`, { method: 'POST' })).json();
check("day 36: lifecycle removes every expired version, including the attacker's extra versions", lc.deleted > 0 && Object.keys((await simState()).objects).length === 0, lc);
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
