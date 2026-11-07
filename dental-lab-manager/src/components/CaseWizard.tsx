import { useRouter } from 'expo-router';
import { Box, Check, FileText, Layers, Paperclip, Plus, Stethoscope, Trash2, User, UserCog, X } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { type PickedFile, pickFiles, uploadCaseFile } from '../lib/files';
import { fmtSize, todayISO } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { type CaseDetail, type Catalogs, fetchCatalogs, fetchDepartments, fetchDoctors, fetchEmployees } from '../lib/queries';
import { errorCode, supabase, unwrap } from '../lib/supabase';
import { colors, radius } from '../lib/theme';
import type { Doctor, Priority } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { ImplantIcon, ToothIcon } from './brand';
import { useFeedback } from './feedback';
import { DateField, Select } from './pickers';
import { type ChartMode, type ChartValue, normalizeBridges, ToothChart } from './ToothChart';
import { Button, Card, Chip, ErrorBanner, Field, Loading, Row, SectionTitle } from './ui';

type Resto = {
  key: string;
  restoration_type_id: string | null;
  teeth: number[];
  material_id: string | null;
  material_brand: string;
  material_type: string;
  shade: string;
  thickness: string;
  translucency: string;
  block_reference: string;
  lot_number: string;
  manufacturing_notes: string;
  notes: string;
};
type Impl = Record<string, string> & { tooth_number: string };

