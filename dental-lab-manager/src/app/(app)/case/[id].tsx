import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowRightLeft, Ban, Calendar, Clock, Download, FileText, History, MessageSquare, Pause, Pencil, Play,
  RotateCcw, Send, ShieldCheck, ShieldX, Stethoscope, Trash2, Truck, Upload, User, UserCog,
} from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ImplantIcon, ToothIcon } from '../../../components/brand';
import { HistoryList, StageDuration, StageTimeline, StatusBadge } from '../../../components/cases';
import { FormModal, useFeedback } from '../../../components/feedback';
import { Select } from '../../../components/pickers';
import { type ChartValue, ToothChart } from '../../../components/ToothChart';
import { Badge, Button, Card, Chip, Divider, EmptyState, ErrorBanner, Field, KV, Loading, Row, Screen, SectionTitle, Toggle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { deleteCaseFile, guessCategory, openCaseFile, pickFiles, uploadCaseFile } from '../../../lib/files';
import { fmtDate, fmtDuration, fmtSize, isDelayed, secondsSince } from '../../../lib/format';
import { useI18n } from '../../../lib/i18n';
import { fetchCaseDetail, fetchDepartments, fetchEmployees } from '../../../lib/queries';
import { useRealtimeRefresh } from '../../../lib/realtime';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors, priorityColor, radius, statusColor } from '../../../lib/theme';
import type { Stage } from '../../../lib/types';
import { useAsync } from '../../../lib/useAsync';

type ActionModal = null | 'transfer' | 'return' | 'qc_pass' | 'qc_fail' | 'deliver' | 'assign';
const QC_ITEMS = ['fit', 'margins', 'occlusion', 'shade', 'contacts', 'finish'] as const;
const DELIVERY_METHODS = ['pickup', 'courier', 'lab_driver', 'digital', 'other'] as const;

