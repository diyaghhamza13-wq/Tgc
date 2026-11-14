#!/usr/bin/env node
/**
 * LOCAL-ONLY test of the legacy-file protections (migration 20261114155851,
 * sections 7–8), the forward script (scripts/redact-legacy-files.mjs) and the
 * reverse script (scripts/reverse-legacy-file-names.mjs), including an
 * encrypted backup/decrypt round trip. Never run against production: it
 * disables a trigger to create pre-Phase-1 style attachments.
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… FUNCTIONS_URL=…
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   LAB_CODE=… PIN_FILE=… WORK_DIR=/tmp/… (outside the repo)
 *   node scripts/tests/legacy-files-local-test.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SRK, FUNCTIONS_URL: FN, DB_URL, LAB_CODE, PIN_FILE, WORK_DIR } = process.env;
if (!/127\.0\.0\.1|localhost/.test(URL ?? '') || !/127\.0\.0\.1|localhost/.test(DB_URL ?? '')) {
  console.error('refusing to run: local URLs only');
  process.exit(2);
}
const PIN = fs.readFileSync(PIN_FILE, 'utf8').trim();
const NAME = 'Fatima_Zahra_Legacy'; // fictional identifying name used in legacy file names
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`); };
const sql = (q) => execFileSync('psql', ['-X', DB_URL, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const sqlJson = (q) => JSON.parse(sql(`select coalesce(json_agg(x), '[]') from (${q}) x`));
const svc = { apikey: SRK, Authorization: `Bearer ${SRK}` };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const run = (script, env) => execFileSync('node', [script], { env: { ...process.env, SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SRK, ...env } }).toString();

async function login(code) {
  const r = await fetch(`${FN}/employee-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ lab_code: LAB_CODE, employee_code: code, pin: PIN }) });
  const b = await r.json();
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  await c.auth.setSession({ access_token: b.session.access_token, refresh_token: b.session.refresh_token });
  return c;
}

const lab = sql(`select id from public.laboratories where code = '${LAB_CODE}'`);
const kase = sql(`select id from public.cases where lab_id = '${lab}' order by case_number limit 1`);
const admin = sql(`select id from public.employees where lab_id = '${lab}' and code = 'ADMIN01'`);

/** Everything the forward/reverse scripts may touch for this case. */
async function snapshot() {
  const objects = sqlJson(`select name from storage.objects where bucket_id = 'case-files' and name like '${lab}/${kase}/%' order by name`);
  const contents = {};
  for (const o of objects) {
    const r = await fetch(`${URL}/storage/v1/object/case-files/${o.name}`, { headers: svc });
    contents[o.name] = sha(Buffer.from(await r.arrayBuffer()));
  }
  return {
    objects: contents,
    attachments: sqlJson(`select * from public.attachments where case_id = '${kase}' order by id`),
    history: sqlJson(`select id, data from public.case_history where case_id = '${kase}' and event_type like 'file%' order by id`),
    audit: sqlJson(`select id, old_data, new_data from public.audit_logs where table_name = 'attachments' and coalesce(new_data, old_data)->>'case_id' = '${kase}' order by id`),
  };
}
const occurrences = () => Number(sql(`select
   (select count(*) from public.attachments where file_name ilike '%${NAME}%' or storage_path ilike '%${NAME}%')
 + (select count(*) from public.case_history where data::text ilike '%${NAME}%')
 + (select count(*) from public.audit_logs where coalesce(old_data::text,'') || coalesce(new_data::text,'') ilike '%${NAME}%')
 + (select count(*) from storage.objects where name ilike '%${NAME}%')`));
const sensitiveIds = () => sql(`select string_agg(id::text, ',') from public.attachments where case_id = '${kase}' and public.is_legacy_sensitive_file(category, file_name)`).split(',');

