#!/usr/bin/env node
/**
 * LOCAL-ONLY test of the legacy-file protections (migration 20261114155851,
 * sections 7–8) and of scripts/redact-legacy-files.mjs. Never run against
 * production: it disables a trigger to create pre-Phase-1 style attachments.
 *
 * Needs: local stack with all migrations, local edge functions, a lab created
 * by scripts/seed-demo.mjs (LAB_CODE, PIN_FILE), psql.
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… FUNCTIONS_URL=…
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres LAB_CODE=… PIN_FILE=…
 *   node scripts/tests/legacy-files-local-test.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SRK, FUNCTIONS_URL: FN, DB_URL, LAB_CODE, PIN_FILE } = process.env;
if (!/127\.0\.0\.1|localhost/.test(URL ?? '') || !/127\.0\.0\.1|localhost/.test(DB_URL ?? '')) {
  console.error('refusing to run: local URLs only');
  process.exit(2);
}
const PIN = fs.readFileSync(PIN_FILE, 'utf8').trim();
const NAME = 'Fatima_Zahra_Legacy'; // fictional identifying name used in legacy file names
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== undefined ? ' — ' + JSON.stringify(d) : ''}`); };
const sql = (q) => execFileSync('psql', [DB_URL, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const svc = { apikey: SRK, Authorization: `Bearer ${SRK}` };

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

console.log('1. create pre-Phase-1 style attachments (trigger disabled locally)');
const legacy = [
  ['photo', `${NAME}_smile.jpg`, 'image/jpeg'],
  ['other', `${NAME} video.mp4`, 'video/mp4'],
  ['prescription', `order ${NAME}.pdf`, 'application/pdf'],
  ['scan', `${NAME} upper.stl`, 'model/stl'],
];
const paths = [];
for (const [category, file, mime] of legacy) {
  const path = `${lab}/${kase}/${crypto.randomUUID()}-${file.replace(/[^\w.\-]+/g, '_')}`;
  const up = await fetch(`${URL}/storage/v1/object/case-files/${path}`, { method: 'POST', headers: { ...svc, 'Content-Type': mime }, body: `content of ${category}` });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  paths.push(path);
  sql(`alter table public.attachments disable trigger attachments_production_only;
       insert into public.attachments (lab_id, case_id, category, file_name, mime_type, size_bytes, storage_path, uploaded_by)
       values ('${lab}', '${kase}', '${category}', '${file}', '${mime}', 10, '${path}', '${admin}');
       alter table public.attachments enable trigger attachments_production_only;`);
}
// a legacy file that was deleted earlier: its name survives only in history/audit
sql(`alter table public.attachments disable trigger attachments_production_only;
     insert into public.attachments (lab_id, case_id, category, file_name, size_bytes, storage_path, uploaded_by)
     values ('${lab}', '${kase}', 'photo', '${NAME}_deleted.png', 1, '${lab}/${kase}/${crypto.randomUUID()}-${NAME}_deleted.png', '${admin}');
     alter table public.attachments enable trigger attachments_production_only;
     delete from public.attachments where file_name = '${NAME}_deleted.png';`);
const occurrences = () => Number(sql(`select
   (select count(*) from public.attachments where file_name ilike '%${NAME}%' or storage_path ilike '%${NAME}%')
 + (select count(*) from public.case_history where data::text ilike '%${NAME}%')
 + (select count(*) from public.audit_logs where coalesce(old_data::text,'') || coalesce(new_data::text,'') ilike '%${NAME}%')
 + (select count(*) from storage.objects where name ilike '%${NAME}%')`));
check('original names present before redaction', occurrences() > 0, occurrences());

console.log('2. access before redaction (section 7)');
const adm = await login('ADMIN01');
const cad = await login('CAD01');
const { data: aList } = await adm.from('attachments').select('category, storage_path').eq('case_id', kase);
const { data: cList } = await cad.from('attachments').select('category, storage_path').eq('case_id', kase);
check('administrator sees all 4 legacy files', aList.length === 4, aList.length);
check('technician sees only the legacy 3D file', cList.length === 1 && cList[0].category === 'scan', cList);
const photoPath = paths[0];
const { error: cadDl } = await cad.storage.from('case-files').download(photoPath);
check('technician cannot download the legacy photo', !!cadDl);
const { data: admDl, error: admDlErr } = await adm.storage.from('case-files').download(photoPath);
check('administrator can download the legacy photo', !admDlErr && (await admDl.text()) === 'content of photo', admDlErr?.message);

console.log('3. redaction script (dry run, then apply)');
const env = { ...process.env, SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SRK };
const dry = execFileSync('node', ['scripts/redact-legacy-files.mjs'], { env }).toString();
check('dry run changes nothing', occurrences() > 0 && /dry run/.test(dry), dry);
check('dry run prints no names', !dry.includes(NAME));
const run = execFileSync('node', ['scripts/redact-legacy-files.mjs'], { env: { ...env, APPLY: '1' } }).toString();
check('apply prints no names', !run.includes(NAME));
check('no original name left in attachments, history, audit or storage', occurrences() === 0, occurrences());
const again = execFileSync('node', ['scripts/redact-legacy-files.mjs'], { env: { ...env, APPLY: '1' } }).toString();
check('second run finds nothing to rename (idempotent)', /with original names in storage path: 0/.test(again), again);

console.log('4. after redaction');
const { data: aAfter } = await adm.from('attachments').select('category, file_name, storage_path').eq('case_id', kase).order('category');
check('labels are technical', JSON.stringify(aAfter.map((a) => a.file_name).sort()) === JSON.stringify(['other.mp4', 'photo.jpg', 'prescription.pdf', 'scan_upper.stl']), aAfter.map((a) => a.file_name));
check('storage paths are anonymous', aAfter.every((a) => /\/[0-9a-f-]{36}\.[a-z0-9]+$/.test(a.storage_path)));
const photo = aAfter.find((a) => a.category === 'photo');
const { data: signed } = await adm.storage.from('case-files').createSignedUrl(photo.storage_path, 60);
check('signed download URL contains no original name', !!signed?.signedUrl && !signed.signedUrl.includes(NAME) && !/smile/i.test(signed.signedUrl));
const body = await (await fetch(signed.signedUrl)).text();
check('file content unchanged and downloadable', body === 'content of photo', body);
const { error: cadAfter } = await cad.storage.from('case-files').download(photo.storage_path);
check('technician still cannot download it', !!cadAfter);
const stl = aAfter.find((a) => a.category === 'scan');
const { data: stlDl, error: stlErr } = await cad.storage.from('case-files').download(stl.storage_path);
check('technician can download the legacy 3D file', !stlErr && (await stlDl.text()) === 'content of scan', stlErr?.message);
check('old storage objects no longer exist', Number(sql(`select count(*) from storage.objects where name like '%-%${NAME.slice(0, 6)}%'`)) === 0);
const { error: rpcAsUser } = await adm.rpc('redact_legacy_file_names');
check('redaction functions not callable by app users', !!rpcAsUser);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
