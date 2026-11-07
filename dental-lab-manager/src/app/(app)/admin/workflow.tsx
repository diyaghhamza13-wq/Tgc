import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFeedback } from '../../../components/feedback';
import { Select } from '../../../components/pickers';
import { Button, Card, Chip, ErrorBanner, Field, Loading, Row, Screen } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n';
import { fetchDepartments, fetchEmployees } from '../../../lib/queries';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import type { StageKind } from '../../../lib/types';
import { useAsync } from '../../../lib/useAsync';

type S = { key: string; name: string; kind: StageKind; department_id: string | null; default_assignee_id: string | null; expected_hours: string };
const KINDS: StageKind[] = ['reception', 'production', 'qc', 'ready', 'delivered'];
let k = 0;

/** Configure the default production workflow (validated server-side). */
export default function Workflow() {
  const { t, tx } = useI18n();
  const fb = useFeedback();
  const { data, error, reload } = useAsync(async () => {
    const tpl = unwrap(await supabase.from('workflow_templates').select('*').eq('is_default', true).maybeSingle()) as { id: string; name: string } | null;
    const stages = tpl ? (unwrap(await supabase.from('workflow_stages').select('*').eq('template_id', tpl.id).order('position')) as (Omit<S, 'key' | 'expected_hours'> & { expected_hours: number | null })[]) : [];
    const [departments, employees] = await Promise.all([fetchDepartments(), fetchEmployees()]);
    return { tpl, stages, departments, employees };
  });
  const [name, setName] = useState('');
  const [stages, setStages] = useState<S[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data?.tpl) return;
    setName(data.tpl.name);
    setStages(data.stages.map((s) => ({ key: `s${++k}`, name: s.name, kind: s.kind, department_id: s.department_id, default_assignee_id: s.default_assignee_id, expected_hours: s.expected_hours == null ? '' : String(s.expected_hours) })));
  }, [data]);
  if (!data) return <Screen back title={t('set.workflow')}>{error ? <ErrorBanner code={error} onRetry={reload} /> : <Loading />}</Screen>;
  if (!data.tpl) return <Screen back title={t('set.workflow')}><ErrorBanner code="workflow_not_configured" /></Screen>;

  const set = (key: string, patch: Partial<S>) => setStages((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => setStages((ss) => { const n = [...ss]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const save = async () => {
    setBusy(true);
    try {
      unwrap(await supabase.rpc('save_workflow_template', { p_template_id: data.tpl!.id, p_name: name, p_stages: stages.map(({ key: _k, ...s }) => s) }));
      fb.toast(t('c.saved'));
      reload();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('set.workflow')}>
      <Text style={{ color: colors.warning }}>{t('set.workflowNote')}</Text>
      <Field label={t('c.name')} value={name} onChangeText={setName} />
      {stages.map((s, i) => (
        <Card key={s.key}>
          <Row style={{ marginBottom: 8 }}>
            <Text style={{ color: colors.gold, fontWeight: '800', fontSize: 18 }}>{i + 1}</Text>
            <View style={{ flex: 1 }} />
            <Pressable disabled={i === 0} onPress={() => move(i, -1)} hitSlop={6} accessibilityLabel="up"><ArrowUp color={i === 0 ? colors.faint : colors.gold} size={20} /></Pressable>
            <Pressable disabled={i === stages.length - 1} onPress={() => move(i, 1)} hitSlop={6} accessibilityLabel="down"><ArrowDown color={i === stages.length - 1 ? colors.faint : colors.gold} size={20} /></Pressable>
            <Pressable onPress={() => setStages((ss) => ss.filter((x) => x.key !== s.key))} hitSlop={6} accessibilityLabel={t('c.delete')}><Trash2 color={colors.error} size={20} /></Pressable>
          </Row>
          <Field label={t('set.stageName')} required value={s.name} onChangeText={(v) => set(s.key, { name: v })} />
          <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 6 }}>{t('set.kind')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {KINDS.map((kd) => <Chip key={kd} label={tx('kind', kd)} selected={s.kind === kd} onPress={() => set(s.key, { kind: kd })} />)}
          </View>
          <Select label={t('set.department')} value={s.department_id} allowClear onChange={(v) => set(s.key, { department_id: v, default_assignee_id: null })} options={data.departments.map((d) => ({ value: d.id, label: d.name }))} />
          <Select label={t('set.defaultAssignee')} value={s.default_assignee_id} allowClear onChange={(v) => set(s.key, { default_assignee_id: v })} options={data.employees.filter((e) => !s.department_id || e.department_id === s.department_id).map((e) => ({ value: e.id, label: e.full_name }))} />
          <Field label={t('set.expectedHours')} value={s.expected_hours} onChangeText={(v) => set(s.key, { expected_hours: v.replace(/[^0-9.]/g, '') })} keyboardType="decimal-pad" />
        </Card>
      ))}
      <Button variant="outline" icon={<Plus color={colors.gold} size={18} />} title={t('set.addStage')} onPress={() => setStages((ss) => { const idx = ss.findIndex((x) => x.kind === 'qc' || x.kind === 'ready' || x.kind === 'delivered'); const n = [...ss]; n.splice(idx < 0 ? n.length : idx, 0, { key: `s${++k}`, name: '', kind: 'production', department_id: null, default_assignee_id: null, expected_hours: '' }); return n; })} />
      <Button title={t('c.save')} loading={busy} disabled={stages.some((s) => !s.name.trim())} onPress={save} />
    </Screen>
  );
}