console.log('1. create pre-Phase-1 style attachments (trigger disabled locally)');
const legacy = [
  ['photo', `${NAME}_smile.jpg`, 'image/jpeg'],
  ['other', `${NAME} video.mp4`, 'video/mp4'],
  ['prescription', `order ${NAME}.pdf`, 'application/pdf'],
  ['scan', `${NAME} upper.stl`, 'model/stl'],
];
for (const [category, file, mime] of legacy) {
  const p = `${lab}/${kase}/${crypto.randomUUID()}-${file.replace(/[^\w.\-]+/g, '_')}`;
  const up = await fetch(`${URL}/storage/v1/object/case-files/${p}`, { method: 'POST', headers: { ...svc, 'Content-Type': mime }, body: `content of ${category} ${crypto.randomUUID()}` });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  sql(`alter table public.attachments disable trigger attachments_production_only;
       insert into public.attachments (lab_id, case_id, category, file_name, mime_type, size_bytes, storage_path, uploaded_by)
       values ('${lab}', '${kase}', '${category}', '${file}', '${mime}', 10, '${p}', '${admin}');
       alter table public.attachments enable trigger attachments_production_only;`);
}
// legacy files deleted earlier: their names survive only in history/audit
for (const f of [`${NAME}_deleted.png`, `${NAME}_deleted_lower.stl`]) {
  sql(`alter table public.attachments disable trigger attachments_production_only;
       insert into public.attachments (lab_id, case_id, category, file_name, size_bytes, storage_path, uploaded_by)
       values ('${lab}', '${kase}', '${f.endsWith('png') ? 'photo' : 'scan'}', '${f}', 1, '${lab}/${kase}/${crypto.randomUUID()}-${f}', '${admin}');
       alter table public.attachments enable trigger attachments_production_only;
       delete from public.attachments where file_name = '${f}';`);
}
const before = await snapshot();
check('original names present before redaction', occurrences() > 0, occurrences());

console.log('2. encrypted backup BEFORE any redaction (test key, local only)');
const keyFile = path.join(WORK_DIR, 'test-key.txt');
if (!fs.existsSync(keyFile)) execFileSync('age-keygen', ['-o', keyFile], { stdio: 'ignore' });
const pub = execFileSync('age-keygen', ['-y', keyFile]).toString().trim();
const outDir = path.join(WORK_DIR, `backup-${Date.now()}`);
execFileSync('node', ['scripts/backup/export.mjs'], { env: { ...process.env, DB_URL, AGE_RECIPIENT: pub, OUT_DIR: outDir, ALLOW_PRIVILEGED_LOGIN: '1' } }); // local superuser-like login
const enc = fs.readdirSync(outDir).find((f) => f.endsWith('.json.age'));
check('backup file is encrypted (no readable name inside)', !fs.readFileSync(path.join(outDir, enc)).includes(NAME));

console.log('3. access rule (section 7)');
const adm = await login('ADMIN01');
const cad = await login('CAD01');
const { data: aList } = await adm.from('attachments').select('category').eq('case_id', kase);
const { data: cList } = await cad.from('attachments').select('category').eq('case_id', kase);
check('administrator sees the 4 legacy files', aList.length === 4, aList.length);
check('technician sees only the legacy 3D file', cList.length === 1 && cList[0].category === 'scan', cList);
const photoPath = before.attachments.find((a) => a.category === 'photo').storage_path;
check('technician cannot download the legacy photo', !!(await cad.storage.from('case-files').download(photoPath)).error);
check('administrator can download the legacy photo', !(await adm.storage.from('case-files').download(photoPath)).error);

console.log('4. forward, DEFAULT mode (sensitive files must stay untouched)');
const dry = run('scripts/redact-legacy-files.mjs', {});
check('dry run: 1 to rename, 3 sensitive skipped, prints no names', /to rename: 1, sensitive skipped: 3 \(dry run\)/.test(dry) && !dry.includes(NAME), dry);
run('scripts/redact-legacy-files.mjs', { APPLY: '1' });
const afterDefault = await snapshot();
const sens = new Set(sensitiveIds());
const pick = (s, ids) => ({
  attachments: s.attachments.filter((a) => ids.has(a.id)),
  objects: Object.fromEntries(Object.entries(s.objects).filter(([k]) => s.attachments.some((a) => ids.has(a.id) && a.storage_path === k) || before.attachments.some((a) => ids.has(a.id) && a.storage_path === k))),
  history: s.history.filter((h) => ids.has(h.data.attachment_id) || h.data.category === 'photo'),
  audit: s.audit.filter((l) => ids.has((l.new_data ?? l.old_data).id) || (l.new_data ?? l.old_data).category === 'photo'),
});
check('sensitive attachment rows identical', JSON.stringify(pick(afterDefault, sens).attachments) === JSON.stringify(pick(before, sens).attachments));
check('sensitive storage objects identical (names and contents)', JSON.stringify(pick(afterDefault, sens).objects) === JSON.stringify(pick(before, sens).objects));
check('sensitive history rows identical', JSON.stringify(pick(afterDefault, sens).history) === JSON.stringify(pick(before, sens).history));
check('sensitive audit rows identical, none added', JSON.stringify(pick(afterDefault, sens).audit) === JSON.stringify(pick(before, sens).audit));
const stl = afterDefault.attachments.find((a) => a.category === 'scan');
check('the legacy 3D file was renamed', /\/[0-9a-f-]{36}\.stl$/.test(stl.storage_path) && stl.file_name === 'scan_upper.stl', stl.file_name);
const delStl = afterDefault.history.filter((h) => h.data.category === 'scan' && !h.data.attachment_id);
check('deleted 3D file: name scrubbed in history', afterDefault.history.filter((h) => h.data.category === 'scan').every((h) => !String(h.data.file_name).includes(NAME)), delStl);

