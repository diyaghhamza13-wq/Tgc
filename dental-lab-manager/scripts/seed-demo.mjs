#!/usr/bin/env node
/**
 * Creates the demo laboratory used for store review (default code DEMO2026)
 * with clearly fictional employees, doctors and patients, and a few cases at
 * different production stages.
 *
 * It uses only the public API (edge functions + RPCs) exactly like the app,
 * so every business rule and permission is applied. It only ever creates a
 * NEW laboratory: it stops before writing anything if the lab code exists.
 *
 * PIN: if PIN is not given, a random 8-digit PIN is generated. The PIN is never
 * printed: it is written once to a private file (mode 600) outside the project,
 * whose path is printed instead. Delete that file after reading it.
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... [FUNCTIONS_URL=...] [LAB_CODE=DEMO2026] [PIN=<8 digits>] \
 *   [PIN_FILE=/path/outside/repo] node scripts/seed-demo.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;
const FN = process.env.FUNCTIONS_URL ?? `${URL}/functions/v1`;
const LAB = (process.env.LAB_CODE ?? 'DEMO2026').trim().toUpperCase();
if (!ANON) throw new Error('SUPABASE_ANON_KEY is required');

function generatePin() {
  for (;;) {
    const pin = String(randomInt(0, 100_000_000)).padStart(8, '0');
    if (!/^(\d)\1+$/.test(pin)) return pin; // reject 00000000, 11111111, ...
  }
}
const PIN = process.env.PIN ?? generatePin();
if (!/^\d{8}$/.test(PIN)) throw new Error('PIN must be exactly 8 digits');

// Safety: never touch an existing laboratory. Read-only check before any write.
{
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: existing, error } = await anon.rpc('get_lab_login_info', { p_code: LAB });
  if (error) throw new Error(`lab code check failed: ${error.message}`);
  if (existing) throw new Error(`Laboratory ${LAB} already exists. Nothing was changed.`);
}

// The PIN is never printed. A generated PIN is saved to a private file BEFORE
// anything is created, so it is not lost if the script stops halfway.
if (!process.env.PIN) {
  const file = process.env.PIN_FILE ?? join(tmpdir(), `dlm-${LAB}-pin.txt`);
  writeFileSync(file, `${PIN}\n`, { mode: 0o600, flag: 'wx' }); // 'wx': never overwrite an existing file
  console.log(`PIN written to ${file} (read it once, then delete the file)`);
}

async function fn(name, body, token) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token ?? ANON}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function as(code) {
  const { session } = await fn('employee-login', { lab_code: LAB, employee_code: code, pin: PIN });
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  await c.auth.setSession(session);
  c.token = session.access_token;
  return c;
}
const ok = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

const reg = await fn('register-lab', {
  lab: { code: LAB, name: 'Demo Dental Lab' }, // no phone / address: optional fields left empty
  admin: { full_name: 'Demo Administrator', code: 'ADMIN01', pin: PIN, preferred_language: 'en' },
});
console.log('lab created', LAB, reg.lab_id);
const admin = await as('ADMIN01');
const roles = ok(await admin.from('roles').select('id, code'));
const deps = ok(await admin.from('departments').select('id, code'));
const R = (c) => roles.find((r) => r.code === c).id;
const D = (c) => deps.find((d) => d.code === c).id;

const staff = [
  ['REC01', 'Demo Receptionist', 'RECEPTION', 'RECEPTION', 'Demo reception'],
  ['CAD01', 'Demo CAD Designer', 'CAD', 'CAD', 'Demo CAD design'],
  ['CAM01', 'Demo CAM Technician', 'CAM', 'CAM', 'Demo milling / CAM'],
  ['CER01', 'Demo Ceramist', 'CERAMIST', 'CERAMIC', 'Demo ceramics'],
  ['FIN01', 'Demo Finishing Technician', 'FINISHING', 'FINISHING', 'Demo finishing'],
  ['QC01', 'Demo QC Inspector', 'QC', 'QC', 'Demo quality control'],
];
const ids = {};
for (const [code, name, role, dep, spec] of staff) {
  const r = await fn('manage-employee', {
    action: 'create',
    employee: { code, full_name: name, role_id: R(role), department_id: D(dep), specialty: spec, pin: PIN },
  }, admin.token);
  ids[code] = r.employee_id;
}
console.log('employees created');

const rec = await as('REC01');
const docs = ok(await rec.from('doctors').insert(
  ['A', 'B', 'C', 'D'].map((x) => ({ lab_id: reg.lab_id, full_name: `Dr. Demo ${x}`, clinic_name: `Demo Clinic ${x}` })),
).select());
const types = ok(await rec.from('restoration_types').select('id, code'));
const mats = ok(await rec.from('materials').select('id, code'));
const T = (c) => types.find((x) => x.code === c).id;
const M = (c) => mats.find((x) => x.code === c).id;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const cases = [
  { patient: 'Demo Patient 1', doc: 1, type: 'ANATOMIC_CROWN', mat: 'ZIRCONIA', teeth: [26], due: 3, advance: 0 },
  { patient: 'Demo Patient 2', doc: 2, type: 'VENEER', mat: 'EMAX', teeth: [11, 21], due: 4, advance: 1 },
  { patient: 'Demo Patient 3', doc: 0, type: 'BRIDGE', mat: 'ZIRCONIA', teeth: [16, 17], bridge: true, due: 2, advance: 2, start: true, prio: 'urgent' },
  { patient: 'Demo Patient 4', doc: 3, type: 'CUSTOM_ABUTMENT', mat: 'TITANIUM', teeth: [46], implant: true, due: 1, advance: 5 },
  { patient: 'Demo Patient 5', doc: 0, type: 'FULL_CONTOUR_CROWN', mat: 'ZIRCONIA', teeth: [36], due: -1, advance: 0, prio: 'very_urgent' },
];
const order = [['CAD01', 'CAD Design'], ['CAM01', 'Milling / CAM'], ['CER01', 'Ceramics'], ['FIN01', 'Finishing']];
for (const c of cases) {
  const teeth = c.teeth.map((n) => ({ tooth_number: n, restoration_index: 0, bridge_group: c.bridge ? 1 : null, is_implant: !!c.implant }));
  const caseId = ok(await rec.rpc('create_case', { p: {
    patient: { full_name: c.patient }, doctor_id: docs[c.doc].id, due_date: day(c.due), priority: c.prio ?? 'normal',
    assigned_technician_id: ids.CER01, shade: 'A2', notes: c.type === 'BRIDGE' ? 'Zirconia Monolithic – A2' : null,
    restorations: [{ restoration_type_id: T(c.type), material_id: M(c.mat), shade: 'A2' }], teeth,
    implants: c.implant ? [{ tooth_number: c.teeth[0], brand_name: 'Straumann', system_name: 'BLT', connection: 'CrossFit', platform: 'RC', diameter_mm: 4.1, length_mm: 10 }] : [],
  } }));
  const stages = ok(await rec.from('case_workflow_stages').select('id, name').eq('case_id', caseId));
  const S = (n) => stages.find((s) => s.name === n).id;
  for (let i = 0; i < Math.min(c.advance, 4); i++) {
    const cl = await as(order[i][0]);
    ok(await cl.rpc('start_stage', { p_stage_id: S(order[i][1]) }));
    ok(await cl.rpc('complete_and_transfer', { p_stage_id: S(order[i][1]), p_notes: null }));
  }
  if (c.start) {
    const cl = await as(order[c.advance][0]);
    ok(await cl.rpc('start_stage', { p_stage_id: S(order[c.advance][1]) }));
  }
  if (c.advance >= 5) {
    const qc = await as('QC01');
    ok(await qc.rpc('qc_decision', { p_stage_id: S('Quality Control'), p_result: 'passed' }));
  }
}
console.log(`seeded ${cases.length} cases. Log in with lab ${LAB} and any employee code above.`);
