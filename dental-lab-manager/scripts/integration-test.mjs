#!/usr/bin/env node
/**
 * End-to-end integration test for the Dental Lab Manager backend.
 *
 * Exercises the real Supabase API (Auth, PostgREST + RLS, RPCs, Storage and the
 * Edge Functions) as several employees of two independent laboratories.
 *
 * Usage:
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... \
 *   [FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1] node scripts/integration-test.mjs
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;
const FN = process.env.FUNCTIONS_URL ?? `${URL}/functions/v1`;
if (!ANON) {
  console.error('SUPABASE_ANON_KEY is required');
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

async function fn(name, body, token) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${token ?? ANON}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function newClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function clientFor(session) {
  const c = newClient();
  const { error } = await c.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw error;
  return c;
}

async function login(lab, code, pin) {
  const r = await fn('employee-login', { lab_code: lab, employee_code: code, pin });
  if (r.status !== 200) throw new Error(`login ${code} failed: ${JSON.stringify(r.body)}`);
  return clientFor(r.body.session);
}

const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
const LAB = `T${suffix}`;
const LAB2 = `X${suffix}`;
const PIN = '135790';

async function main() {
  section('1. Laboratory registration & login lookup');
  const reg = await fn('register-lab', {
    lab: { code: LAB, name: 'Test Dental Lab', city: 'Rabat' },
    admin: { full_name: 'Admin Test', code: 'ADMIN01', pin: PIN },
  });
  check('register-lab returns 201 + session', reg.status === 201 && reg.body?.session?.access_token, reg.body);
  const dup = await fn('register-lab', {
    lab: { code: LAB, name: 'Dup' },
    admin: { full_name: 'X Y', code: 'ADMIN01', pin: PIN },
  });
  check('duplicate lab code rejected (409)', dup.status === 409, dup);
  const badPin = await fn('register-lab', {
    lab: { code: `Z${suffix}`, name: 'Bad' },
    admin: { full_name: 'X Y', code: 'ADMIN01', pin: '12' },
  });
  check('weak PIN rejected', badPin.status === 400 && badPin.body.error === 'invalid_pin', badPin);

  const anon = newClient();
  const { data: info } = await anon.rpc('get_lab_login_info', { p_code: LAB.toLowerCase() });
  check('anon lab lookup returns lab + employee list', info?.name === 'Test Dental Lab' && info.employees.length === 1, info);
  const { data: none } = await anon.rpc('get_lab_login_info', { p_code: 'NOPE999' });
  check('unknown lab returns null', none === null);
  const { data: anonCases, error: anonErr } = await anon.from('cases').select('id');
  check('anon cannot read cases', !!anonErr || (anonCases ?? []).length === 0, anonErr?.message);
  const { error: anonEmpErr } = await anon.from('employee_credentials').select('*');
  check('anon cannot read credentials', !!anonEmpErr);

  section('2. Authentication rules');
  const wrong = await fn('employee-login', { lab_code: LAB, employee_code: 'ADMIN01', pin: '000000' });
  check('wrong PIN -> 401 with attempts_left', wrong.status === 401 && wrong.body.attempts_left === 4, wrong.body);
  const admin = await login(LAB, 'admin01', PIN);
  const { data: perms } = await admin.rpc('my_permissions');
  check('admin has every permission', perms?.includes('employees.manage') && perms.length === 16, perms);
  const { data: adminCreds, error: credErr } = await admin.from('employee_credentials').select('*');
  check('even admin cannot read PIN hashes', !!credErr || (adminCreds ?? []).length === 0);

  section('3. Employee management (edge function)');
  const { data: roles } = await admin.from('roles').select('id, code');
  const { data: deps } = await admin.from('departments').select('id, code');
  const role = (c) => roles.find((r) => r.code === c).id;
  const dep = (c) => deps.find((d) => d.code === c).id;
  const adminToken = (await admin.auth.getSession()).data.session.access_token;
  const staff = [
    ['REC01', 'Sara Reception', 'RECEPTION', 'RECEPTION'],
    ['CAD01', 'Youssef CAD', 'CAD', 'CAD'],
    ['CAM01', 'Amine CAM', 'CAM', 'CAM'],
    ['CER01', 'Hamza Ceramist', 'CERAMIST', 'CERAMIC'],
    ['FIN01', 'Nadia Finishing', 'FINISHING', 'FINISHING'],
    ['QC01', 'Omar QC', 'QC', 'QC'],
  ];
  const ids = {};
  for (const [code, name, r, d] of staff) {
    const res = await fn('manage-employee', {
      action: 'create',
      employee: { code, full_name: name, role_id: role(r), department_id: dep(d), pin: PIN },
    }, adminToken);
    ids[code] = res.body?.employee_id;
    check(`create ${code}`, res.status === 201, res.body);
  }
  const dupEmp = await fn('manage-employee', {
    action: 'create',
    employee: { code: 'CAD01', full_name: 'Dup', role_id: role('CAD'), pin: PIN },
  }, adminToken);
  check('duplicate employee code rejected', dupEmp.status === 409, dupEmp.body);

  const rec = await login(LAB, 'REC01', PIN);
  const cad = await login(LAB, 'CAD01', PIN);
  const cam = await login(LAB, 'CAM01', PIN);
  const cer = await login(LAB, 'CER01', PIN);
  const fin = await login(LAB, 'FIN01', PIN);
  const qc = await login(LAB, 'QC01', PIN);
  const cadToken = (await cad.auth.getSession()).data.session.access_token;
  const escalate = await fn('manage-employee', {
    action: 'create',
    employee: { code: 'HACK1', full_name: 'Hacker', role_id: role('ADMIN'), pin: PIN },
  }, cadToken);
  check('non-admin cannot create employees', escalate.status === 403, escalate.body);
  const { data: selfPromote } = await cad.from('employees').update({ role_id: role('ADMIN') }).eq('id', ids.CAD01).select();
  check('technician cannot promote themselves', (selfPromote ?? []).length === 0);

  section('4. Case creation with prescription');
  const { data: doctor, error: docErr } = await rec.from('doctors')
    .insert({ lab_id: info.id, full_name: 'Dr. Idrissi', clinic_name: 'Clinique Atlas' })
    .select().single();
  check('reception creates doctor', !docErr && doctor?.id, docErr?.message);
  const { data: types } = await rec.from('restoration_types').select('id, code');
  const { data: mats } = await rec.from('materials').select('id, code');
  const { data: brands } = await rec.from('implant_brands').select('id, name');
  check('14 restoration types / 8 materials seeded', types.length === 14 && mats.length === 8);
  const t = (c) => types.find((x) => x.code === c).id;
  const m = (c) => mats.find((x) => x.code === c).id;
  const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const prescription = {
    clinic_order_ref: 'ORD-4471',
    doctor_id: doctor.id,
    assigned_technician_id: ids.CER01,
    due_date: due,
    priority: 'urgent',
    notes: 'Zirconia monolithic A2',
    restorations: [
      { restoration_type_id: t('BRIDGE'), material_id: m('ZIRCONIA'), shade: 'A2', translucency: 'HT' },
      { restoration_type_id: t('CUSTOM_ABUTMENT'), material_id: m('TITANIUM') },
    ],
    teeth: [
      { tooth_number: 14, bridge_group: 1, restoration_index: 0 },
      { tooth_number: 15, bridge_group: 1, restoration_index: 0, is_missing: true },
      { tooth_number: 16, bridge_group: 1, restoration_index: 0 },
      { tooth_number: 36, is_implant: true, restoration_index: 1 },
    ],
    implants: [{
      tooth_number: 36, brand_id: brands.find((b) => b.name === 'Straumann').id, brand_name: 'Straumann',
      system_name: 'BLT', connection: 'CrossFit', platform: 'RC', diameter_mm: 4.1, length_mm: 10,
      screw_channel: 'angulated', angulation_degrees: 20,
    }],
  };
  const { data: badBridge, error: bbErr } = await rec.rpc('create_case', {
    p: { ...prescription, teeth: [{ tooth_number: 14, bridge_group: 1 }, { tooth_number: 44, bridge_group: 1 }] },
  });
  check('cross-arch bridge rejected', !!bbErr && bbErr.message.includes('invalid_bridge'), bbErr?.message ?? badBridge);
  const { error: badTooth } = await rec.rpc('create_case', { p: { ...prescription, teeth: [{ tooth_number: 19 }], implants: [] } });
  check('invalid FDI tooth rejected', !!badTooth);
  const { error: cadCreate } = await cad.rpc('create_case', { p: prescription });
  check('CAD technician cannot create cases', !!cadCreate && cadCreate.message.includes('permission_denied'));
  const { data: caseId, error: createErr } = await rec.rpc('create_case', { p: prescription });
  check('reception creates case', !createErr && caseId, createErr?.message);

  const { data: kase } = await rec.from('cases').select('*, current:case_workflow_stages!cases_current_stage_fk(name, status)').eq('id', caseId).single();
  check('case number generated', /^DL-\d{6}$/.test(kase.case_number), kase.case_number);
  check('reception auto-completed, CAD is current', kase.current?.name === 'CAD Design' && kase.status === 'new', kase);
  const { data: teeth } = await rec.from('case_teeth').select('*').eq('case_id', caseId).order('tooth_number');
  check('4 teeth stored with bridge + implant', teeth.length === 4 && teeth.filter((x) => x.bridge_group === 1).length === 3 && teeth.find((x) => x.tooth_number === 36).is_implant);
  const { data: stages } = await rec.from('case_workflow_stages').select('*').eq('case_id', caseId).order('position');
  check('8 workflow stages instantiated', stages.length === 8);
  const S = (name) => stages.find((s) => s.name === name);
  check('chosen ceramist pre-assigned to Ceramics', S('Ceramics').assigned_employee_id === ids.CER01);

  section('4b. Production-only cases (no patient data)');
  check('case keeps the clinic order reference', kase.clinic_order_ref === 'ORD-4471', kase.clinic_order_ref);
  check('new case has no patient link', kase.patient_id === null, kase.patient_id);
  const { error: withPatient } = await rec.rpc('create_case', { p: { ...prescription, patient: { full_name: 'Real Name' } } });
  check('create_case rejects patient data', !!withPatient && withPatient.message.includes('patient_data_not_accepted'), withPatient?.message);
  const { error: withPatientId } = await rec.rpc('create_case', { p: { ...prescription, patient_id: crypto.randomUUID() } });
  check('create_case rejects a patient id', !!withPatientId && withPatientId.message.includes('patient_data_not_accepted'), withPatientId?.message);
  const { error: longRef } = await rec.rpc('create_case', { p: { ...prescription, clinic_order_ref: 'X'.repeat(41) } });
  check('clinic order reference limited to 40 characters', !!longRef && longRef.message.includes('invalid_clinic_order_ref'), longRef?.message);
  const { error: patSel } = await admin.from('patients').select('id').limit(1);
  check('patients table not readable by the app', !!patSel, patSel);
  const { error: patIns } = await admin.from('patients').insert({ lab_id: info.id, full_name: 'Someone' });
  check('patients table not writable by the app', !!patIns);
  const { error: setPat } = await admin.from('cases').update({ patient_id: null }).eq('id', caseId);
  check('cases.patient_id not writable by the app', !!setPat);
  const { data: refUpd, error: refErr } = await admin.from('cases').update({ clinic_order_ref: 'ORD-4472' }).eq('id', caseId).select('clinic_order_ref');
  check('clinic order reference editable', !refErr && refUpd?.[0]?.clinic_order_ref === 'ORD-4472', refErr?.message);
  await admin.from('cases').update({ clinic_order_ref: 'ORD-4471' }).eq('id', caseId);
  const meta = (category, ext, mime) => ({
    lab_id: info.id, case_id: caseId, category, file_name: `f.${ext}`, mime_type: mime, size_bytes: 1,
    storage_path: `${info.id}/${caseId}/${crypto.randomUUID()}.${ext}`, uploaded_by: ids.REC01,
  });
  for (const [label, row] of [
    ['photo category', meta('photo', 'stl', 'model/stl')],
    ['CBCT category', meta('cbct', 'dcm', 'application/octet-stream')],
    ['prescription category', meta('prescription', 'stl', 'model/stl')],
    ['DICOM mime type', meta('scan', 'dcm', 'application/dicom')],
    ['JPEG image', meta('scan', 'jpg', 'image/jpeg')],
    ['PDF', meta('other', 'pdf', 'application/pdf')],
    ['image mime with .stl name', meta('scan', 'stl', 'image/png')],
  ]) {
    const { error } = await rec.from('attachments').insert(row);
    check(`new upload rejected: ${label}`, !!error && error.message.includes('file_type_not_allowed'), error?.message);
  }
  const { error: namedObj } = await rec.storage.from('case-files').upload(`${info.id}/${caseId}/${crypto.randomUUID()}-Dupont.stl`, new Blob(['solid x']), { contentType: 'model/stl' });
  check('storage rejects object names with original file names', !!namedObj);
  const { error: jpgObj } = await rec.storage.from('case-files').upload(`${info.id}/${caseId}/${crypto.randomUUID()}.jpg`, new Blob(['x']), { contentType: 'image/jpeg' });
  check('storage rejects photo uploads', !!jpgObj);
  const dcmPath = `${info.id}/${caseId}/${crypto.randomUUID()}.dcm`;
  const { error: dcmObj } = await rec.storage.from('case-files').upload(dcmPath, new Blob(['3shape mesh']), { contentType: 'application/octet-stream' });
  const { error: dcmMeta } = await rec.from('attachments').insert({ ...meta('scan', 'dcm', 'application/octet-stream'), storage_path: dcmPath, file_name: 'Lower Jaw Scan.dcm' });
  check('3Shape .dcm mesh accepted', !dcmObj && !dcmMeta, dcmObj?.message ?? dcmMeta?.message);
  const { data: dcmRow } = await rec.from('attachments').select('file_name').eq('storage_path', dcmPath).single();
  check('3Shape file name reduced to technical words', dcmRow?.file_name === 'scan_lower_scan.dcm', dcmRow);

  section('5. Production workflow & permissions');
  const { data: cadStats } = await cad.rpc('dashboard_stats');
  check('CAD sees the case in My Tasks', cadStats.my_tasks === 1, cadStats);
  const { data: cadNotes } = await cad.from('notifications').select('*').eq('case_id', caseId);
  check('CAD department notified (case_arrived)', cadNotes.some((n) => n.type === 'case_arrived'), cadNotes);
  const { error: camSteal } = await cam.rpc('complete_and_transfer', { p_stage_id: S('CAD Design').id });
  check('Milling cannot complete the CAD stage', !!camSteal && camSteal.message.includes('not_allowed'), camSteal?.message);
  const { error: statusHack } = await cad.from('cases').update({ status: 'delivered' }).eq('id', caseId);
  check('status column not directly writable', !!statusHack);
  const { error: stageHack } = await cad.from('case_workflow_stages').update({ status: 'completed' }).eq('id', S('CAD Design').id);
  check('workflow stages not directly writable', !!stageHack);

  check('CAD can act on stage', (await cad.rpc('can_act_on_stage', { p_stage_id: S('CAD Design').id })).data === true);
  const { error: startErr } = await cad.rpc('start_stage', { p_stage_id: S('CAD Design').id });
  check('CAD starts work (claims stage)', !startErr, startErr?.message);
  const { data: afterStart } = await cad.from('cases').select('status').eq('id', caseId).single();
  check('case is in_progress', afterStart.status === 'in_progress');

  // attachment upload to storage + metadata row
  const path = `${info.id}/${caseId}/${crypto.randomUUID()}.stl`;
  const { error: upErr } = await cad.storage.from('case-files').upload(path, new Blob(['solid test\nendsolid test\n']), { contentType: 'model/stl' });
  check('CAD uploads STL to storage', !upErr, upErr?.message);
  const { error: attErr } = await cad.from('attachments').insert({
    lab_id: info.id, case_id: caseId, stage_id: S('CAD Design').id, category: 'cad_design',
    file_name: 'Dupont_Marie_1985 upper prep 16.stl', mime_type: 'model/stl', size_bytes: 26, storage_path: path, uploaded_by: ids.CAD01,
  });
  check('attachment metadata saved', !attErr, attErr?.message);
  const { data: attRow } = await cad.from('attachments').select('file_name').eq('storage_path', path).single();
  check('stored file name keeps only technical words', attRow?.file_name === 'cad_design_upper_prep_16.stl', attRow);
  const { data: upHist } = await cad.from('case_history').select('data').eq('case_id', caseId).eq('event_type', 'file_uploaded');
  check('history has no original file name', upHist.some((h) => h.data.file_name === 'cad_design_upper_prep_16.stl') && !JSON.stringify(upHist).toLowerCase().includes('dupont'), upHist);
  const { data: dl, error: dlErr } = await cam.storage.from('case-files').download(path);
  check('Milling can download the STL', !dlErr && (await dl.text()).startsWith('solid'), dlErr?.message);
  const { error: forgedUploader } = await cam.from('attachments').insert({
    lab_id: info.id, case_id: caseId, category: 'other', file_name: 'x.stl', size_bytes: 1,
    storage_path: `${info.id}/${caseId}/${crypto.randomUUID()}.stl`, uploaded_by: ids.CAD01,
  });
  check('cannot forge attachment uploader', !!forgedUploader);
  const { data: delOther } = await cam.from('attachments').delete().eq('storage_path', path).select();
  check("cannot delete someone else's file", (delOther ?? []).length === 0);

  const { data: nextId, error: tErr } = await cad.rpc('complete_and_transfer', {
    p_stage_id: S('CAD Design').id, p_notes: 'Design approved', p_next_assignee: ids.CAM01,
  });
  check('CAD completes & transfers to Milling', !tErr && nextId === S('Milling / CAM').id, tErr?.message);
  const { error: cadAgain } = await cad.rpc('start_stage', { p_stage_id: S('CAD Design').id });
  check('completed stage cannot be restarted', !!cadAgain);
  const { data: camNotes } = await cam.from('notifications').select('type').eq('case_id', caseId);
  check('Milling technician notified', camNotes.length > 0, camNotes);

  for (const [client, name] of [[cam, 'Milling / CAM'], [cer, 'Ceramics'], [fin, 'Finishing']]) {
    const { error: e1 } = await client.rpc('start_stage', { p_stage_id: S(name).id });
    const { error: e2 } = await client.rpc('complete_and_transfer', { p_stage_id: S(name).id, p_notes: `${name} done` });
    check(`${name} start + complete`, !e1 && !e2, (e1 ?? e2)?.message);
  }
  const { data: atQc } = await qc.from('cases').select('status').eq('id', caseId).single();
  check('case is ready_for_qc', atQc.status === 'ready_for_qc');

  section('6. Quality control rejection loop');
  const { error: finQc } = await fin.rpc('qc_decision', { p_stage_id: S('Quality Control').id, p_result: 'passed' });
  check('non-QC employee cannot decide QC', !!finQc);
  const { error: noReason } = await qc.rpc('qc_decision', { p_stage_id: S('Quality Control').id, p_result: 'failed', p_reason: ' ' });
  check('QC rejection requires a reason', !!noReason);
  const { error: rejErr } = await qc.rpc('qc_decision', {
    p_stage_id: S('Quality Control').id, p_result: 'failed', p_reason: 'Shade mismatch', p_return_to_stage_id: S('Ceramics').id,
  });
  check('QC rejects back to Ceramics', !rejErr, rejErr?.message);
  const { data: st2 } = await qc.from('case_workflow_stages').select('name, status, revision_count').eq('case_id', caseId).order('position');
  const st = (n) => st2.find((x) => x.name === n);
  check('Ceramics needs_revision, Finishing reset, QC rejected',
    st('Ceramics').status === 'needs_revision' && st('Ceramics').revision_count === 1 &&
    st('Finishing').status === 'pending' && st('Quality Control').status === 'rejected', st2);
  const { data: cerNotes } = await cer.from('notifications').select('type').eq('case_id', caseId);
  check('ceramist notified of QC rejection (once)', cerNotes.filter((n) => n.type === 'qc_rejected').length === 1 && !cerNotes.some((n) => n.type === 'revision_requested'), cerNotes);
  const { data: qcRows } = await qc.from('quality_control').select('*').eq('case_id', caseId);
  check('QC record stored with reason', qcRows.length === 1 && qcRows[0].reason === 'Shade mismatch');

  for (const [client, name] of [[cer, 'Ceramics'], [fin, 'Finishing']]) {
    await client.rpc('start_stage', { p_stage_id: S(name).id });
    const { error } = await client.rpc('complete_and_transfer', { p_stage_id: S(name).id });
    check(`${name} redone`, !error, error?.message);
  }
  const { error: passErr } = await qc.rpc('qc_decision', { p_stage_id: S('Quality Control').id, p_result: 'passed', p_checklist: { fit: true, shade: true } });
  check('QC passes', !passErr, passErr?.message);
  const { data: ready } = await rec.from('cases').select('status').eq('id', caseId).single();
  check('case completed (ready for delivery)', ready.status === 'completed');
  const { data: recNotes } = await rec.from('notifications').select('type').eq('case_id', caseId);
  check('delivery staff notified ready_for_delivery', recNotes.some((n) => n.type === 'ready_for_delivery'), recNotes);

  section('7. Delivery & history');
  const { error: cadDeliver } = await cad.rpc('record_delivery', { p_case_id: caseId });
  check('technician cannot record delivery', !!cadDeliver);
  const { error: delErr } = await rec.rpc('record_delivery', { p_case_id: caseId, p_recipient: 'Dr. Idrissi', p_method: 'courier' });
  check('reception records delivery', !delErr, delErr?.message);
  const { data: done } = await rec.from('cases').select('status, delivered_at').eq('id', caseId).single();
  check('case delivered', done.status === 'delivered' && done.delivered_at);
  const { data: hist } = await rec.from('case_history').select('event_type').eq('case_id', caseId).order('created_at');
  const evs = hist.map((h) => h.event_type);
  check('history has full trail', ['created', 'transferred', 'stage_started', 'file_uploaded', 'qc_failed', 'qc_passed', 'delivered'].every((e) => evs.includes(e)), evs);
  const { data: timed } = await rec.from('case_workflow_stages').select('name, started_at, completed_at, completed_by').eq('case_id', caseId).order('position');
  check('every stage has start/completion/actor', timed.every((s) => s.started_at && s.completed_at && s.completed_by), timed);
  const { data: audit } = await admin.from('audit_logs').select('id').limit(5);
  check('admin can read audit log', (audit ?? []).length > 0);
  const { data: audit2 } = await cad.from('audit_logs').select('id').limit(5);
  check('technician cannot read audit log', (audit2 ?? []).length === 0);

  section('8. Reports');
  const today = new Date().toISOString().slice(0, 10);
  const { data: rep, error: repErr } = await admin.rpc('lab_report', { p_from: '2020-01-01', p_to: today });
  check('admin lab report', !repErr && rep.scope === 'lab' && rep.totals.delivered === 1 && rep.employees.length >= 5, repErr?.message ?? rep?.totals);
  check('report case list has no patient column', rep.cases.length > 0 && rep.cases.every((c) => !('patient' in c) && 'clinic_order_ref' in c), rep.cases[0]);
  const { data: own } = await cad.rpc('lab_report', { p_from: '2020-01-01', p_to: today });
  check('technician report restricted to own work', own.scope === 'own' && own.employees.every((e) => e.code === 'CAD01'), own?.employees);

  section('9. Multi-laboratory isolation');
  const reg2 = await fn('register-lab', { lab: { code: LAB2, name: 'Other Lab' }, admin: { full_name: 'Other Admin', code: 'ADMIN01', pin: PIN } });
  const other = await clientFor(reg2.body.session);
  const { data: foreignCases } = await other.from('cases').select('id').eq('id', caseId);
  check('other lab cannot see the case', (foreignCases ?? []).length === 0);
  const { data: foreignEmp } = await other.from('employees').select('id').eq('lab_id', info.id);
  check('other lab cannot see employees', (foreignEmp ?? []).length === 0);
  const { error: foreignDl } = await other.storage.from('case-files').download(path);
  check('other lab cannot download files', !!foreignDl);
  const { error: foreignAct } = await other.rpc('add_case_note', { p_case_id: caseId, p_note: 'pwned' });
  check('other lab cannot write to the case', !!foreignAct);
  const { error: crossFk } = await other.from('doctors').insert({ lab_id: info.id, full_name: 'Injected' });
  check('cannot insert rows into another lab', !!crossFk);
  const { data: otherDoc } = await other.from('doctors').insert({ lab_id: reg2.body.lab_id, full_name: 'Dr Other' }).select().single();
  const { error: crossRef } = await rec.from('cases').update({ doctor_id: otherDoc.id }).eq('id', caseId);
  check("cannot reference another lab's doctor", !!crossRef);
  const { data: otherLogin } = await anon.rpc('get_lab_login_info', { p_code: LAB2 });
  check('login lookups are per lab', otherLogin.employees.length === 1);

  section('10. Account security');
  for (let i = 0; i < 5; i++) await fn('employee-login', { lab_code: LAB, employee_code: 'FIN01', pin: '999999' });
  const locked = await fn('employee-login', { lab_code: LAB, employee_code: 'FIN01', pin: PIN });
  check('5 wrong PINs lock the account (even correct PIN refused)', locked.status === 403 && locked.body.error === 'account_locked', locked.body);
  const reset = await fn('manage-employee', { action: 'reset_pin', employee_id: ids.FIN01, pin: '864200' }, adminToken);
  check('admin resets PIN (unlocks)', reset.status === 200, reset.body);
  const relog = await fn('employee-login', { lab_code: LAB, employee_code: 'FIN01', pin: '864200' });
  check('login with new PIN', relog.status === 200);
  const camToken = (await cam.auth.getSession()).data.session.access_token;
  const chg = await fn('manage-employee', { action: 'change_own_pin', current_pin: PIN, new_pin: '112233' }, camToken);
  check('employee changes own PIN', chg.status === 200, chg.body);
  const { error: deact } = await admin.from('employees').update({ status: 'inactive' }).eq('id', ids.CAM01);
  check('admin deactivates employee', !deact, deact?.message);
  const { data: camAfter } = await cam.from('cases').select('id');
  check('deactivated employee loses data access immediately', (camAfter ?? []).length === 0);
  const inactiveLogin = await fn('employee-login', { lab_code: LAB, employee_code: 'CAM01', pin: '112233' });
  check('deactivated employee cannot log in', inactiveLogin.status === 403 && inactiveLogin.body.error === 'account_inactive');
  const { data: adminRow } = await admin.from('employees').select('id').eq('code', 'ADMIN01').single();
  const { error: lastAdmin } = await admin.from('employees').update({ status: 'inactive' }).eq('id', adminRow.id);
  check('last administrator cannot be deactivated', !!lastAdmin && lastAdmin.message.includes('administrator'), lastAdmin?.message);

  section('12. Employee deletion privacy (anonymization, records preserved)');
  const tmp = await fn('manage-employee', {
    action: 'create',
    employee: { code: 'TMP01', full_name: 'Temporary Person', role_id: role('CAD'), department_id: dep('CAD'), phone: '+0000000', email: 'tmp@example.invalid', pin: PIN },
  }, adminToken);
  const tmpId = tmp.body?.employee_id;
  check('create temporary employee', tmp.status === 201, tmp.body);
  await admin.from('employees').update({ phone: '+1111111', specialty: 'Temp CAD' }).eq('id', tmpId);
  const { data: tmpCase, error: tmpCaseErr } = await rec.rpc('create_case', { p: {
    doctor_id: doctor.id, due_date: due,
    restorations: [{ restoration_type_id: t('ANATOMIC_CROWN'), material_id: m('ZIRCONIA') }], teeth: [{ tooth_number: 11, restoration_index: 0 }],
  } });
  check('create case for privacy test', !tmpCaseErr && tmpCase, tmpCaseErr?.message);
  const { data: tmpStages } = await admin.from('case_workflow_stages').select('id, name').eq('case_id', tmpCase);
  const cadStage = tmpStages.find((s) => s.name === 'CAD Design').id;
  const { error: asgErr } = await admin.rpc('assign_stage', { p_stage_id: cadStage, p_employee_id: tmpId });
  check('admin assigns the stage to the temporary employee', !asgErr, asgErr?.message);
  const tmpClient = await login(LAB, 'TMP01', PIN);
  const tmpAuthId = (await tmpClient.auth.getUser()).data.user.id;
  const { error: tmpStart } = await tmpClient.rpc('start_stage', { p_stage_id: cadStage });
  const { error: tmpNote } = await tmpClient.rpc('add_case_note', { p_case_id: tmpCase, p_note: 'work note by temp', p_stage_id: cadStage });
  check('temporary employee works on the case', !tmpStart && !tmpNote, (tmpStart ?? tmpNote)?.message);
  const { count: empBefore } = await admin.from('employees').select('id', { count: 'exact', head: true });
  const { count: qcBefore } = await admin.from('quality_control').select('id', { count: 'exact', head: true });
  const { count: delivBefore } = await admin.from('deliveries').select('id', { count: 'exact', head: true });
  const { count: histBefore } = await admin.from('case_history').select('id', { count: 'exact', head: true }).eq('case_id', tmpCase);
  const tmpToken = (await tmpClient.auth.getSession()).data.session.access_token;
  const tmpDel = await fn('manage-employee', { action: 'delete_my_account', pin: PIN }, tmpToken);
  check('temporary employee deletes their account', tmpDel.status === 200, tmpDel.body);
  const { data: tmpRow } = await admin.from('employees').select('id').eq('id', tmpId);
  check('employee row removed', (tmpRow ?? []).length === 0);
  const tmpRelog = await fn('employee-login', { lab_code: LAB, employee_code: 'TMP01', pin: PIN });
  check('deleted employee cannot log in', tmpRelog.status === 401, tmpRelog.body);
  const { data: oldSession } = await tmpClient.from('cases').select('id');
  check('old session no longer reads any data', (oldSession ?? []).length === 0);
  const { data: tmpAudit } = await admin.from('audit_logs').select('old_data, new_data, actor_user_id').eq('table_name', 'employees').eq('record_id', tmpId);
  const personal = ['full_name', 'code', 'phone', 'email', 'avatar_path', 'specialty', 'auth_user_id', 'last_login_at'];
  check('audit rows of the employee are kept but anonymized', tmpAudit.length >= 3 && tmpAudit.every((a) => [a.old_data, a.new_data].every((d) => !d || (d.anonymized === true && personal.every((k) => !(k in d))))), tmpAudit);
  const { data: actorRows } = await admin.from('audit_logs').select('id').eq('actor_user_id', tmpAuthId);
  check('no audit row keeps the deleted Auth account id', (actorRows ?? []).length === 0);
  const { data: tmpHist } = await admin.from('case_history').select('event_type, actor_id, notes, data').eq('case_id', tmpCase);
  const asg = tmpHist.find((h) => h.event_type === 'assigned' && h.data.employee_id === tmpId);
  check('history shows "Deleted Employee" instead of the name', asg?.data.employee_name === 'Deleted Employee', asg);
  check('no history row contains the name', !JSON.stringify(tmpHist).includes('Temporary Person'));
  check('work note kept without author', tmpHist.some((h) => h.event_type === 'note' && h.notes === 'work note by temp' && h.actor_id === null));
  check('history rows preserved', tmpHist.length === histBefore, { before: histBefore, after: tmpHist.length });
  const { data: stAfter } = await admin.from('case_workflow_stages').select('status, assigned_employee_id, started_at').eq('id', cadStage).single();
  check('stage kept (in progress), now unassigned', stAfter.status === 'in_progress' && stAfter.assigned_employee_id === null && stAfter.started_at, stAfter);
  const { count: empAfter } = await admin.from('employees').select('id', { count: 'exact', head: true });
  const { count: qcAfter } = await admin.from('quality_control').select('id', { count: 'exact', head: true });
  const { count: delivAfter } = await admin.from('deliveries').select('id', { count: 'exact', head: true });
  check('only that employee removed; QC and deliveries untouched', empAfter === empBefore - 1 && qcAfter === qcBefore && delivAfter === delivBefore, { empBefore, empAfter, qcBefore, qcAfter, delivBefore, delivAfter });
  const cadRelog = await fn('employee-login', { lab_code: LAB, employee_code: 'CAD01', pin: PIN });
  check('other employees still log in', cadRelog.status === 200, cadRelog.body);

  section('11. Account & laboratory deletion (store requirement)');
  const recToken = (await rec.auth.getSession()).data.session.access_token;
  const badPinDel = await fn('manage-employee', { action: 'delete_my_account', pin: '000000' }, recToken);
  check('account deletion requires the correct PIN', badPinDel.status === 403, badPinDel.body);
  const delMe = await fn('manage-employee', { action: 'delete_my_account', pin: PIN }, recToken);
  check('employee deletes their own account', delMe.status === 200, delMe.body);
  const recLogin = await fn('employee-login', { lab_code: LAB, employee_code: 'REC01', pin: PIN });
  check('deleted account can no longer log in', recLogin.status === 401, recLogin.body);
  const { data: caseStill } = await admin.from('cases').select('id, created_by').eq('id', caseId).single();
  check("lab data survives an employee's deletion", caseStill?.id === caseId && caseStill.created_by === null, caseStill);
  const otherToken = (await other.auth.getSession()).data.session.access_token;
  const lastAdminDel = await fn('manage-employee', { action: 'delete_my_account', pin: PIN }, otherToken);
  check('last administrator cannot delete only their account', lastAdminDel.status === 409 && lastAdminDel.body.error === 'last_admin', lastAdminDel.body);
  const cadDelLab = await fn('manage-employee', { action: 'delete_lab', pin: PIN, lab_code: LAB }, cadToken);
  check('non-admin cannot delete the laboratory', cadDelLab.status === 403, cadDelLab.body);
  const wrongCode = await fn('manage-employee', { action: 'delete_lab', pin: PIN, lab_code: 'WRONG' }, adminToken);
  check('lab deletion requires typing the lab code', wrongCode.status === 400 && wrongCode.body.error === 'lab_code_mismatch', wrongCode.body);
  const delLab = await fn('manage-employee', { action: 'delete_lab', pin: PIN, lab_code: LAB }, adminToken);
  check('administrator deletes the whole laboratory', delLab.status === 200, delLab.body);
  const { data: gone } = await anon.rpc('get_lab_login_info', { p_code: LAB });
  check('deleted laboratory no longer exists', gone === null);
  const ghost = await fn('employee-login', { lab_code: LAB, employee_code: 'ADMIN01', pin: PIN });
  check('its accounts can no longer log in', ghost.status === 401, ghost.body);
  const { error: dlGone } = await other.storage.from('case-files').download(path);
  check('its files are gone', !!dlGone);
  const delLab2 = await fn('manage-employee', { action: 'delete_lab', pin: PIN, lab_code: LAB2 }, otherToken);
  check('second test laboratory cleaned up', delLab2.status === 200, delLab2.body);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