console.log('5. forward with INCLUDE_SENSITIVE=1 (explicit opt-in)');
const inc = run('scripts/redact-legacy-files.mjs', { APPLY: '1', INCLUDE_SENSITIVE: '1' });
check('prints no names', !inc.includes(NAME));
check('no original name left in attachments, history, audit or storage', occurrences() === 0, occurrences());
const afterAll = await snapshot();
check('file contents unchanged (same set of SHA-256)', JSON.stringify(Object.values(afterAll.objects).sort()) === JSON.stringify(Object.values(before.objects).sort()));
const p2 = afterAll.attachments.find((a) => a.category === 'photo');
const { data: signed } = await adm.storage.from('case-files').createSignedUrl(p2.storage_path, 60);
check('signed URL contains no original name', !signed.signedUrl.includes(NAME) && !/smile/i.test(signed.signedUrl));
check('technician still cannot download the photo', !!(await cad.storage.from('case-files').download(p2.storage_path)).error);
const again = run('scripts/redact-legacy-files.mjs', { APPLY: '1', INCLUDE_SENSITIVE: '1' });
check('forward is idempotent', /with original names in storage path: 0/.test(again), again);
check('redaction/restore functions not callable by app users',
  !!(await adm.rpc('redact_legacy_file_names', { p_include_sensitive: true })).error &&
  !!(await adm.rpc('restore_legacy_file_records', { p_attachments: [], p_history: [], p_audit: [] })).error);

console.log('6. reverse from the decrypted backup');
const plain = path.join(WORK_DIR, 'backup.json');
fs.writeFileSync(plain, execFileSync('age', ['-d', '-i', keyFile, path.join(outDir, enc)]), { mode: 0o600 });
try {
  const rdry = run('scripts/reverse-legacy-file-names.mjs', { BACKUP_JSON: plain });
  check('reverse dry run: 4 objects to move back, prints no names', /objects to move back: 4,/.test(rdry) && !rdry.includes(NAME), rdry);
  const rrun = run('scripts/reverse-legacy-file-names.mjs', { BACKUP_JSON: plain, APPLY: '1' });
  check('reverse prints no names', !rrun.includes(NAME));
  const after = await snapshot();
  check('storage objects: original names and identical contents', JSON.stringify(after.objects) === JSON.stringify(before.objects), { before: Object.keys(before.objects).length, after: Object.keys(after.objects).length });
  check('attachment rows identical to before (all columns)', JSON.stringify(after.attachments) === JSON.stringify(before.attachments));
  check('file history rows identical to before', JSON.stringify(after.history) === JSON.stringify(before.history));
  const beforeIds = new Set(before.audit.map((l) => l.id));
  check('pre-existing audit rows identical to before', JSON.stringify(after.audit.filter((l) => beforeIds.has(l.id))) === JSON.stringify(before.audit));
  const extra = after.audit.filter((l) => !beforeIds.has(l.id));
  console.log(`    (audit rows written by the redaction and the reversal, kept as a record: ${extra.length})`);
  const { data: dl, error: dlErr } = await adm.storage.from('case-files').download(photoPath);
  check('administrator downloads the photo at its original path', !dlErr && sha(Buffer.from(await dl.arrayBuffer())) === before.objects[photoPath], dlErr?.message);
  const rag = run('scripts/reverse-legacy-file-names.mjs', { BACKUP_JSON: plain, APPLY: '1' });
  check('reverse is idempotent', /objects to move back: 0, rows to relabel: 0/.test(rag), rag);
} finally {
  fs.rmSync(plain, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
}
check('decrypted backup removed', !fs.existsSync(plain));

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