const IMPLANT_FIELDS = ['connection', 'platform', 'diameter_mm', 'length_mm', 'scanbody_manufacturer', 'scanbody_reference', 'tibase_type', 'library_reference'] as const;
const IMPLANT_LABEL: Record<(typeof IMPLANT_FIELDS)[number], string> = {
  connection: 'wiz.connection', platform: 'wiz.platform', diameter_mm: 'wiz.diameter', length_mm: 'wiz.length',
  scanbody_manufacturer: 'wiz.scanbodyMfr', scanbody_reference: 'wiz.scanbodyRef', tibase_type: 'wiz.tibase', library_reference: 'wiz.libraryRef',
};
const SHADES = ['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'C1', 'C2', 'D2', 'D3', 'BL1', 'BL2', 'BL3', 'BL4'];

let keySeq = 0;
const newResto = (teeth: number[] = []): Resto => ({
  key: `r${++keySeq}`, restoration_type_id: null, teeth, material_id: null, material_brand: '', material_type: '', shade: '',
  thickness: '', translucency: '', block_reference: '', lot_number: '', manufacturing_notes: '', notes: '',
});

function TypeIcon({ icon, on }: { icon: string; on: boolean }) {
  const c = on ? '#1A1206' : colors.gold;
  if (icon === 'implant' || icon === 'abutment') return <ImplantIcon size={20} color={c} />;
  if (icon === 'box') return <Box size={20} color={c} strokeWidth={1.6} />;
  if (icon === 'guide') return <Layers size={20} color={c} strokeWidth={1.6} />;
  return <ToothIcon size={20} color={c} />;
}

function StepHeader({ step, setStep }: { step: number; setStep: (n: number) => void }) {
  const { t } = useI18n();
  const labels = [t('wiz.s1'), t('wiz.s2'), t('wiz.s3'), t('wiz.s4')];
  return (
    <View style={styles.steps}>
      {labels.map((l, i) => {
        const on = i === step;
        const done = i < step;
        return (
          <React.Fragment key={l}>
            {i > 0 ? <View style={[styles.stepLine, (done || on) && { backgroundColor: colors.gold }]} /> : null}
            <Pressable onPress={() => setStep(i)} style={{ alignItems: 'center', width: 76 }} accessibilityRole="tab" accessibilityState={{ selected: on }}>
              <View style={[styles.stepCircle, on && styles.stepOn, done && styles.stepDone]}>
                {done ? <Check size={16} color="#1A1206" strokeWidth={3} /> : <Text style={[styles.stepNum, on && { color: '#1A1206' }]}>{i + 1}</Text>}
              </View>
              <Text style={[styles.stepLabel, on && { color: colors.gold, fontWeight: '800' }]} numberOfLines={2}>
                {l}
              </Text>
            </Pressable>
          </React.Fragment>
        );
      })}
    </View>
  );
}

export function CaseWizard({ existing }: { existing?: CaseDetail }) {
  const { t, tx } = useI18n();
  const router = useRouter();
  const { me, can } = useAuth();
  const fb = useFeedback();
  const editing = !!existing;
  const ref = useAsync(async () => {
    const [catalogs, doctors, employees, departments] = await Promise.all([fetchCatalogs(), fetchDoctors(), fetchEmployees(), fetchDepartments()]);
    return { catalogs, doctors, employees, departments };
  });

  const [step, setStep] = useState(0);
  const [patientName, setPatientName] = useState(existing?.case.patient?.full_name ?? '');
  const [doctorId, setDoctorId] = useState<string | null>(existing?.case.doctor_id ?? null);
  const [techId, setTechId] = useState<string | null>(existing?.case.assigned_technician_id ?? null);
  const [receivedAt, setReceivedAt] = useState(existing?.case.received_at.slice(0, 10) ?? todayISO());
  const [dueDate, setDueDate] = useState<string | null>(existing?.case.due_date ?? null);
  const [priority, setPriority] = useState<Priority>(existing?.case.priority ?? 'normal');
  const [shade, setShade] = useState(existing?.case.shade ?? '');
  const [notes, setNotes] = useState(existing?.case.notes ?? '');
  const [mode, setMode] = useState<ChartMode>('select');
  const [chart, setChart] = useState<ChartValue>(() => {
    const v: ChartValue = {};
    for (const tt of existing?.teeth ?? []) v[tt.tooth_number] = { tooth_number: tt.tooth_number, is_missing: tt.is_missing, is_implant: tt.is_implant, bridge_group: tt.bridge_group };
    return v;
  });
  const [restos, setRestos] = useState<Resto[]>(() =>
    (existing?.restorations ?? []).map((r) => ({
      ...newResto(existing!.teeth.filter((tt) => tt.restoration_id === r.id).map((tt) => tt.tooth_number)),
      restoration_type_id: r.restoration_type_id, material_id: r.material_id, material_brand: r.material_brand ?? '', material_type: r.material_type ?? '',
      shade: r.shade ?? '', thickness: r.thickness ?? '', translucency: r.translucency ?? '', block_reference: r.block_reference ?? '',
      lot_number: r.lot_number ?? '', manufacturing_notes: r.manufacturing_notes ?? '', notes: r.notes ?? '',
    })),
  );
  const [implants, setImplants] = useState<Record<number, Impl>>(() => {
    const m: Record<number, Impl> = {};
    for (const i of existing?.implants ?? []) {
      m[i.tooth_number] = Object.fromEntries(Object.entries(i).map(([k, v]) => [k, v == null ? '' : String(v)])) as Impl;
    }
    return m;
  });
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => Object.keys(chart).map(Number).sort((a, b) => a - b), [chart]);
  const implantTeeth = selected.filter((n) => chart[n].is_implant);

  if (!ref.data) return ref.error ? <ErrorBanner code={ref.error} onRetry={ref.reload} /> : <Loading />;
  const { catalogs, doctors, employees, departments } = ref.data as { catalogs: Catalogs; doctors: Doctor[]; employees: typeof ref.data.employees; departments: typeof ref.data.departments };
  const depName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? '';
  const productionDeps = new Set(departments.filter((d) => !['ADMIN', 'RECEPTION', 'DELIVERY'].includes(d.code)).map((d) => d.id));
  const technicians = employees.filter((e) => e.department_id && productionDeps.has(e.department_id));

  const updateResto = (key: string, patch: Partial<Resto>) => setRestos((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const toggleToothInResto = (key: string, n: number) =>
    setRestos((rs) =>
      rs.map((r) => {
        if (r.key === key) return { ...r, teeth: r.teeth.includes(n) ? r.teeth.filter((x) => x !== n) : [...r.teeth, n].sort((a, b) => a - b) };
        return { ...r, teeth: r.teeth.filter((x) => x !== n) }; // a tooth belongs to one restoration
      }),
    );
  const unassigned = selected.filter((n) => !restos.some((r) => r.teeth.includes(n)));

  const goStep = (n: number) => {
    // entering restoration step: start with one restoration covering every tooth
    if (n >= 2 && restos.length === 0 && selected.length > 0) setRestos([newResto(selected)]);
    // drop teeth that were deselected on the chart
    setRestos((rs) => rs.map((r) => ({ ...r, teeth: r.teeth.filter((x) => chart[x]) })));
    setStep(n);
  };

  const addDoctor = async (close: () => void) => {
    close();
    const name = await fb.prompt({ title: t('wiz.newDoctor'), input: { label: t('c.name'), required: true } });
    if (!name || !me) return;
    try {
      const d = unwrap(await supabase.from('doctors').insert({ lab_id: me.lab_id, full_name: name }).select().single()) as Doctor;
      ref.setData({ ...ref.data!, doctors: [...doctors, d].sort((a, b) => a.full_name.localeCompare(b.full_name)) });
      setDoctorId(d.id);
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    }
  };

  const validate = (): string | null => {
    if (!editing && patientName.trim().length < 2) return 'patient_required';
    if (!doctorId) return 'doctor_required';
    if (!dueDate) return 'due_date_required';
    if (selected.length === 0) return 'teeth_required';
    if (restos.some((r) => !r.restoration_type_id)) return 'missing_fields';
    if (restos.some((r) => r.teeth.length === 0)) return 'teeth_required';
    return null;
  };

  const buildPrescription = () => {
    const finalChart = normalizeBridges(chart, false); // single-tooth "bridges" are not bridges
    const used = restos.filter((r) => r.teeth.length > 0);
    return {
      restorations: used.map((r) => ({
        restoration_type_id: r.restoration_type_id, material_id: r.material_id, material_brand: r.material_brand, material_type: r.material_type,
        shade: r.shade || shade, thickness: r.thickness, translucency: r.translucency, block_reference: r.block_reference,
        lot_number: r.lot_number, manufacturing_notes: r.manufacturing_notes, notes: r.notes,
      })),
      teeth: selected.map((n) => {
        const idx = used.findIndex((r) => r.teeth.includes(n));
        return { ...finalChart[n], restoration_index: idx >= 0 ? idx : null };
      }),
      implants: implantTeeth.map((n) => {
        const i = implants[n] ?? {};
        return { ...i, tooth_number: n };
      }),
    };
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setBusy(t('c.loading'));
    try {
      const prescription = buildPrescription();
      if (editing) {
        const id = existing!.case.id;
        unwrap(await supabase.rpc('update_case_prescription', { p_case_id: id, p: prescription }));
        unwrap(
          await supabase
            .from('cases')
            .update({ doctor_id: doctorId, assigned_technician_id: techId, due_date: dueDate, priority, shade: shade || null, notes: notes || null })
            .eq('id', id)
            .select('id'),
        );
        fb.toast(t('c.saved'));
        router.back();
        return;
      }
      const caseId = unwrap(
        await supabase.rpc('create_case', {
          p: {
            patient: { full_name: patientName.trim() }, doctor_id: doctorId, assigned_technician_id: techId,
            received_at: receivedAt === todayISO() ? null : `${receivedAt}T09:00:00`, due_date: dueDate, priority, shade, notes, ...prescription,
          },
        }),
      ) as string;
      let failed = 0;
      for (let i = 0; i < files.length; i++) {
        setBusy(`${t('wiz.uploading')} ${i + 1}/${files.length}`);
        try {
          await uploadCaseFile({ labId: me!.lab_id, caseId, employeeId: me!.id, file: files[i] });
        } catch {
          failed++;
        }
      }
      const { data: c } = await supabase.from('cases').select('case_number').eq('id', caseId).single();
      if (failed) fb.toast(t('wiz.uploadFailed', { n: failed }), 'error');
      else fb.toast(t('wiz.created', { n: c?.case_number ?? '' }));
      // reset for the next case and open the new one
      setPatientName(''); setDoctorId(null); setTechId(null); setDueDate(null); setPriority('normal'); setShade(''); setNotes('');
      setChart({}); setRestos([]); setImplants({}); setFiles([]); setStep(0);
      router.push(`/case/${caseId}`);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(null);
    }
  };

  const typeName = (id: string | null) => catalogs.types.find((x) => x.id === id)?.name;

  return (
    <View style={{ gap: 14 }}>
      <StepHeader step={step} setStep={goStep} />

      {step === 0 ? (
        <Card>
          <SectionTitle icon={<User color={colors.gold} size={22} />}>{t('wiz.s1')}</SectionTitle>
          {editing ? (
            <Field label={t('case.patient')} value={patientName} editable={false} icon={<User color={colors.muted} size={20} />} />
          ) : (
            <Field label={t('wiz.patientName')} required value={patientName} onChangeText={setPatientName} icon={<User color={colors.gold} size={20} />} />
          )}
          <Select
            label={t('case.doctor')}
            required
            value={doctorId}
            onChange={setDoctorId}
            icon={<Stethoscope color={colors.gold} size={20} />}
            options={doctors.map((d) => ({ value: d.id, label: d.full_name, hint: d.clinic_name ?? undefined }))}
            footer={can('doctors.manage') ? (close) => <Button small variant="outline" title={`+ ${t('wiz.newDoctor')}`} onPress={() => addDoctor(close)} style={{ marginTop: 8 }} /> : undefined}
          />
          <Select
            label={`${t('case.technician')} (${t('c.optional')})`}
            value={techId}
            onChange={setTechId}
            allowClear
            icon={<UserCog color={colors.gold} size={20} />}
            options={technicians.map((e) => ({ value: e.id, label: `${e.full_name} (${e.code})`, hint: depName(e.department_id) }))}
          />
          {!editing ? <DateField label={t('case.receivedAt')} value={receivedAt} onChange={setReceivedAt} /> : null}
          <DateField label={t('case.dueDate')} required value={dueDate} onChange={setDueDate} min={receivedAt} />
          <Text style={styles.label}>{t('case.priority')}</Text>
          <Row style={{ marginBottom: 12 }}>
            {(['normal', 'urgent', 'very_urgent'] as Priority[]).map((p) => (
              <Chip key={p} label={tx('prio', p)} selected={priority === p} onPress={() => setPriority(p)} style={{ flex: 1 }} />
            ))}
          </Row>
          <Text style={styles.label}>{t('case.shade')}</Text>
          <View style={styles.wrap}>
            {SHADES.map((s) => (
              <Chip key={s} label={s} selected={shade === s} onPress={() => setShade(shade === s ? '' : s)} style={styles.shadeChip} />
            ))}
          </View>
          <Field label={t('wiz.generalNotes')} value={notes} onChangeText={setNotes} multiline icon={<FileText color={colors.gold} size={20} />} style={{ marginTop: 12 }} />
          {!editing ? <Text style={styles.hint}>{t('wiz.reference')}: DL-XXXXXX</Text> : null}
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <SectionTitle icon={<ToothIcon size={24} />}>{t('wiz.s2')}</SectionTitle>
          <Text style={styles.label}>{t('wiz.mode')}</Text>
          <Row style={{ marginBottom: 14, flexWrap: 'wrap' }} gap={8}>
            {(['select', 'bridge', 'missing', 'implant'] as ChartMode[]).map((m) => (
              <Chip key={m} label={t(`wiz.mode${m[0].toUpperCase()}${m.slice(1)}` as 'wiz.modeSelect')} selected={mode === m} onPress={() => setMode(m)} style={{ flexGrow: 1 }} />
            ))}
          </Row>
          {mode === 'bridge' ? <Text style={[styles.hint, { marginBottom: 10 }]}>{t('wiz.bridgeHint')}</Text> : null}
          <ToothChart value={chart} onChange={setChart} mode={mode} />
          <View style={styles.legend}>
            <Row gap={6}><View style={[styles.lg, { backgroundColor: '#E8ECF1' }]} /><Text style={styles.lgText}>{t('wiz.legendNone')}</Text></Row>
            <Row gap={6}><View style={[styles.lg, { backgroundColor: colors.gold }]} /><Text style={styles.lgText}>{t('wiz.modeSelect')}</Text></Row>
            <Row gap={6}><View style={styles.lgBridge} /><Text style={styles.lgText}>{t('wiz.modeBridge')}</Text></Row>
            <Row gap={6}><View style={[styles.lg, { borderStyle: 'dashed', borderWidth: 1.5, borderColor: colors.muted }]} /><Text style={styles.lgText}>{t('wiz.modeMissing')}</Text></Row>
            <Row gap={6}><ImplantIcon size={16} /><Text style={styles.lgText}>{t('wiz.modeImplant')}</Text></Row>
          </View>
          <Row style={{ marginTop: 12 }}>
            <Text style={[styles.hint, { flex: 1 }]}>
              {t('wiz.selected')}: {selected.join(', ') || '—'}
            </Text>
            {selected.length ? <Button small variant="dark" title={t('wiz.clear')} onPress={() => setChart({})} /> : null}
          </Row>
        </Card>
      ) : null}

      {step === 2 ? (
        <>
          {selected.length === 0 ? <ErrorBanner code="teeth_required" /> : null}
          {restos.map((r, idx) => (
            <Card key={r.key}>
              <SectionTitle
                icon={<ToothIcon size={22} />}
                right={
                  restos.length > 1 ? (
                    <Pressable onPress={() => setRestos((rs) => rs.filter((x) => x.key !== r.key))} hitSlop={8} accessibilityLabel={t('c.delete')}>
                      <Trash2 color={colors.error} size={20} />
                    </Pressable>
                  ) : null
                }
              >
                {t('wiz.restorations')} {restos.length > 1 ? `#${idx + 1}` : ''} {typeName(r.restoration_type_id) ? `— ${typeName(r.restoration_type_id)}` : ''}
              </SectionTitle>
              <Text style={styles.label}>{t('wiz.restorationType')} *</Text>
              <View style={styles.grid}>
                {catalogs.types.filter((x) => x.is_active || x.id === r.restoration_type_id).map((x) => {
                  const on = r.restoration_type_id === x.id;
                  return <Chip key={x.id} label={x.name} selected={on} icon={<TypeIcon icon={x.icon} on={on} />} onPress={() => updateResto(r.key, { restoration_type_id: x.id })} style={styles.gridChip} />;
                })}
              </View>
              <Text style={[styles.label, { marginTop: 12 }]}>{t('wiz.applyTo')}</Text>
              <View style={styles.wrap}>
                {selected.map((n) => (
                  <Chip key={n} label={String(n)} selected={r.teeth.includes(n)} onPress={() => toggleToothInResto(r.key, n)} style={styles.toothChip} />
                ))}
              </View>
              <Field label={t('c.notes')} value={r.notes} onChangeText={(v) => updateResto(r.key, { notes: v })} style={{ marginTop: 12 }} />
            </Card>
          ))}
          {unassigned.length > 0 ? <Text style={[styles.hint, { color: colors.warning }]}>{t('wiz.unassigned', { t: unassigned.join(', ') })}</Text> : null}
          {selected.length > 0 ? (
            <Button variant="outline" icon={<Plus color={colors.gold} size={18} />} title={t('wiz.addRestoration')} onPress={() => setRestos((rs) => [...rs, newResto(unassigned)])} />
          ) : null}

          <Card>
            <SectionTitle icon={<ImplantIcon size={22} />}>{t('wiz.implants')}</SectionTitle>
            {implantTeeth.length === 0 ? <Text style={styles.hint}>{t('wiz.noImplantTeeth')}</Text> : null}
            {implantTeeth.map((n) => {
              const im = implants[n] ?? ({ tooth_number: String(n) } as Impl);
              const set = (k: string, v: string) => setImplants((m) => ({ ...m, [n]: { ...(m[n] ?? { tooth_number: String(n) }), [k]: v } }));
              const brand = catalogs.brands.find((b) => b.id === im.brand_id);
              const systems = catalogs.systems.filter((s) => s.brand_id === im.brand_id);
              const sys = systems.find((s) => s.name === im.system_name);
              return (
                <View key={n} style={styles.implantBox}>
                  <Text style={[styles.label, { color: colors.gold, fontSize: 15, fontWeight: '800' }]}>
                    {t('det.implant')} · {n}
                  </Text>
                  <Select
                    label={t('wiz.implantBrand')}
                    value={im.brand_id || null}
                    onChange={(v) => setImplants((m) => ({ ...m, [n]: { ...(m[n] ?? { tooth_number: String(n) }), brand_id: v ?? '', brand_name: catalogs.brands.find((b) => b.id === v)?.name ?? '', system_name: '' } }))}
                    options={catalogs.brands.filter((b) => b.is_active).map((b) => ({ value: b.id, label: b.name }))}
                  />
                  {brand && systems.length ? (
                    <Select label={t('wiz.implantSystem')} value={im.system_name || null} onChange={(v) => set('system_name', v ?? '')} allowClear options={systems.map((s) => ({ value: s.name, label: s.name }))} />
                  ) : (
                    <Field label={t('wiz.implantSystem')} value={im.system_name ?? ''} onChangeText={(v) => set('system_name', v)} />
                  )}
                  {sys?.connection_types.length ? (
                    <Row style={{ flexWrap: 'wrap', marginBottom: 10 }} gap={6}>
                      {sys.connection_types.map((c) => <Chip key={c} label={c} selected={im.connection === c} onPress={() => set('connection', c)} />)}
                      {sys.platforms.map((p) => <Chip key={p} label={p} selected={im.platform === p} onPress={() => set('platform', p)} />)}
                    </Row>
                  ) : null}
                  <View style={styles.two}>
                    {IMPLANT_FIELDS.map((k) => (
                      <Field
                        key={k}
                        label={t(IMPLANT_LABEL[k] as 'wiz.connection')}
                        value={im[k] ?? ''}
                        onChangeText={(v) => set(k, k.endsWith('_mm') ? v.replace(/[^0-9.]/g, '') : v)}
                        keyboardType={k.endsWith('_mm') ? 'decimal-pad' : 'default'}
                        style={styles.half}
                      />
                    ))}
                  </View>
                  <Text style={styles.label}>{t('wiz.screwChannel')}</Text>
                  <Row style={{ marginBottom: 10 }}>
                    {(['straight', 'angulated'] as const).map((c) => (
                      <Chip key={c} label={t(`wiz.${c}`)} selected={im.screw_channel === c} onPress={() => set('screw_channel', im.screw_channel === c ? '' : c)} style={{ flex: 1 }} />
                    ))}
                  </Row>
                  {im.screw_channel === 'angulated' ? <Field label={t('wiz.angulation')} value={im.angulation_degrees ?? ''} onChangeText={(v) => set('angulation_degrees', v.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" /> : null}
                  <Field label={t('wiz.techNotes')} value={im.notes ?? ''} onChangeText={(v) => set('notes', v)} multiline />
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      {step === 3 ? (
        <>
          {restos.map((r, idx) => (
            <Card key={r.key}>
              <SectionTitle icon={<Layers color={colors.gold} size={22} />}>
                {t('wiz.material')} — {typeName(r.restoration_type_id) ?? `#${idx + 1}`} ({r.teeth.join(', ') || '—'})
              </SectionTitle>
              <View style={styles.grid}>
                {catalogs.materials.filter((m) => m.is_active || m.id === r.material_id).map((m) => {
                  const on = r.material_id === m.id;
                  return (
                    <Chip
                      key={m.id}
                      label={m.name}
                      selected={on}
                      icon={<Box size={18} color={on ? '#1A1206' : colors.gold} strokeWidth={1.6} />}
                      onPress={() => updateResto(r.key, { material_id: on ? null : m.id, material_brand: r.material_brand || m.default_brand || '' })}
                      style={styles.gridChip}
                    />
                  );
                })}
              </View>
              <View style={[styles.two, { marginTop: 12 }]}>
                <Field label={t('wiz.materialBrand')} value={r.material_brand} onChangeText={(v) => updateResto(r.key, { material_brand: v })} style={styles.half} />
                <Field label={t('wiz.materialType')} value={r.material_type} onChangeText={(v) => updateResto(r.key, { material_type: v })} style={styles.half} />
                <Field label={t('case.shade')} value={r.shade} placeholder={shade || undefined} onChangeText={(v) => updateResto(r.key, { shade: v })} style={styles.half} />
                <Field label={t('wiz.thickness')} value={r.thickness} onChangeText={(v) => updateResto(r.key, { thickness: v })} style={styles.half} />
                <Field label={t('wiz.translucency')} value={r.translucency} onChangeText={(v) => updateResto(r.key, { translucency: v })} style={styles.half} />
                <Field label={t('wiz.blockRef')} value={r.block_reference} onChangeText={(v) => updateResto(r.key, { block_reference: v })} style={styles.half} />
                <Field label={t('wiz.lot')} value={r.lot_number} onChangeText={(v) => updateResto(r.key, { lot_number: v })} style={styles.half} />
              </View>
              <Field label={t('wiz.mfgNotes')} value={r.manufacturing_notes} onChangeText={(v) => updateResto(r.key, { manufacturing_notes: v })} multiline />
            </Card>
          ))}
          {restos.length === 0 ? <ErrorBanner code="teeth_required" /> : null}
          {!editing ? (
            <Card>
              <SectionTitle icon={<Paperclip color={colors.gold} size={22} />}>{t('wiz.attachments')}</SectionTitle>
              {files.map((f, i) => (
                <Row key={`${f.name}${i}`} style={styles.fileRow}>
                  <FileText color={colors.gold} size={18} />
                  <Text style={{ color: colors.white, flex: 1 }} numberOfLines={1}>
                    {f.name}
                  </Text>
                  <Text style={styles.hint}>{fmtSize(f.size)}</Text>
                  <Pressable onPress={() => setFiles((fs) => fs.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel={t('c.delete')}>
                    <X color={colors.error} size={18} />
                  </Pressable>
                </Row>
              ))}
              <Button
                variant="outline"
                icon={<Plus color={colors.gold} size={18} />}
                title={t('wiz.addFiles')}
                onPress={async () => {
                  const picked = await pickFiles();
                  setFiles((fs) => [...fs, ...picked]);
                }}
              />
            </Card>
          ) : null}
        </>
      ) : null}

      <ErrorBanner code={error} />
      <Row>
        {step > 0 ? <Button variant="dark" title={t('c.previous')} onPress={() => goStep(step - 1)} style={{ flex: 1 }} /> : null}
        {step < 3 ? (
          <Button title={t('c.next')} onPress={() => goStep(step + 1)} style={{ flex: 2 }} />
        ) : (
          <Button title={busy ?? (editing ? t('wiz.saveChanges') : t('wiz.create'))} loading={!!busy} onPress={submit} style={{ flex: 2 }} />
        )}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  stepLine: { flex: 1, height: 2, backgroundColor: colors.border, marginTop: 17 },
  stepCircle: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  stepOn: { backgroundColor: colors.gold, borderColor: colors.goldHi, shadowColor: colors.goldHi, shadowOpacity: 0.8, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  stepDone: { backgroundColor: colors.gold, borderColor: colors.gold },
  stepNum: { color: colors.white, fontWeight: '800', fontSize: 16 },
  stepLabel: { color: colors.white, fontSize: 12, marginTop: 6, textAlign: 'center' },
  label: { color: colors.muted, fontSize: 13, marginBottom: 8 },
  hint: { color: colors.muted, fontSize: 13 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shadeChip: { paddingHorizontal: 10, paddingVertical: 8, minWidth: 52 },
  toothChip: { minWidth: 52, paddingVertical: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridChip: { flexBasis: '47%', flexGrow: 1, justifyContent: 'flex-start', minHeight: 50 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12, justifyContent: 'center' },
  lg: { width: 18, height: 18, borderRadius: 5 },
  lgBridge: { width: 26, height: 5, borderRadius: 3, backgroundColor: '#5B8DEF' },
  lgText: { color: colors.text, fontSize: 12 },
  implantBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginBottom: 12 },
  two: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 },
  half: { flexBasis: '47%', flexGrow: 1 },
  fileRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 6 },
});