export default function CaseDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tx, locale } = useI18n();
  const router = useRouter();
  const { me, can } = useAuth();
  const fb = useFeedback();

  const { data, error, loading, reload } = useAsync(async () => {
    const [detail, employees, departments, canAct] = await Promise.all([
      fetchCaseDetail(id),
      fetchEmployees(true),
      fetchDepartments(),
      supabase.from('cases').select('current_stage_id').eq('id', id).single().then(async (r) => {
        const sid = r.data?.current_stage_id;
        if (!sid) return false;
        return Boolean(unwrap(await supabase.rpc('can_act_on_stage', { p_stage_id: sid })));
      }),
    ]);
    return { ...detail, employees, departments, canAct };
  }, [id]);
  useRealtimeRefresh(`case-${id}`, ['cases', 'case_workflow_stages'], reload);

  const [modal, setModal] = useState<ActionModal>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);

  const empName = useMemo(() => Object.fromEntries((data?.employees ?? []).map((e) => [e.id, e.full_name])), [data?.employees]);
  const stageName = useMemo(() => Object.fromEntries((data?.stages ?? []).map((s) => [s.id, s.name])), [data?.stages]);

  if (!data) {
    return (
      <Screen back title={t('det.title')}>
        {error ? <ErrorBanner code={error} onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }

  const c = data.case;
  const current = data.stages.find((s) => s.id === c.current_stage_id) ?? null;
  const closed = c.status === 'delivered' || c.status === 'cancelled';
  const next = current ? data.stages.filter((s) => s.position > current.position && s.status !== 'skipped').sort((a, b) => a.position - b.position)[0] : undefined;
  const earlier = current ? data.stages.filter((s) => s.position < current.position && (s.kind === 'production' || s.kind === 'reception')) : [];
  const depName = (did: string | null) => data.departments.find((d) => d.id === did)?.name ?? '—';
  const chart: ChartValue = Object.fromEntries(data.teeth.map((tt) => [tt.tooth_number, { tooth_number: tt.tooth_number, is_missing: tt.is_missing, is_implant: tt.is_implant, bridge_group: tt.bridge_group }]));
  const myStage = !!current && !closed && current.assigned_employee_id === me?.id;
  const canClaim = !!current && !closed && !current.assigned_employee_id && current.department_id === me?.department_id;

  const run = async (fn: () => Promise<unknown>, success = t('c.saved')) => {
    setBusy(true);
    try {
      await fn();
      setModal(null);
      setForm({});
      setChecklist({});
      fb.toast(success);
      await reload();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(false);
    }
  };
  const rpc = (name: string, args: Record<string, unknown>) => async () => unwrap(await supabase.rpc(name, args));
  const open = (m: ActionModal, initial: Record<string, string> = {}) => {
    setForm(initial);
    setChecklist({});
    setModal(m);
  };

  const uploadFiles = async () => {
    const files = await pickFiles();
    if (!files.length || !me) return;
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      setUploading(`${i + 1}/${files.length}`);
      try {
        await uploadCaseFile({ labId: me.lab_id, caseId: c.id, employeeId: me.id, file: files[i], category: guessCategory(files[i].name), stageId: current?.id });
      } catch (e) {
        failed++;
        fb.toast(`${files[i].name}: ${tx('err', errorCode(e))}`, 'error');
      }
    }
    setUploading(null);
    if (!failed) fb.toast(t('c.saved'));
    reload();
  };

  const nextCandidates = next ? data.employees.filter((e) => e.status === 'active' && (can('workflow.assign') || e.department_id === next.department_id)) : [];

  return (
    <Screen
      back
      title={t('det.title')}
      right={
        <View style={styles.caseNoPill}>
          <Text style={styles.caseNo}>{c.case_number}</Text>
        </View>
      }
      refreshing={loading}
      onRefresh={reload}
    >
      {/* Header card: patient / doctor / dates */}
      <Card>
        <Row style={{ alignItems: 'flex-start' }} gap={14}>
          <View style={styles.thumb}>
            <ToothIcon size={64} color={statusColor[c.status] ?? colors.gold} strokeWidth={1.2} />
          </View>
          <View style={{ flex: 1 }}>
            <KV label={t('case.patient')} value={c.patient?.full_name} icon={<User color={colors.gold} size={22} />} />
            <KV label={t('case.doctor')} value={c.doctor?.full_name} icon={<Stethoscope color={colors.gold} size={22} />} />
            <KV label={t('case.receivedAt')} value={fmtDate(c.received_at, locale)} icon={<Calendar color={colors.gold} size={22} />} />
          </View>
        </Row>
        <Divider />
        <Row style={{ flexWrap: 'wrap' }}>
          <StatusBadge status={c.status} due={c.due_date} />
          <Badge label={tx('prio', c.priority)} color={priorityColor[c.priority]} />
          <View style={{ flex: 1 }} />
          <Row gap={6}>
            <Calendar color={isDelayed(c) ? colors.error : colors.muted} size={16} />
            <Text style={{ color: isDelayed(c) ? colors.error : colors.text }}>
              {t('case.dueDate')}: {fmtDate(c.due_date, locale)}
            </Text>
          </Row>
        </Row>
        {data.restorations.length ? (
          <>
            <Divider />
            {data.restorations.map((r) => (
              <Row key={r.id} style={{ paddingVertical: 4 }}>
                <ToothIcon size={20} />
                <Text style={styles.workType}>
                  {r.restoration_type?.name} ({data.teeth.filter((tt) => tt.restoration_id === r.id).map((tt) => tt.tooth_number).join(', ')})
                </Text>
                {r.material ? <Text style={styles.muted}>{[r.material.name, r.shade].filter(Boolean).join(' – ')}</Text> : null}
              </Row>
            ))}
          </>
        ) : null}
        {c.notes ? (
          <Row style={{ marginTop: 6, alignItems: 'flex-start' }}>
            <MessageSquare color={colors.gold} size={18} />
            <Text style={[styles.body, { flex: 1 }]}>{c.notes}</Text>
          </Row>
        ) : null}
      </Card>

      {/* Production status */}
      <Card>
        <SectionTitle>{t('det.production')}</SectionTitle>
        <StageTimeline stages={data.stages} currentId={c.current_stage_id} />
        {current && !closed ? (
          <View style={[styles.respBox, myStage && { borderColor: colors.goldHi }]}>
            <User color={colors.gold} size={24} />
            <View style={{ flex: 1 }}>
              <Text style={styles.muted}>{t('case.responsible')}</Text>
              <Text style={styles.respName}>
                {current.assigned_employee_id ? empName[current.assigned_employee_id] : t('case.unassigned')} ({current.name})
              </Text>
              <Text style={styles.muted}>{depName(current.department_id)}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.muted}>{t('case.timeInStage')}</Text>
              <Text style={styles.respTime}>
                {fmtDuration(secondsSince(data.history.filter((h) => h.to_stage_id === current.id).slice(-1)[0]?.created_at ?? current.started_at ?? c.received_at), { h: t('c.hours'), m: t('c.minutes') })}
              </Text>
            </View>
            <Clock color={colors.gold} size={22} />
          </View>
        ) : null}
        {myStage ? <Text style={[styles.gold, { marginTop: 8, textAlign: 'center' }]}>{t('det.yourTurn')}</Text> : null}

        {/* Actions — shown only when the server says this employee can act */}
        {current && !closed && data.canAct ? (
          <View style={{ gap: 10, marginTop: 14 }}>
            {current.kind === 'production' || current.kind === 'reception' ? (
              <>
                <Row>
                  {current.status !== 'in_progress' ? (
                    <Button style={{ flex: 1 }} variant="outline" icon={<Play color={colors.gold} size={18} />} title={current.started_at ? t('det.resume') : t('det.start')} loading={busy} onPress={() => run(rpc('start_stage', { p_stage_id: current.id }))} />
                  ) : (
                    <Button style={{ flex: 1 }} variant="outline" icon={<Pause color={colors.gold} size={18} />} title={t('det.pause')} loading={busy} onPress={() => run(rpc('set_stage_status', { p_stage_id: current.id, p_status: 'waiting' }))} />
                  )}
                  {earlier.length ? (
                    <Button style={{ flex: 1 }} variant="dark" icon={<RotateCcw color={colors.gold} size={18} />} title={t('det.return')} onPress={() => open('return', { target: earlier[earlier.length - 1].id })} />
                  ) : null}
                </Row>
                <Button icon={<Send color="#1A1206" size={18} />} title={`${t('det.complete')}${next ? ` → ${next.name}` : ''}`} onPress={() => open('transfer')} />
              </>
            ) : null}
            {current.kind === 'qc' ? (
              <Row>
                <Button style={{ flex: 1 }} icon={<ShieldCheck color="#1A1206" size={18} />} title={t('det.qcPass')} onPress={() => open('qc_pass')} />
                <Button style={{ flex: 1 }} variant="danger" icon={<ShieldX color={colors.white} size={18} />} title={t('det.qcFail')} onPress={() => open('qc_fail', { target: earlier[earlier.length - 1]?.id ?? '' })} />
              </Row>
            ) : null}
            {current.kind === 'ready' || current.kind === 'delivered' ? (
              <Button icon={<Truck color="#1A1206" size={18} />} title={t('det.deliver')} onPress={() => open('deliver', { method: 'pickup', recipient: c.doctor?.full_name ?? '' })} />
            ) : null}
          </View>
        ) : null}
        {current && !closed && !data.canAct && canClaim ? (
          <Button style={{ marginTop: 14 }} variant="outline" title={t('det.claim')} loading={busy} onPress={() => run(rpc('assign_stage', { p_stage_id: current.id, p_employee_id: me!.id }))} />
        ) : null}
        {current && !closed && can('workflow.assign') ? (
          <Button style={{ marginTop: 10 }} variant="dark" small icon={<UserCog color={colors.gold} size={16} />} title={t('det.assign')} onPress={() => open('assign', { employee: current.assigned_employee_id ?? '' })} />
        ) : null}
      </Card>

      {/* Stage table */}
      <Card>
        <SectionTitle icon={<ArrowRightLeft color={colors.gold} size={20} />}>{t('set.stages')}</SectionTitle>
        {data.stages.map((s: Stage) => (
          <View key={s.id} style={[styles.stageRow, s.id === c.current_stage_id && styles.stageRowOn]}>
            <View style={{ flex: 1 }}>
              <Row gap={6}>
                <Text style={styles.stageName}>{s.name}</Text>
                <Badge label={tx('stage', s.status)} color={statusColor[s.status] ?? colors.gold} />
                {s.revision_count ? <Badge label={t('det.revisions', { n: s.revision_count })} color={colors.error} /> : null}
              </Row>
              <Text style={styles.muted}>
                {depName(s.department_id)} · {s.assigned_employee_id ? empName[s.assigned_employee_id] : t('case.unassigned')}
              </Text>
              <Text style={styles.small}>
                {t('det.started')}: {s.started_at ? fmtDate(s.started_at, locale, true) : t('det.notStarted')}
                {s.completed_at ? `  ·  ${t('det.finished')}: ${fmtDate(s.completed_at, locale, true)}` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.small}>{t('det.duration')}</Text>
              <StageDuration s={s} />
            </View>
          </View>
        ))}
      </Card>

      {/* Technical information */}
      <Card>
        <SectionTitle icon={<ToothIcon size={22} />}>{t('det.technical')}</SectionTitle>
        <ToothChart value={chart} readOnly />
        <Row style={{ flexWrap: 'wrap', marginTop: 10 }} gap={6}>
          {data.teeth.map((tt) => (
            <Badge
              key={tt.id}
              label={`${tt.tooth_number}${tt.is_missing ? ` · ${t('det.missing')}` : ''}${tt.is_implant ? ` · ${t('det.implant')}` : ''}${tt.bridge_group ? ` · ${t('det.bridge')} ${tt.bridge_group}` : ''}`}
              color={tt.is_implant ? colors.goldHi : tt.is_missing ? colors.muted : colors.gold}
            />
          ))}
        </Row>
        {data.restorations.map((r) => (
          <View key={r.id} style={styles.techBox}>
            <Text style={styles.techTitle}>
              {r.restoration_type?.name} — {data.teeth.filter((tt) => tt.restoration_id === r.id).map((tt) => tt.tooth_number).join(', ')}
            </Text>
            {[
              [t('wiz.material'), r.material?.name], [t('wiz.materialBrand'), r.material_brand], [t('wiz.materialType'), r.material_type],
              [t('case.shade'), r.shade], [t('wiz.thickness'), r.thickness], [t('wiz.translucency'), r.translucency],
              [t('wiz.blockRef'), r.block_reference], [t('wiz.lot'), r.lot_number], [t('wiz.mfgNotes'), r.manufacturing_notes], [t('c.notes'), r.notes],
            ].filter(([, v]) => v).map(([k, v]) => (
              <Row key={k as string} style={{ paddingVertical: 2 }}>
                <Text style={[styles.muted, { width: 130 }]}>{k}</Text>
                <Text style={[styles.body, { flex: 1 }]}>{v}</Text>
              </Row>
            ))}
          </View>
        ))}
        {data.implants.map((im) => (
          <View key={im.id} style={styles.techBox}>
            <Row>
              <ImplantIcon size={18} />
              <Text style={styles.techTitle}>
                {t('det.implant')} · {im.tooth_number}
              </Text>
            </Row>
            {[
              [t('wiz.implantBrand'), im.brand_name], [t('wiz.implantSystem'), im.system_name], [t('wiz.connection'), im.connection], [t('wiz.platform'), im.platform],
              [t('wiz.diameter'), im.diameter_mm], [t('wiz.length'), im.length_mm], [t('wiz.scanbodyMfr'), im.scanbody_manufacturer], [t('wiz.scanbodyRef'), im.scanbody_reference],
              [t('wiz.tibase'), im.tibase_type], [t('wiz.screwChannel'), im.screw_channel ? `${t(`wiz.${im.screw_channel}`)}${im.angulation_degrees ? ` ${im.angulation_degrees}°` : ''}` : null],
              [t('wiz.libraryRef'), im.library_reference], [t('wiz.techNotes'), im.notes],
            ].filter(([, v]) => v != null && v !== '').map(([k, v]) => (
              <Row key={k as string} style={{ paddingVertical: 2 }}>
                <Text style={[styles.muted, { width: 130 }]}>{k}</Text>
                <Text style={[styles.body, { flex: 1 }]}>{String(v)}</Text>
              </Row>
            ))}
          </View>
        ))}
        {can('cases.edit') && !closed ? (
          <Button style={{ marginTop: 12 }} variant="outline" small icon={<Pencil color={colors.gold} size={16} />} title={t('det.edit')} onPress={() => router.push(`/case/edit/${c.id}`)} />
        ) : null}
      </Card>

      {/* Attachments */}
      <Card>
        <SectionTitle
          icon={<FileText color={colors.gold} size={20} />}
          right={!closed ? <Button small variant="outline" icon={<Upload color={colors.gold} size={16} />} title={uploading ?? t('det.uploadHere')} loading={!!uploading} onPress={uploadFiles} /> : null}
        >
          {t('det.attachments')} ({data.attachments.length})
        </SectionTitle>
        {data.attachments.length === 0 ? <EmptyState title={t('c.empty')} /> : null}
        {data.attachments.map((a) => (
          <Row key={a.id} style={styles.fileRow}>
            <FileText color={colors.gold} size={22} />
            <View style={{ flex: 1 }}>
              <Text style={styles.body} numberOfLines={1}>
                {a.file_name}
              </Text>
              <Text style={styles.small}>
                {tx('cat', a.category)} · {fmtSize(a.size_bytes)} · {a.uploaded_by ? empName[a.uploaded_by] : '—'} · {fmtDate(a.created_at, locale, true)}
              </Text>
            </View>
            <Pressable
              hitSlop={8}
              accessibilityLabel={t('c.download')}
              onPress={() => openCaseFile(a.storage_path, a.file_name).catch((e) => fb.toast(tx('err', errorCode(e)), 'error'))}
            >
              <Download color={colors.gold} size={20} />
            </Pressable>
            {a.uploaded_by === me?.id || can('attachments.delete_any') ? (
              <Pressable
                hitSlop={8}
                accessibilityLabel={t('c.delete')}
                onPress={async () => {
                  if (await fb.confirm({ title: t('det.deleteFile'), message: a.file_name, danger: true, confirmLabel: t('c.delete') })) {
                    run(() => deleteCaseFile(a.storage_path));
                  }
                }}
              >
                <Trash2 color={colors.error} size={20} />
              </Pressable>
            ) : null}
          </Row>
        ))}
      </Card>

      {/* QC + delivery */}
      {data.qc.length || data.delivery ? (
        <Card>
          {data.qc.length ? <SectionTitle icon={<ShieldCheck color={colors.gold} size={20} />}>{t('det.qcHistory')}</SectionTitle> : null}
          {data.qc.map((q) => (
            <View key={q.id} style={styles.techBox}>
              <Row>
                <Badge label={q.result === 'passed' ? t('det.qcPass') : t('det.qcFail')} color={q.result === 'passed' ? colors.success : colors.error} />
                <Text style={styles.small}>
                  {q.inspector_id ? empName[q.inspector_id] : ''} · {fmtDate(q.created_at, locale, true)}
                </Text>
              </Row>
              {q.reason ? <Text style={[styles.body, { marginTop: 6 }]}>{q.reason}</Text> : null}
              {Object.keys(q.checklist ?? {}).length ? (
                <Text style={styles.small}>
                  {Object.entries(q.checklist).map(([k, v]) => `${v ? '✓' : '✗'} ${t(`det.qc.${k}` as 'det.qc.fit')}`).join('   ')}
                </Text>
              ) : null}
            </View>
          ))}
          {data.delivery ? (
            <>
              <SectionTitle icon={<Truck color={colors.gold} size={20} />}>{t('det.delivery')}</SectionTitle>
              <KV label={t('c.date')} value={fmtDate(data.delivery.delivered_at, locale, true)} />
              <KV label={t('det.recipient')} value={data.delivery.recipient_name} />
              <KV label={t('det.method')} value={tx('det.m', data.delivery.method)} />
              {data.delivery.tracking_reference ? <KV label={t('det.tracking')} value={data.delivery.tracking_reference} /> : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* History */}
      <Card>
        <SectionTitle icon={<History color={colors.gold} size={20} />}>{t('det.history')}</SectionTitle>
        <HistoryList events={data.history} employees={empName} stages={stageName} />
        <Row style={{ alignItems: 'flex-end' }}>
          <Field style={{ flex: 1, marginBottom: 0 }} label={t('det.addNote')} placeholder={t('det.notePlaceholder')} value={note} onChangeText={setNote} multiline />
          <Button
            small
            title={t('c.add')}
            disabled={!note.trim()}
            loading={busy}
            onPress={() => run(async () => { unwrap(await supabase.rpc('add_case_note', { p_case_id: c.id, p_note: note, p_stage_id: current?.id ?? null })); setNote(''); })}
          />
        </Row>
      </Card>

      {can('cases.cancel') && !closed ? (
        <Button
          variant="danger"
          icon={<Ban color={colors.white} size={18} />}
          title={t('det.cancelCase')}
          onPress={async () => {
            const reason = await fb.prompt({ title: t('det.cancelCase'), message: c.case_number, danger: true, input: { label: t('det.reason'), required: true, multiline: true } });
            if (reason) run(rpc('cancel_case', { p_case_id: c.id, p_reason: reason }));
          }}
        />
      ) : null}

      {/* --- Action modals --- */}
      <FormModal
        visible={modal === 'transfer'}
        title={t('det.complete')}
        submitLabel={t('det.complete')}
        busy={busy}
        onClose={() => setModal(null)}
        onSubmit={() => run(rpc('complete_and_transfer', { p_stage_id: current!.id, p_notes: form.notes || null, p_next_assignee: form.assignee || null }))}
      >
        {next ? <Text style={styles.body}>{t('det.transferTo', { stage: `${next.name} (${depName(next.department_id)})` })}</Text> : null}
        {next ? (
          <Select
            label={t('det.assign')}
            value={form.assignee || null}
            onChange={(v) => setForm((f) => ({ ...f, assignee: v ?? '' }))}
            allowClear
            placeholder={next.assigned_employee_id ? empName[next.assigned_employee_id] : t('det.anyone')}
            options={nextCandidates.map((e) => ({ value: e.id, label: e.full_name, hint: depName(e.department_id) }))}
          />
        ) : null}
        <Field label={t('c.notes')} value={form.notes ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))} multiline />
      </FormModal>

      <FormModal
        visible={modal === 'return' || modal === 'qc_fail'}
        title={modal === 'qc_fail' ? t('det.qcFail') : t('det.return')}
        submitLabel={t('c.confirm')}
        danger
        busy={busy}
        disabled={!form.reason?.trim() || !form.target}
        onClose={() => setModal(null)}
        onSubmit={() =>
          run(
            modal === 'qc_fail'
              ? rpc('qc_decision', { p_stage_id: current!.id, p_result: 'failed', p_reason: form.reason, p_return_to_stage_id: form.target, p_checklist: checklist })
              : rpc('return_case_to_stage', { p_stage_id: current!.id, p_return_to_stage_id: form.target, p_reason: form.reason }),
          )
        }
      >
        <Text style={styles.label}>{t('det.returnTo')}</Text>
        <Row style={{ flexWrap: 'wrap', marginBottom: 10 }} gap={6}>
          {earlier.map((s) => (
            <Chip key={s.id} label={s.name} selected={form.target === s.id} onPress={() => setForm((f) => ({ ...f, target: s.id }))} />
          ))}
        </Row>
        {modal === 'qc_fail'
          ? QC_ITEMS.map((k) => <Toggle key={k} label={t(`det.qc.${k}`)} value={checklist[k] ?? true} onChange={(v) => setChecklist((cl) => ({ ...cl, [k]: v }))} />)
          : null}
        <Field label={t('det.reason')} required value={form.reason ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, reason: v }))} multiline />
      </FormModal>

      <FormModal
        visible={modal === 'qc_pass'}
        title={t('det.qcPass')}
        submitLabel={t('det.qcPass')}
        busy={busy}
        onClose={() => setModal(null)}
        onSubmit={() =>
          run(rpc('qc_decision', { p_stage_id: current!.id, p_result: 'passed', p_reason: form.notes || null, p_checklist: Object.fromEntries(QC_ITEMS.map((k) => [k, checklist[k] ?? true])) }))
        }
      >
        {QC_ITEMS.map((k) => (
          <Toggle key={k} label={t(`det.qc.${k}`)} value={checklist[k] ?? true} onChange={(v) => setChecklist((cl) => ({ ...cl, [k]: v }))} />
        ))}
        <Field label={t('c.notes')} value={form.notes ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))} multiline />
      </FormModal>

      <FormModal
        visible={modal === 'deliver'}
        title={t('det.deliver')}
        submitLabel={t('det.deliver')}
        busy={busy}
        onClose={() => setModal(null)}
        onSubmit={() => run(rpc('record_delivery', { p_case_id: c.id, p_recipient: form.recipient, p_method: form.method, p_tracking: form.tracking || null, p_notes: form.notes || null }))}
      >
        <Field label={t('det.recipient')} value={form.recipient ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, recipient: v }))} />
        <Text style={styles.label}>{t('det.method')}</Text>
        <Row style={{ flexWrap: 'wrap', marginBottom: 10 }} gap={6}>
          {DELIVERY_METHODS.map((m) => (
            <Chip key={m} label={t(`det.m.${m}`)} selected={form.method === m} onPress={() => setForm((f) => ({ ...f, method: m }))} />
          ))}
        </Row>
        <Field label={t('det.tracking')} value={form.tracking ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, tracking: v }))} />
        <Field label={t('c.notes')} value={form.notes ?? ''} onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))} multiline />
      </FormModal>

      <FormModal
        visible={modal === 'assign'}
        title={`${t('det.assign')} — ${current?.name ?? ''}`}
        submitLabel={t('c.save')}
        busy={busy}
        onClose={() => setModal(null)}
        onSubmit={() => run(rpc('assign_stage', { p_stage_id: current!.id, p_employee_id: form.employee || null }))}
      >
        <Select
          label={t('case.responsible')}
          value={form.employee || null}
          onChange={(v) => setForm((f) => ({ ...f, employee: v ?? '' }))}
          allowClear
          placeholder={t('case.unassigned')}
          options={data.employees.filter((e) => e.status === 'active').map((e) => ({ value: e.id, label: e.full_name, hint: depName(e.department_id) }))}
        />
      </FormModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  caseNoPill: { borderWidth: 1, borderColor: colors.gold, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
  caseNo: { color: colors.gold, fontWeight: '800', fontSize: 15, writingDirection: 'ltr' },
  thumb: { width: 110, height: 110, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  workType: { color: colors.white, fontSize: 15, fontWeight: '600', flex: 1 },
  muted: { color: colors.muted, fontSize: 13 },
  small: { color: colors.muted, fontSize: 12 },
  body: { color: colors.text, fontSize: 14 },
  gold: { color: colors.gold, fontWeight: '700' },
  label: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  respBox: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, borderWidth: 1.5, borderColor: colors.gold, borderRadius: radius.lg, padding: 14, backgroundColor: 'rgba(214,173,85,0.06)' },
  respName: { color: colors.white, fontSize: 16, fontWeight: '800', marginTop: 2 },
  respTime: { color: colors.white, fontSize: 16, fontWeight: '800', marginTop: 2 },
  stageRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  stageRowOn: { backgroundColor: 'rgba(214,173,85,0.07)', borderRadius: radius.sm, paddingHorizontal: 6 },
  stageName: { color: colors.white, fontWeight: '700', fontSize: 15 },
  techBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, marginTop: 10 },
  techTitle: { color: colors.gold, fontWeight: '800', fontSize: 15, marginBottom: 6 },
  fileRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 },
});
