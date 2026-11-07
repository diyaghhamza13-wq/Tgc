#!/usr/bin/env node
/**
 * Creates a demo laboratory (LAB001) with the employees from the design mockups
 * and a few cases at different production stages.
 *
 * It uses only the public API (edge functions + RPCs) exactly like the app,
 * so every business rule and permission is applied. For development/demo only.
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... [FUNCTIONS_URL=...] [LAB_CODE=LAB001] [PIN=1234] node scripts/seed-demo.mjs
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;
const FN = process.env.FUNCTIONS_URL ?? `${URL}/functions/v1`;
const LAB = process.env.LAB_CODE ?? 'LAB001';
const PIN = process.env.PIN ?? '1234';
if (!ANON) throw new Error('SUPABASE_ANON_KEY is required');

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
  lab: { code: LAB, name: 'Dental Lab', city: 'Casablanca', country: 'Maroc', phone: '+212 5 22 00 00 00' },
  admin: { full_name: 'Admin', code: 'ADMIN01', pin: PIN, preferred_language: 'ar' },
});
console.log('lab created', reg.lab_id);
const admin = await as('ADMIN01');
const roles = ok(await admin.from('roles').select('id, code'));
const deps = ok(await admin.from('departments').select('id, code'));
const R = (c) => roles.find((r) => r.code === c).id;
const D = (c) => deps.find((d) => d.code === c).id;

const staff = [
  ['REC01', 'Sara Benali', 'RECEPTION', 'RECEPTION', 'Reception'],
  ['CAD01', 'Youssef Alami', 'CAD', 'CAD', 'CAD Designer'],
  ['CAM01', 'Amine Tazi', 'CAM', 'CAM', 'Milling / CAM'],
  ['CER01', 'Hamza', 'CERAMIST', 'CERAMIC', 'Ceramist'],
  ['FIN01', 'Nadia Chraibi', 'FINISHING', 'FINISHING', 'Finishing'],
  ['QC01', 'Omar Fassi', 'QC', 'QC', 'Quality Control'],
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
  ['Dr. Idrissi', 'Dr. El Amrani', 'Dr. Naji', 'Dr. El Fahim'].map((n) => ({ lab_id: reg.lab_id, full_name: n, clinic_name: `Cabinet ${n.split(' ').pop()}` })),
).select());
const types = ok(await rec.from('restoration_types').select('id, code'));
const mats = ok(await rec.from('materials').select('id, code'));
const T = (c) => types.find((x) => x.code === c).id;
const M = (c) => mats.find((x) => x.code === c).id;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const cases = [
  { patient: 'أحمد بن علي', doc: 1, type: 'ANATOMIC_CROWN', mat: 'ZIRCONIA', teeth: [26], due: 3, advance: 0 },
  { patient: 'فاطمة الزهراء', doc: 2, type: 'VENEER', mat: 'EMAX', teeth: [11, 21], due: 4, advance: 1 },
  { patient: 'يوسف المقري', doc: 0, type: 'BRIDGE', mat: 'ZIRCONIA', teeth: [16, 17], bridge: true, due: 2, advance: 2, start: true, prio: 'urgent' },
  { patient: 'محمد أمين', doc: 3, type: 'CUSTOM_ABUTMENT', mat: 'TITANIUM', teeth: [46], implant: true, due: 1, advance: 5 },
  { patient: 'خديجة العلوي', doc: 0, type: 'FULL_CONTOUR_CROWN', mat: 'ZIRCONIA', teeth: [36], due: -1, advance: 0, prio: 'very_urgent' },
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
console.log(`seeded ${cases.length} cases. Log in with lab ${LAB}, any employee code above, PIN ${PIN}`);
